import { describe, it, expect } from "vitest";
import { isFailedRun, hasEmptyOutput, runExitStatus } from "../../../src/types/output.js";
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

describe("runExitStatus", () => {
  const clean = { summary: { total: 2, completed: 2, failed: 0 } };

  it("is zero for a run where everything passed", () => {
    expect(runExitStatus(clean)).toEqual({ code: 0 });
  });

  it("is non-zero when a job failed", () => {
    expect(runExitStatus({ summary: { total: 2, completed: 1, failed: 1 } }).code).toBe(1);
  });

  it("is non-zero when a scenario file failed to load, even with every job passing", () => {
    const status = runExitStatus({
      ...clean,
      loadFailures: [{ path: "/s/broken.ts", reason: "Unexpected token" }],
    });

    expect(status.code).toBe(1);
    expect(status.reason).toContain("1 scenario file failed to load");
    expect(status.reason).toContain("did not cover the whole suite");
  });

  it("pluralizes the load failure reason", () => {
    const status = runExitStatus({
      ...clean,
      loadFailures: [
        { path: "/s/a.ts", reason: "boom" },
        { path: "/s/b.json", reason: "file is not valid JSON" },
      ],
    });

    expect(status.reason).toContain("2 scenario files failed to load");
    expect(status.reason).toContain("move them");
  });

  it("is non-zero when nothing ran at all", () => {
    const status = runExitStatus({ summary: { total: 0, completed: 0, failed: 0 } });

    expect(status.code).toBe(1);
    expect(status.reason).toContain("No scenarios ran");
  });

  it("gives no reason for ordinary job failures, since the table already shows them", () => {
    expect(runExitStatus({ summary: { total: 1, completed: 0, failed: 1 } }).reason).toBeUndefined();
  });
});
