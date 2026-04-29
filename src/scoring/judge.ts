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
 * Creates an isolated temp workspace, runs the adapter with a synthetic scenario,
 * and returns the result text.
 */
export async function callJudge(
  runResult: RunResult,
  prompt: string,
  options: JudgeCallOptions,
): Promise<string> {
  const adapter = getAdapter(runResult.agentConfig.adapter);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `axis-${options.scenarioKey}-`));
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
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
