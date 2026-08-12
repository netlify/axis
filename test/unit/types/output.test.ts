import { describe, it, expect } from "vitest";
import { isFailedRun, hasEmptyOutput } from "../../../src/types/output.js";
import type { AgentOutput, TranscriptEntry } from "../../../src/types/agent.js";

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    transcript: [],
    result: "Completed",
    metadata: {
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMs: 100,
      exitCode: 0,
    },
    ...overrides,
  };
}

const anEntry: TranscriptEntry = {
  type: "assistant",
  timestamp: new Date().toISOString(),
  content: { text: "hi" },
};

describe("hasEmptyOutput", () => {
  it("is true when transcript is empty AND result is null", () => {
    expect(hasEmptyOutput(makeOutput({ transcript: [], result: null }))).toBe(true);
  });

  it("is true when transcript is empty AND result is blank", () => {
    expect(hasEmptyOutput(makeOutput({ transcript: [], result: "   " }))).toBe(true);
  });

  it("is false when a result is present, even with an empty transcript (ACP-style)", () => {
    expect(hasEmptyOutput(makeOutput({ transcript: [], result: "answer" }))).toBe(false);
  });

  it("is false when the transcript has entries, even with a null result", () => {
    expect(hasEmptyOutput(makeOutput({ transcript: [anEntry], result: null }))).toBe(false);
  });
});

describe("isFailedRun", () => {
  it("treats the empty-work signature as failed even on a clean exit", () => {
    const output = makeOutput({ transcript: [], result: null, metadata: { ...makeOutput().metadata, exitCode: 0 } });
    expect(isFailedRun(output)).toBe(true);
  });

  it("treats an explicit error as failed", () => {
    const output = makeOutput({ metadata: { ...makeOutput().metadata, error: "boom" } });
    expect(isFailedRun(output)).toBe(true);
  });

  it("does not treat a result-only run (empty transcript) as failed", () => {
    // ACP agents SIGTERM'd after completing: non-zero exit but a real result.
    const output = makeOutput({
      transcript: [],
      result: "answer",
      metadata: { ...makeOutput().metadata, exitCode: 1 },
    });
    expect(isFailedRun(output)).toBe(false);
  });

  it("does not treat a transcript-only run (null result) as failed on clean exit", () => {
    const output = makeOutput({ transcript: [anEntry], result: null });
    expect(isFailedRun(output)).toBe(false);
  });

  it("treats a null-result run with a non-zero exit as failed", () => {
    const output = makeOutput({
      transcript: [anEntry],
      result: null,
      metadata: { ...makeOutput().metadata, exitCode: 1 },
    });
    expect(isFailedRun(output)).toBe(true);
  });
});
