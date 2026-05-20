import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { AgentConfig } from "../types/config.js";
import type { RunResult } from "../types/output.js";

export interface JudgeCallOptions {
  /** Scenario key for the judge run (e.g., "__env_eval__"). */
  scenarioKey: string;
  /** Human-readable name for the judge run. */
  scenarioName: string;
  /**
   * Candidate judge agents in precedence order. When omitted, the judge runs
   * as the same agent that produced the transcript (the agent scores itself).
   * Otherwise see {@link resolveJudgeAgent} for selection rules.
   */
  judging?: AgentConfig[];
}

/**
 * Pick the judge agent for a run from a precedence-ordered list.
 *
 * Prefers the first entry whose adapter name differs from the run's own
 * agent so a fresh perspective evaluates the work. If every entry matches
 * the run's own agent (e.g. a single-agent benchmark), the first entry is
 * still used &mdash; the configuration represents an intent to use a
 * specific judge, even if it happens to coincide with the run's agent.
 */
export function resolveJudgeAgent(runResult: RunResult, judging: AgentConfig[] | undefined): AgentConfig {
  if (!judging || judging.length === 0) return runResult.agentConfig;
  const runAgent = runResult.agentConfig.agent;
  return judging.find((c) => c.agent !== runAgent) ?? judging[0];
}

/**
 * Build a human-readable identifier for a judge agent: `<adapter>|<model>` when
 * a model is pinned, otherwise just `<adapter>`. Mirrors the runtime agent name
 * format produced by `normalizeAgents` in the runner so logs and report text
 * line up.
 */
export function formatJudgeLabel(judging: AgentConfig): string {
  return judging.model ? `${judging.agent}|${judging.model}` : judging.agent;
}

/**
 * Call an LLM judge using either a configured judge agent (when `options.judging`
 * is set) or the same adapter as the test run.
 *
 * Uses the agent's original workspace when available so the judge can
 * independently verify the agent's actual work (files created, endpoints
 * deployed, etc.). Falls back to a disposable temp directory only when
 * no workspace is set (e.g. programmatic API usage without the runner).
 */
export async function callJudge(runResult: RunResult, prompt: string, options: JudgeCallOptions): Promise<string> {
  const judgeConfig = resolveJudgeAgent(runResult, options.judging);
  const adapter = getAdapter(judgeConfig.agent);
  const originalWorkspace = runResult.workingDirectory;

  const workspace = originalWorkspace ?? fs.mkdtempSync(path.join(os.tmpdir(), `axis-${options.scenarioKey}-`));
  const shouldCleanup = !originalWorkspace;
  // Always give the judge a fresh, isolated HOME — it doesn't need (and
  // shouldn't see) the agent's session state, and adapter `*_HOME` env vars
  // must point at a writable dir distinct from `workspace`.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `axis-judge-home-`));

  try {
    const output = await adapter.run({
      prompt,
      config: judgeConfig,
      scenario: {
        key: options.scenarioKey,
        name: options.scenarioName,
        prompt,
        judge: [],
      },
      workingDirectory: workspace,
      homeDirectory: home,
    });
    return output.result ?? "";
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (shouldCleanup) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
