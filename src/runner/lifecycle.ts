import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LifecycleAction } from "../types/scenario.js";

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

export async function executeLifecycleActions(
  actions: LifecycleAction[],
  cwd: string,
  env?: Record<string, string>,
): Promise<LifecycleResult[]> {
  const results: LifecycleResult[] = [];

  for (const action of actions) {
    const result = await runScript(action, cwd, env);
    results.push(result);

    if (result.exitCode !== 0) {
      throw new Error(
        `Lifecycle action failed: "${action.command}" exited with code ${result.exitCode}\n${result.stderr}`,
      );
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
export async function runLifecyclePhase(
  actions: LifecycleAction[],
  cwd: string,
  baseEnv: Record<string, string> | undefined,
  phase: "setup" | "teardown",
  context?: LifecyclePhaseContext,
): Promise<LifecyclePhaseOutcome> {
  const outputFile = path.join(os.tmpdir(), `axis-${phase}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
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
    results = await executeLifecycleActions(actions, cwd, env);
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

function runScript(action: LifecycleAction, cwd: string, env?: Record<string, string>): Promise<LifecycleResult> {
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
