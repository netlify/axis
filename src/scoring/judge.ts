import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { RunResult } from "../types/output.js";

export interface JudgeCallOptions {
  /** Scenario key for the judge run (e.g., "__env_eval__"). */
  scenarioKey: string;
  /** Human-readable name for the judge run. */
  scenarioName: string;
}

/**
 * Call an LLM judge using the same adapter as the test run.
 *
 * Uses the agent's original workspace when available so the judge can
 * independently verify the agent's actual work (files created, endpoints
 * deployed, etc.). Falls back to a disposable temp directory only when
 * no workspace is set (e.g. programmatic API usage without the runner).
 */
export async function callJudge(
  runResult: RunResult,
  prompt: string,
  options: JudgeCallOptions,
): Promise<string> {
  const adapter = getAdapter(runResult.agentConfig.agent);
  const originalWorkspace = runResult.workingDirectory;

  const workspace = originalWorkspace ?? fs.mkdtempSync(path.join(os.tmpdir(), `axis-${options.scenarioKey}-`));
  const shouldCleanup = !originalWorkspace;

  try {
    const output = await adapter.run({
      prompt,
      config: runResult.agentConfig,
      scenario: {
        key: options.scenarioKey,
        name: options.scenarioName,
        prompt,
        rubric: [],
      },
      workingDirectory: workspace,
    });
    return output.result ?? "";
  } finally {
    if (shouldCleanup) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
