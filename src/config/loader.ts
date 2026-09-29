import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { AxisConfig, InlineScenario } from "../types/config.js";
import type { Scenario, ScenarioVariant } from "../types/scenario.js";
import { validateConfig, validateScenario } from "./validator.js";
import { formatError } from "../types/output.js";
import type { Logger, ScenarioLoadFailure } from "../types/output.js";
import { globToRegExp } from "../runner/artifacts.js";
import { expandRemoteScenarios } from "./remote-scenarios.js";

/** Extensions probed when no explicit config path is given, in priority order. */
const DEFAULT_CONFIG_EXTENSIONS = [".ts", ".js", ".mjs", ".json"] as const;
const DEFAULT_CONFIG_BASENAME = "axis.config";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export async function loadConfig(configPath?: string): Promise<{ config: AxisConfig; configDir: string }> {
  const resolvedPath = await resolveConfigPath(configPath);
  const ext = path.extname(resolvedPath).toLowerCase();

  let parsed: unknown;
  if (ext === ".json" || ext === "") {
    parsed = await loadJsonConfig(resolvedPath);
  } else if (JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext)) {
    parsed = await loadModuleConfig(resolvedPath);
  } else {
    throw new Error(`Unsupported config file extension "${ext}" at ${resolvedPath}`);
  }

  // Support a default export that is either the config object or a (sync/async) function returning it.
  if (typeof parsed === "function") {
    parsed = await (parsed as () => unknown | Promise<unknown>)();
  }

  validateConfig(parsed, resolvedPath);
  normalizeConfigAgents(parsed);
  normalizeJudging(parsed);

  // Default the scenarios source when omitted; downstream code can assume it is set.
  if (parsed.scenarios === undefined) {
    parsed.scenarios = "./scenarios";
  }

  return {
    config: parsed,
    configDir: path.dirname(resolvedPath),
  };
}

async function resolveConfigPath(configPath: string | undefined): Promise<string> {
  if (configPath) {
    return path.resolve(configPath);
  }

  for (const ext of DEFAULT_CONFIG_EXTENSIONS) {
    const candidate = path.resolve(`${DEFAULT_CONFIG_BASENAME}${ext}`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  // Nothing found — fall back to .json so the existing "Could not read" error fires with the expected path.
  return path.resolve(`${DEFAULT_CONFIG_BASENAME}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function loadJsonConfig(resolvedPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read config file at ${resolvedPath}: ${formatError(err)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in ${resolvedPath}`);
  }
}

async function loadModuleConfig(resolvedPath: string): Promise<unknown> {
  if (!(await fileExists(resolvedPath))) {
    throw new Error(`Could not read config file at ${resolvedPath}: file not found`);
  }

  let mod: { default?: unknown };
  try {
    mod = await importModule(resolvedPath);
  } catch (err) {
    throw new Error(`Failed to load config at ${resolvedPath}: ${formatError(err)}`);
  }

  if (!mod || typeof mod !== "object" || !("default" in mod) || mod.default === undefined) {
    throw new Error(`Config at ${resolvedPath} must have a default export`);
  }
  return mod.default;
}

/**
 * Imports a JS or TS file by extension. Native dynamic import for `.js`/`.mjs`/`.cjs`,
 * jiti for `.ts`/`.mts`/`.cts`. Returns the module namespace; callers extract `default`.
 */
async function importModule(filePath: string): Promise<{ default?: unknown }> {
  const ext = path.extname(filePath).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) {
    return (await import(pathToFileURL(filePath).href)) as { default?: unknown };
  }
  if (TS_EXTENSIONS.has(ext)) {
    const jiti = createJiti(import.meta.url, { interopDefault: false });
    return (await jiti.import(filePath)) as { default?: unknown };
  }
  throw new Error(`Unsupported module extension "${ext}" at ${filePath}`);
}

/**
 * Normalize `judging.agents` so downstream code can rely on every entry being
 * a full {@link AgentConfig} with a lowercase adapter name.
 */
function normalizeJudging(config: AxisConfig): void {
  if (!config.judging) return;
  config.judging.agents = config.judging.agents.map((entry) => {
    if (typeof entry === "string") {
      return { agent: entry.toLowerCase() };
    }
    entry.agent = entry.agent.toLowerCase();
    return entry;
  });
}

/** Lowercase all agent names in a validated config (mutates in place). */
function normalizeConfigAgents(config: AxisConfig): void {
  for (let i = 0; i < config.agents.length; i++) {
    const entry = config.agents[i];
    if (typeof entry === "string") {
      config.agents[i] = entry.toLowerCase();
    } else {
      entry.agent = entry.agent.toLowerCase();
    }
  }
}

export interface DiscoverScenariosOptions {
  /** Logger for remote clone/pull progress. Defaults to silent. */
  logger?: Logger;
  /** How many levels of remote-to-remote references to follow. Defaults to 1. */
  maxRemotesDepth?: number;
  /**
   * Called once per file that was meant to load as a scenario but could not
   * (unparseable JSON, a module that throws on import). The walk continues so
   * one bad file can't strand a whole run; callers surface these and fail the
   * exit code so the missing scenarios don't pass unnoticed.
   */
  onLoadFailure?: (failure: ScenarioLoadFailure) => void;
}

/** Reporting channels threaded through the scenarios walk. */
interface WalkContext {
  logger?: Logger;
  onLoadFailure?: (failure: ScenarioLoadFailure) => void;
}

export async function discoverScenarios(
  configDir: string,
  scenariosInput: string | (string | InlineScenario)[] | undefined,
  filter?: string[],
  options?: DiscoverScenariosOptions,
): Promise<Scenario[]> {
  // When omitted, fall back to the default scenarios directory.
  const resolvedInput = scenariosInput ?? "./scenarios";
  // Expand any remote URL entries (clone the repos, inline their scenarios as
  // absolute paths). Non-URL entries pass through unchanged.
  const expanded = await expandRemoteScenarios(resolvedInput, {
    configDir,
    logger: options?.logger,
    maxDepth: options?.maxRemotesDepth,
  });
  const entries = Array.isArray(expanded) ? expanded : [expanded ?? "./scenarios"];
  const scenarios: Scenario[] = [];
  const ctx: WalkContext = { logger: options?.logger, onLoadFailure: options?.onLoadFailure };

  for (const entry of entries) {
    if (typeof entry === "string") {
      await collectFromPath(path.resolve(configDir, entry), scenarios, ctx);
    } else {
      // Inline scenarios are validated by validateConfig; here we just normalize and expand.
      scenarios.push(...expandInline(entry));
    }
  }

  // Check for duplicate keys (can happen when variant keys collide with other scenario keys
  // or when inline keys collide with on-disk keys)
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.key)) {
      throw new Error(`Duplicate scenario key "${s.key}". Ensure variant names do not collide with other scenarios.`);
    }
    seen.add(s.key);
  }

  // Sort by key for deterministic ordering
  scenarios.sort((a, b) => a.key.localeCompare(b.key));

  // Filter scenarios if agent specifies a subset
  if (filter && !filter.includes("*")) {
    return scenarios.filter((s) => matchesScenarioFilter(s.key, filter));
  }

  return scenarios;
}

/** File extensions recognized by the scenarios walker. */
const SCENARIO_EXTENSIONS = new Set([".json", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const SCENARIO_EXT_RE = /\.(json|js|mjs|cjs|ts|mts|cts)$/;

async function collectFromPath(absolutePath: string, scenarios: Scenario[], ctx: WalkContext): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    throw new Error(`Could not read scenarios path at ${absolutePath}: ${formatError(err)}`);
  }

  if (stat.isDirectory()) {
    await walkDir(absolutePath, absolutePath, scenarios, ctx);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Scenarios path must be a directory or scenario file: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SCENARIO_EXTENSIONS.has(ext)) {
    throw new Error(`Scenario file must end in one of ${[...SCENARIO_EXTENSIONS].join(", ")}: ${absolutePath}`);
  }
  // Single-file entry is explicit, so missing default exports are an error (not silent skip).
  const baseKey = path.basename(absolutePath, ext);
  const loaded = await loadScenarioFromPath(absolutePath, baseKey, false, ctx);
  if (loaded) scenarios.push(...loaded);
}

/**
 * Directory names skipped when walking the scenarios tree.
 *
 * `fixtures` / `scenario-fixtures` are the supported opt-out: anything a
 * scenario needs but that is not itself a scenario (starter codebases, sample
 * data, framework configs) goes in one of these and the walker never looks
 * inside. That opt-out is what lets discovery treat every other file in the
 * tree as an intended scenario and complain when one is malformed, instead of
 * quietly dropping it.
 */
const WALK_SKIP_DIRS = new Set(["node_modules", "fixtures", "scenario-fixtures"]);

/** An AXIS config nested in the scenarios tree is never itself a scenario. */
const CONFIG_BASENAME_RE = /^axis\.config\./;

async function walkDir(dir: string, rootDir: string, scenarios: Scenario[], ctx: WalkContext): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip dotfile directories (`.git`, `.netlify`, `.next`, …) and known
      // non-source dirs so we don't crawl into tool state or vendored code
      // when a scenario directory contains fixture codebases.
      if (entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name)) continue;
      await walkDir(fullPath, rootDir, scenarios, ctx);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!SCENARIO_EXTENSIONS.has(ext)) continue;
    if (CONFIG_BASENAME_RE.test(entry.name)) continue;

    // Derive key from path relative to the walk root: scenarios/cms/create-post.ts → "cms/create-post"
    const baseKey = path.relative(rootDir, fullPath).replace(SCENARIO_EXT_RE, "").split(path.sep).join("/");
    // Walking a directory: files that clearly aren't scenarios (helper modules,
    // stray data) are skipped quietly so authors can keep them alongside real
    // scenarios. Files that look like unfinished scenarios throw, and files too
    // broken to classify are reported through `onLoadFailure`.
    const loaded = await loadScenarioFromPath(fullPath, baseKey, true, ctx);
    if (loaded) scenarios.push(...loaded);
  }
}

/**
 * Loads a single scenario from disk, dispatching by extension.
 *
 * @param silentSkip  When true, files that don't look like a scenario return
 *                    null instead of throwing — JS/TS modules without a default
 *                    object export, JSON files with no scenario-identifying
 *                    fields. Used when walking a directory so fixture data and
 *                    helper modules can coexist with real scenario files.
 */
async function loadScenarioFromPath(
  filePath: string,
  baseKey: string,
  silentSkip: boolean,
  ctx: WalkContext,
): Promise<Scenario[] | null> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return loadJsonScenario(filePath, baseKey, silentSkip, ctx);
  }

  if (JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext)) {
    return loadModuleScenario(filePath, baseKey, silentSkip, ctx);
  }

  if (silentSkip) return null;
  throw new Error(`Unsupported scenario file extension "${ext}" at ${filePath}`);
}

/**
 * Top-level fields that, if present in a JSON file, signal "this is intended to
 * be a scenario." `prompt` and `judge` are AXIS-specific enough that no common
 * non-scenario JSON (package.json, tsconfig.json, lockfiles, framework state)
 * uses them. When walking a directory and neither appears, the JSON is some
 * other artifact and we skip it silently instead of treating it as a malformed
 * scenario. `name` is intentionally excluded — package.json has it. `rubric`
 * remains a marker for back-compat with legacy scenarios.
 */
const SCENARIO_MARKER_FIELDS = ["prompt", "judge", "rubric"] as const;

/**
 * Fields only an AXIS scenario carries. A walked file with one of these but no
 * marker field is a scenario someone left unfinished, not a fixture: the
 * marker heuristic would drop it without a word, and the run would quietly
 * cover fewer scenarios while still reporting a clean result. So it throws
 * instead. Files that genuinely aren't scenarios have none of these, and
 * anything ambiguous belongs in a `fixtures/` directory.
 */
const SCENARIO_INTENT_FIELDS = [
  "variants",
  "setup",
  "teardown",
  "limits",
  "skip",
  "agents",
  "skills",
  "mcp_servers",
  "artifacts",
] as const;

async function loadJsonScenario(
  filePath: string,
  baseKey: string,
  silentSkip: boolean,
  ctx: WalkContext,
): Promise<Scenario[] | null> {
  const raw = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (silentSkip) {
      // Can't read the file at all, so we can't tell a broken scenario from
      // unrelated data. Report it rather than guess: a JSON file in the
      // scenarios tree that won't parse is worth a look either way.
      reportLoadFailure(ctx, filePath, "file is not valid JSON");
      return null;
    }
    throw new Error(`Failed to parse JSON in scenario file ${filePath}`);
  }

  if (silentSkip && !looksLikeScenario(parsed)) {
    assertNotUnfinishedScenario(parsed, filePath);
    skipQuietly(ctx, filePath, `no ${SCENARIO_MARKER_FIELDS.map((f) => `"${f}"`).join(" / ")} field`);
    return null;
  }

  return finalizeScenarioObject(parsed, filePath, baseKey);
}

function looksLikeScenario(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  return SCENARIO_MARKER_FIELDS.some((field) => field in obj);
}

/**
 * Throws when a walked file carries scenario-only fields but no marker field,
 * i.e. it was meant to be a scenario and is missing the required `prompt` and
 * `judge`. Returns normally when the file is plausibly something else.
 */
function assertNotUnfinishedScenario(parsed: unknown, filePath: string): void {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;
  const present = SCENARIO_INTENT_FIELDS.filter((field) => field in obj);
  if (present.length === 0) return;

  throw new Error(
    `Invalid scenario at ${filePath}: has scenario ${present.length > 1 ? "fields" : "field"} ` +
      `${present.map((f) => `"${f}"`).join(", ")} but is missing the required "prompt" and "judge" fields. ` +
      `Add them, or move this file into a "fixtures" directory if it is not a scenario.`,
  );
}

/** Note a file the walk passed over on purpose. Visible under `--verbose` only. */
function skipQuietly(ctx: WalkContext, filePath: string, reason: string): void {
  ctx.logger?.verbose?.(`Not a scenario, skipped ${filePath}: ${reason}`);
}

/** Record a file that should have loaded but couldn't, and warn about it now. */
function reportLoadFailure(ctx: WalkContext, filePath: string, reason: string): void {
  ctx.logger?.error(`Failed to load scenario ${filePath}: ${reason}`);
  ctx.onLoadFailure?.({ path: filePath, reason });
}

async function loadModuleScenario(
  filePath: string,
  baseKey: string,
  silentSkip: boolean,
  ctx: WalkContext,
): Promise<Scenario[] | null> {
  let mod: { default?: unknown };
  try {
    mod = await importModule(filePath);
  } catch (err) {
    if (silentSkip) {
      // Failed imports during a walk are usually missing dependencies (e.g.
      // remote repos whose deps haven't been installed) or a syntax error in
      // an otherwise-real scenario. Either way the module might have been a
      // scenario, so record it as a load failure instead of halting the walk.
      reportLoadFailure(ctx, filePath, formatError(err));
      return null;
    }
    throw new Error(`Failed to load scenario module at ${filePath}: ${formatError(err)}`);
  }

  let def: unknown = mod && typeof mod === "object" ? mod.default : undefined;
  if (typeof def === "function") {
    def = await (def as () => unknown | Promise<unknown>)();
  }

  if (def === undefined || def === null || typeof def !== "object" || Array.isArray(def)) {
    if (silentSkip) {
      // Helper modules that export named utilities (shared variants, builders)
      // live in the scenarios tree by design and have no default export.
      skipQuietly(ctx, filePath, "no default object export");
      return null;
    }
    throw new Error(`Scenario module at ${filePath} must default-export an object (or function returning one)`);
  }

  // Modules that default-export something other than a scenario (framework
  // configs, data builders) are skipped when walking; an unfinished scenario
  // throws. Files explicitly named on the command line / config always
  // surface a real validation error.
  if (silentSkip && !looksLikeScenario(def)) {
    assertNotUnfinishedScenario(def, filePath);
    skipQuietly(ctx, filePath, `no ${SCENARIO_MARKER_FIELDS.map((f) => `"${f}"`).join(" / ")} field`);
    return null;
  }

  return finalizeScenarioObject(def, filePath, baseKey);
}

function finalizeScenarioObject(parsed: unknown, filePath: string, baseKey: string): Scenario[] {
  validateScenario(parsed, filePath, "file");
  normalizeScenarioAgents(parsed);

  const scenario = parsed as Scenario & { variants?: ScenarioVariant[] };

  // If the file declares a key, it must match the key derived from its path.
  // The path-derived key is always authoritative; this surfaces drift after a rename.
  if (scenario.key !== undefined && scenario.key !== baseKey) {
    throw new Error(
      `Scenario at ${filePath}: declared key "${scenario.key}" does not match path-derived key "${baseKey}". ` +
        `Either remove the "key" field or set it to "${baseKey}".`,
    );
  }

  if (!scenario.variants || scenario.variants.length === 0) {
    scenario.key = baseKey;
    return [scenario];
  }

  // Expand variants: each becomes a standalone Scenario, base does not run
  return scenario.variants.map((variant) => expandVariant(scenario, variant, baseKey));
}

function expandInline(input: InlineScenario): Scenario[] {
  // Shallow clone so we don't mutate the caller's config object.
  const scenario = { ...input } as Scenario & { variants?: ScenarioVariant[] };
  normalizeScenarioAgents(scenario);

  if (!scenario.variants || scenario.variants.length === 0) {
    return [scenario];
  }

  return scenario.variants.map((variant) => expandVariant(scenario, variant, scenario.key));
}

/** Lowercase agent-name entries in a scenario and any variants (mutates in place). */
function normalizeScenarioAgents(scenario: Scenario & { variants?: ScenarioVariant[] }): void {
  if (scenario.agents) {
    scenario.agents = scenario.agents.map((a) => a.toLowerCase());
  }
  if (scenario.variants) {
    for (const v of scenario.variants) {
      if (v.agents) v.agents = v.agents.map((a) => a.toLowerCase());
    }
  }
}

function expandVariant(parent: Scenario, variant: ScenarioVariant, baseKey: string): Scenario {
  const expanded: Scenario = {
    key: `${baseKey}@${variant.name}`,
    name: `${parent.name} [${variant.name}]`,
    prompt: variant.prompt ?? parent.prompt,
    judge: variant.judge ?? parent.judge,
    skip: variant.skip ?? parent.skip,
    setup: variant.setup ?? parent.setup,
    teardown: variant.teardown ?? parent.teardown,
    agents: variant.agents ?? parent.agents,
    skills: variant.skills !== undefined ? variant.skills : parent.skills,
    mcp_servers:
      variant.mcp_servers !== undefined ? { ...parent.mcp_servers, ...variant.mcp_servers } : parent.mcp_servers,
    limits: variant.limits ?? parent.limits,
    artifacts: variant.artifacts !== undefined ? variant.artifacts : parent.artifacts,
  };

  // Strip undefined optional fields to keep objects clean
  if (expanded.skip === undefined) delete expanded.skip;
  if (expanded.setup === undefined) delete expanded.setup;
  if (expanded.teardown === undefined) delete expanded.teardown;
  if (expanded.agents === undefined) delete expanded.agents;
  if (expanded.skills === undefined) delete expanded.skills;
  if (expanded.mcp_servers === undefined) delete expanded.mcp_servers;
  if (expanded.limits === undefined) delete expanded.limits;
  if (expanded.artifacts === undefined) delete expanded.artifacts;

  return expanded;
}

/** True if the pattern contains any glob metacharacter (`*`, `?`, `[`). */
function isGlobPattern(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * Match a scenario key against a list of filter patterns. A pattern matches if:
 *   - it equals the full key (e.g. `cms/create-post@variant`)
 *   - it equals the base key (e.g. `cms/create-post`, matches all variants)
 *   - it is a glob and matches either the full key or the base key
 *
 * Supported glob syntax (via {@link globToRegExp}): `**`, `*`, `?`, `[abc]`.
 */
export function matchesScenarioFilter(key: string, filter: string[]): boolean {
  const baseKey = key.includes("@") ? key.split("@")[0] : key;

  return filter.some((pattern) => {
    if (pattern === key) return true;
    if (pattern === baseKey) return true;
    if (isGlobPattern(pattern)) {
      const re = globToRegExp(pattern);
      return re.test(key) || re.test(baseKey);
    }
    return false;
  });
}

/**
 * Match an agent name against a list of filter patterns. A pattern matches if:
 *   - it equals the full agent name (e.g. `claude-code|opus`)
 *   - it equals the base agent (e.g. `claude-code`, matches all model variants)
 *   - it is a glob and matches either the full name or the base agent
 */
export function matchesAgentFilter(agentName: string, filter: string[]): boolean {
  const baseAgent = agentName.includes("|") ? agentName.split("|")[0] : agentName;

  return filter.some((pattern) => {
    if (pattern === agentName) return true;
    if (pattern === baseAgent) return true;
    if (isGlobPattern(pattern)) {
      const re = globToRegExp(pattern);
      return re.test(agentName) || re.test(baseAgent);
    }
    return false;
  });
}
