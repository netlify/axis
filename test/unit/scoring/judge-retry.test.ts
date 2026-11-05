import { describe, it, expect, vi, beforeEach } from "vitest";

// Drive the judge's raw replies directly; the retry wrapper calls the mocked callJudge.
vi.mock("../../../src/scoring/judge.js", () => ({
  callJudge: vi.fn(),
}));

import { callJudgeAndParse } from "../../../src/scoring/judge-retry.js";
import { callJudge } from "../../../src/scoring/judge.js";
import { ScoringError } from "../../../src/scoring/errors.js";
import type { RunResult } from "../../../src/types/output.js";
import type * as JudgeModule from "../../../src/scoring/judge.js";

const mockCallJudge = vi.mocked(callJudge);
const runResult = { scenarioKey: "s", agentName: "claude-code" } as unknown as RunResult;
const parseScore = (text: string) => {
  const n = Number(text);
  if (Number.isNaN(n)) throw new ScoringError("Could not parse judge response");
  return n;
};
const call = (retries?: number, logger?: { verbose: (m: string) => void }) =>
  callJudgeAndParse(
    runResult,
    "prompt",
    { scenarioKey: "__judge__", scenarioName: "AXIS Judge", limits: { retries }, logger: logger as never },
    parseScore,
  );

describe("callJudgeAndParse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("makes one attempt by default and keeps the original error", async () => {
    mockCallJudge.mockRejectedValue(
      new ScoringError("Judge invocation failed (claude-code): Agent timed out after 600s"),
    );
    await expect(call()).rejects.toThrow(/^Judge invocation failed \(claude-code\): Agent timed out after 600s$/);
    expect(mockCallJudge).toHaveBeenCalledTimes(1);
  });

  it("retries a failed invocation and a reply it can't parse, then returns the parsed result", async () => {
    const verbose = vi.fn();
    mockCallJudge
      .mockRejectedValueOnce(new ScoringError("Judge invocation failed (claude-code): API Error: 529 overloaded"))
      .mockResolvedValueOnce("not a number")
      .mockResolvedValueOnce("7");
    await expect(call(2, { verbose })).resolves.toBe(7);
    expect(mockCallJudge).toHaveBeenCalledTimes(3);
    expect(verbose).toHaveBeenCalledTimes(2);
    expect(verbose.mock.calls[0][0]).toContain("attempt 2/3: Judge invocation failed");
    expect(verbose.mock.calls[1][0]).toContain("attempt 3/3: Could not parse judge response");
  });

  it("withholds after the last attempt, saying how many were made", async () => {
    mockCallJudge.mockResolvedValue("still not a number");
    const error = await call(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScoringError);
    expect((error as Error).message).toBe("Could not parse judge response (after 2 attempts)");
    expect(mockCallJudge).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry errors that aren't a withheld score", async () => {
    mockCallJudge.mockRejectedValue(new TypeError("bug"));
    await expect(call(3)).rejects.toBeInstanceOf(TypeError);
    expect(mockCallJudge).toHaveBeenCalledTimes(1);
  });
});

describe("judgeLimitsFromConfig", () => {
  it("converts minutes to ms and keeps unset fields unset", async () => {
    const { judgeLimitsFromConfig } = await vi.importActual<typeof JudgeModule>("../../../src/scoring/judge.js");
    expect(judgeLimitsFromConfig(undefined)).toEqual({});
    expect(judgeLimitsFromConfig({ agents: ["claude-code"] })).toEqual({});
    expect(judgeLimitsFromConfig({ agents: ["claude-code"], timeout_minutes: 15, retries: 1 })).toEqual({
      timeoutMs: 900_000,
      retries: 1,
    });
  });
});
