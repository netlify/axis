import { spawn } from "node:child_process";
import type { LifecycleAction } from "../types/scenario.js";

/** Default timeout for lifecycle scripts (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

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
