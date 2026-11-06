import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { registerAdapter, _resetAdapterCache } from "../../../src/adapters/registry.js";
import { callJudge } from "../../../src/scoring/judge.js";
import type { AgentAdapter, AgentInput } from "../../../src/types/agent.js";
import type { RunResult } from "../../../src/types/output.js";

const runResult = { agentConfig: { agent: "stub-judge" } } as unknown as RunResult;

function stubJudge(onRun: (input: AgentInput) => void): AgentAdapter {
  return {
    name: "stub-judge",
    isolationEnv: ({ home }) => ({ STUB_HOME: path.join(home, ".stub") }),
    async run(input) {
      onRun(input);
      const now = new Date().toISOString();
      return {
        result: "graded",
        transcript: [],
        metadata: { startTime: now, endTime: now, durationMs: 0, exitCode: 0 },
      };
    },
  };
}

describe("callJudge", () => {
  const exported = process.env.STUB_HOME;

  afterEach(() => {
    _resetAdapterCache();
    if (exported === undefined) delete process.env.STUB_HOME;
    else process.env.STUB_HOME = exported;
  });

  it("spawns the judge with its isolation env under the fresh HOME, over anything the operator exported", async () => {
    process.env.STUB_HOME = "/operator/real/stub";
    let seen: AgentInput | undefined;
    registerAdapter(
      "stub-judge",
      stubJudge((input) => (seen = input)),
    );

    await callJudge(runResult, "grade this", { scenarioKey: "__judge__", scenarioName: "Judge" });

    expect(seen?.env?.HOME).toBe(seen?.homeDirectory);
    expect(seen?.env?.STUB_HOME).toBe(path.join(seen!.homeDirectory, ".stub"));
    expect(seen?.env?.PATH).toBe(process.env.PATH);
    expect(seen?.homeDirectory).not.toBe(process.env.HOME);
  });
});
