import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globToRegExp, walk } from "./artifacts.js";
import type { Logger } from "../types/output.js";
import type { CopyAction, LifecycleAction, RunScriptAction } from "../types/scenario.js";

/** Default timeout for lifecycle scripts (3 minutes). */
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

/** Max bytes captured from $AXIS_OUTPUT to keep reports small. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface LifecycleResult {
  action: LifecycleAction;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface LifecycleExecOptions {
  /** Base directory for resolving `copy` action source globs. Defaults to `cwd`. */
  sourceRoot?: string;
  /** When true, copy actions log resolved source/destination paths via `logger`. */
  debug?: boolean;
  /** Logger used to emit debug output. Debug messages are dropped when omitted. */
  logger?: Logger;
}

export async function executeLifecycleActions(
  actions: LifecycleAction[],
  cwd: string,
  env?: Record<string, string>,
  options?: LifecycleExecOptions,
): Promise<LifecycleResult[]> {
  const results: LifecycleResult[] = [];

  for (const action of actions) {
    const result = action.action === "copy" ? runCopy(action, cwd, options) : await runScript(action, cwd, env);
    results.push(result);

    if (result.exitCode !== 0) {
      const label = action.action === "copy" ? `copy ${action.match} -> ${action.destination}` : action.command;
      throw new Error(`Lifecycle action failed: "${label}" exited with code ${result.exitCode}\n${result.stderr}`);
    }
  }

  return results;
}

export interface LifecyclePhaseOutcome {
  results: LifecycleResult[];
  /** Markdown content the scripts wrote to $AXIS_OUTPUT. Undefined when nothing was written. */
  output?: string;
  /** Error thrown by `executeLifecycleActions`, if any. Output is still captured. */
  error?: Error;
}

/**
 * Job-level context exposed to lifecycle scripts as `AXIS_*` env vars.
 * Scripts use these to branch on the agent, scenario, or variant under test
 * without needing to encode that information in their command strings.
 */
export interface LifecyclePhaseContext {
  /** Agent name (e.g. "claude-code"). Becomes `AXIS_AGENT`. */
  agent: string;
  /** Model identifier, if the agent was configured with one. Becomes `AXIS_MODEL`. */
  model?: string;
  /** Full scenario key including variant suffix (e.g. "my-scenario@fast"). Becomes `AXIS_SCENARIO`. */
  scenario: string;
  /** Variant name, when the scenario key contains an `@variant` suffix. Becomes `AXIS_VARIANT`. */
  variant?: string;
}

/**
 * Run one lifecycle phase (setup or teardown), exposing an `$AXIS_OUTPUT`
 * file scripts can write markdown notes to. The file is shared across all
 * actions in the phase so multiple scripts can append. Output is captured
 * even when an action fails — partial notes still surface in the report.
 */
export type LifecyclePhase = "setup" | "teardown" | "beforeAll" | "afterAll";

export async function runLifecyclePhase(
  actions: LifecycleAction[],
  cwd: string,
  baseEnv: Record<string, string> | undefined,
  phase: LifecyclePhase,
  context?: LifecyclePhaseContext,
  options?: LifecycleExecOptions,
): Promise<LifecyclePhaseOutcome> {
  const outputFile = path.join(
    os.tmpdir(),
    `axis-${phase}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  // Pre-create empty file so scripts can append even with redirections like `>>`.
  fs.writeFileSync(outputFile, "");

  const env: Record<string, string> = {
    ...(baseEnv ?? {}),
    AXIS_OUTPUT: outputFile,
    AXIS_WORKSPACE: cwd,
    AXIS_PHASE: phase,
  };
  if (context) {
    env.AXIS_AGENT = context.agent;
    env.AXIS_SCENARIO = context.scenario;
    if (context.model) env.AXIS_MODEL = context.model;
    if (context.variant) env.AXIS_VARIANT = context.variant;
  }

  let error: Error | undefined;
  let results: LifecycleResult[] = [];
  try {
    results = await executeLifecycleActions(actions, cwd, env, options);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }

  let output: string | undefined;
  try {
    const stat = fs.statSync(outputFile);
    if (stat.size > 0) {
      const buf =
        stat.size > MAX_OUTPUT_BYTES
          ? fs.readFileSync(outputFile, { encoding: "utf8" }).slice(0, MAX_OUTPUT_BYTES) +
            `\n\n_…truncated at ${MAX_OUTPUT_BYTES} bytes_\n`
          : fs.readFileSync(outputFile, "utf8");
      const trimmed = buf.replace(/\s+$/u, "");
      if (trimmed.length > 0) output = trimmed;
    }
  } catch {
    /* file was deleted by script or never created — no output captured */
  } finally {
    try {
      fs.unlinkSync(outputFile);
    } catch {
      /* best-effort cleanup */
    }
  }

  return { results, ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}) };
}

function runScript(action: RunScriptAction, cwd: string, env?: Record<string, string>): Promise<LifecycleResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(action.command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env && { env }),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to execute "${action.command}": ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Lifecycle action timed out after ${DEFAULT_TIMEOUT_MS / 1000}s: "${action.command}"`));
        return;
      }
      resolve({
        action,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Copy files matching `action.match` (glob, resolved relative to
 * `options.sourceRoot` — defaults to `cwd`) into `action.destination`
 * (resolved relative to `cwd`, the agent workspace). Each match keeps its
 * path relative to the longest non-glob prefix of `match`, so directory
 * structure under that prefix is preserved.
 *
 * In debug mode, the resolved source/destination absolute paths and each
 * per-file copy are logged so authors can verify their patterns.
 */
function runCopy(action: CopyAction, cwd: string, options?: LifecycleExecOptions): LifecycleResult {
  const start = Date.now();
  const sourceRoot = options?.sourceRoot ?? cwd;
  const debugLog = options?.debug ? (msg: string) => options.logger?.info(`[copy] ${msg}`) : undefined;
  const result = (exitCode: number, stderr = ""): LifecycleResult => ({
    action,
    exitCode,
    stdout: "",
    stderr,
    durationMs: Date.now() - start,
  });

  try {
    const normalizedPattern = action.match.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = findGlobBase(normalizedPattern);
    const baseAbs = path.resolve(sourceRoot, base);
    const destAbs = path.resolve(cwd, action.destination);

    debugLog?.(`pattern=${action.match}`);
    debugLog?.(`resolved source base=${baseAbs}`);
    debugLog?.(`resolved destination=${destAbs}`);

    if (!fs.existsSync(baseAbs)) {
      // A literal path that doesn't exist is a hard error — the author named
      // a specific file. A glob whose base is missing is just "zero matches".
      const isLiteral = base === normalizedPattern;
      if (isLiteral) return result(1, `source base does not exist: ${baseAbs}`);
      debugLog?.("no files matched");
      return result(0);
    }

    const matches = collectMatches(baseAbs, normalizedPattern, base);

    if (matches.length === 0) {
      debugLog?.("no files matched");
      return result(0);
    }

    fs.mkdirSync(destAbs, { recursive: true });
    matches.sort((a, b) => a.relFromBase.localeCompare(b.relFromBase));
    for (const m of matches) {
      const dst = path.join(destAbs, m.relFromBase);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(m.src, dst);
      debugLog?.(`${m.src} -> ${dst}`);
    }
    debugLog?.(`copied ${matches.length} file(s)`);

    return result(0);
  } catch (err) {
    return result(1, err instanceof Error ? err.message : String(err));
  }
}

interface CopyMatch {
  src: string;
  /** Path relative to the glob base — preserved under the destination. */
  relFromBase: string;
}

/**
 * Resolve a glob pattern (already normalized, with `base` computed by
 * {@link findGlobBase}) into the set of files it matches under `baseAbs`.
 * When `baseAbs` is a file (literal pattern), that single file is the match.
 * When `base` consumed the entire pattern but points to a directory, all
 * files under it are matched (equivalent to appending `**\/*`).
 */
function collectMatches(baseAbs: string, normalizedPattern: string, base: string): CopyMatch[] {
  if (fs.statSync(baseAbs).isFile()) {
    return [{ src: baseAbs, relFromBase: path.basename(baseAbs) }];
  }
  const patternRelToBase =
    base.length === 0 ? normalizedPattern : normalizedPattern.slice(base.length).replace(/^\//, "");
  const effectivePattern = patternRelToBase.length === 0 ? "**/*" : patternRelToBase;
  const re = globToRegExp(effectivePattern);
  const matches: CopyMatch[] = [];
  walk(baseAbs, "", (relPath) => {
    if (re.test(relPath)) matches.push({ src: path.join(baseAbs, relPath), relFromBase: relPath });
  });
  return matches;
}

/**
 * Longest leading path prefix containing no glob metacharacters. For
 * `fixture/thing/*` this is `fixture/thing`; for `fixture/**\/*.txt` it's
 * `fixture`; for a literal path it's the path itself.
 */
function findGlobBase(normalizedPattern: string): string {
  const segments = normalizedPattern.split("/");
  const baseSegs: string[] = [];
  for (const seg of segments) {
    if (/[*?[]/.test(seg)) break;
    baseSegs.push(seg);
  }
  return baseSegs.join("/");
}
