import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineScenario, JudgeCriterion, LifecycleAction } from "../../../src/types/index.js";

export const VERTICALS = [
  "content",
  "table-stakes",
  "input-handling",
  "imagery",
  "functional",
  "js-errors",
  "mobile",
  "accessibility",
  "visual",
] as const;
export type Vertical = (typeof VERTICALS)[number];
export type Metric = "recall" | "precision" | "pass";

/** A precision audit: the judge lists every matching item and labels it supported / placeholder / unsupported. */
export interface Audit {
  vertical: Vertical;
  items: string;
  supported: string;
  unsupported: string;
}

export interface Rubric {
  /** Items that must be present. Recall = present / listed. */
  recall?: Partial<Record<Vertical, string[]>>;
  /** Audit ids from `rubric/audits.json`, or inline audits. */
  precision?: (string | Audit)[];
  /** PASS/FAIL checks. Pass rate = passed / listed. */
  pass?: Partial<Record<Vertical, string[]>>;
}

export interface Spec {
  name: string;
  /** Note for humans reading the spec; not sent to the agent or judge. */
  about?: string;
  /** Picks the table-stakes checklist from `rubric/site-types.json`. */
  site_type?: string;
  /** Lines are joined with spaces. */
  prompt: string | string[];
  /** Simulated option-picker selections, appended to the prompt. */
  picker?: { question: string; answer: string }[];
  setup?: LifecycleAction[];
  teardown?: LifecycleAction[];
  rubric: Rubric;
}

interface Library {
  core: Rubric;
  siteTypes: Record<string, Rubric>;
  audits: Record<string, Audit>;
}

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every check is tagged `[vertical:metric]` so `lib/metrics.ts` can pull the
 * grades back out of a report and compute recall, precision, and pass rate.
 */
export const TAG_RE = /^\[([a-z-]+):(recall|precision|pass)\] /;

export const OUTPUT_CONTRACT =
  "\n\n---\n" +
  "Build the site as static files in `./site/`, with `site/index.html` as the entry point. " +
  "Plain HTML, CSS, and JavaScript only, with no build step, so the site opens directly in a browser. " +
  "Don't ask me follow-up questions. Make reasonable decisions and finish the site.";

/** Script checks (links, script parsing, viewport, lang, h1, alt, declared contrast). See lib/checks.mjs. */
export const SITE_CHECKS: LifecycleAction = {
  action: "run_script",
  command: 'node "$AXIS_CONFIG_DIR/lib/checks.mjs" site site-checks.json || true',
};

const SPEC_KEYS = new Set(["name", "about", "site_type", "prompt", "picker", "setup", "teardown", "rubric"]);
const RUBRIC_KEYS = new Set(["$comment", "recall", "precision", "pass"]);

export function recallCheck(vertical: Vertical, item: string): string {
  return (
    `[${vertical}:recall] PRESENT (10) or MISSING (0), no partial credit. ` +
    `Placeholder values count as present unless this asks for a specific value. The site includes: ${item}`
  );
}

export function passCheck(vertical: Vertical, check: string): string {
  return `[${vertical}:pass] PASS (10) or FAIL (0), no partial credit: ${check}`;
}

export function precisionCheck(audit: Audit): string {
  return (
    `[${audit.vertical}:precision] AUDIT ${audit.items}. List every one on the site and label it ` +
    `SUPPORTED (${audit.supported}), PLACEHOLDER (clearly marked for the owner to fill in, e.g. "[Your phone]"), ` +
    `or UNSUPPORTED (${audit.unsupported}). ` +
    `Start the rationale with exactly "supported=N placeholder=N unsupported=N", then name each unsupported item. ` +
    `Score = round(10 × supported ÷ (supported + unsupported)), or 10 if both are 0.`
  );
}

export function buildPrompt(spec: Spec): string {
  let prompt = Array.isArray(spec.prompt) ? spec.prompt.join(" ") : spec.prompt;
  if (spec.picker?.length) {
    prompt += "\n\nOptions selected:\n" + spec.picker.map((p) => `- ${p.question}: ${p.answer}`).join("\n");
  }
  return prompt + OUTPUT_CONTRACT;
}

/** Scenario-specific checks first, then the site type's table stakes, then the core checks every site gets. */
export function buildJudge(spec: Spec, lib: Library, where: string): JudgeCriterion[] {
  const rubrics: Rubric[] = [spec.rubric];
  if (spec.site_type !== undefined) {
    const siteType = lib.siteTypes[spec.site_type];
    if (!siteType) {
      throw new Error(`${where}: unknown site_type "${spec.site_type}" (see rubric/site-types.json)`);
    }
    rubrics.push(siteType);
  }
  rubrics.push(lib.core);

  const checks: string[] = [];
  for (const rubric of rubrics) {
    for (const [vertical, items] of verticalEntries(rubric.recall, where)) {
      checks.push(...items.map((item) => recallCheck(vertical, item)));
    }
    for (const entry of rubric.precision ?? []) {
      const audit = typeof entry === "string" ? lib.audits[entry] : entry;
      if (!audit) throw new Error(`${where}: unknown precision audit "${entry}" (see rubric/audits.json)`);
      assertVertical(audit.vertical, where);
      checks.push(precisionCheck(audit));
    }
    for (const [vertical, items] of verticalEntries(rubric.pass, where)) {
      checks.push(...items.map((check) => passCheck(vertical, check)));
    }
  }
  // No weights: each item counts once. The AXIS goal score becomes the share of checks met;
  // the per-vertical metrics come from lib/metrics.ts.
  return checks.map((check) => ({ check }));
}

export function compileSpec(spec: Spec, key: string, lib: Library): InlineScenario {
  const where = `specs/${key}.json`;
  for (const k of Object.keys(spec)) {
    if (!SPEC_KEYS.has(k)) throw new Error(`${where}: unknown field "${k}"`);
  }
  if (!spec.name || !spec.prompt || !spec.rubric) {
    throw new Error(`${where}: "name", "prompt", and "rubric" are required`);
  }
  for (const k of Object.keys(spec.rubric)) {
    if (!RUBRIC_KEYS.has(k)) throw new Error(`${where}: unknown rubric field "${k}"`);
  }

  return {
    key,
    name: spec.name,
    prompt: buildPrompt(spec),
    judge: buildJudge(spec, lib, where),
    ...(spec.setup ? { setup: spec.setup } : {}),
    // Teardown runs after the judge and before artifact capture, so the script
    // checks' `site-checks.json` lands in the report without touching scoring.
    teardown: [SITE_CHECKS, ...(spec.teardown ?? [])],
  };
}

export function loadLibrary(root = ROOT): Library {
  return {
    core: readJson(path.join(root, "rubric", "core.json")),
    siteTypes: withoutComment(readJson(path.join(root, "rubric", "site-types.json"))),
    audits: withoutComment(readJson(path.join(root, "rubric", "audits.json"))),
  };
}

/** Compile every `specs/**\/*.json` into an AXIS inline scenario keyed by its path (`hard-input/vague`). */
export function loadSpecs(root = ROOT): InlineScenario[] {
  const lib = loadLibrary(root);
  const specsDir = path.join(root, "specs");
  return walk(specsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const key = path
        .relative(specsDir, file)
        .replace(/\.json$/, "")
        .split(path.sep)
        .join("/");
      return compileSpec(readJson<Spec>(file), key, lib);
    });
}

function verticalEntries(section: Partial<Record<Vertical, string[]>> | undefined, where: string) {
  const entries = Object.entries(section ?? {}) as [Vertical, string[]][];
  for (const [vertical] of entries) assertVertical(vertical, where);
  return entries;
}

function assertVertical(vertical: string, where: string): asserts vertical is Vertical {
  if (!(VERTICALS as readonly string[]).includes(vertical)) {
    throw new Error(`${where}: unknown vertical "${vertical}" (expected one of ${VERTICALS.join(", ")})`);
  }
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

function withoutComment<T>(record: Record<string, T>): Record<string, T> {
  const { $comment: _comment, ...rest } = record;
  return rest;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
