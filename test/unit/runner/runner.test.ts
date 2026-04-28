import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

// Mock the adapter registry and lifecycle executor
vi.mock("../../../src/adapters/registry.js", () => ({
  getAdapter: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";
import { getAdapter } from "../../../src/adapters/registry.js";
import { executeLifecycleActions } from "../../../src/runner/lifecycle.js";

const mockExecuteLifecycle = vi.mocked(executeLifecycleActions);

const mockGetAdapter = vi.mocked(getAdapter);
const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/fixtures/basic");

function createMockAdapter() {
  return {
    name: "mock-agent",
    run: vi.fn().mockResolvedValue({
      transcript: [{ type: "assistant", timestamp: new Date().toISOString(), content: { text: "I visited the page" } }],
      result: "Task completed successfully",
      metadata: {
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 1234,
        exitCode: 0,
        tokenUsage: { input: 500, output: 200 },
      },
    }),
  };
}

const baseOptions = {
  configPath: path.join(E2E_DIR, "axis.config.json"),
  logger: silentLogger,
};

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns RunOutput with version, timestamp, and summary", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run(baseOptions);

    expect(output.version).toBe("0.1.0");
    expect(output.timestamp).toBeDefined();
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
  });

  it("runs scenarios for each agent", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run(baseOptions);

    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results[0].agentName).toBe("mock-agent");
    expect(output.results[0].scenarioKey).toBe("hello-world");
    expect(output.results[0].scenarioName).toBe("Hello World");
    expect(output.results[0].output.result).toBe("Task completed successfully");
    expect(output.results[0].prompt).toBeDefined();
    expect(output.results[0].rubric).toBeDefined();
    expect(output.results[0].agentConfig).toBeDefined();
    expect(output.results[0].agentConfig.adapter).toBe("mock-agent");
    expect(mockAdapter.run).toHaveBeenCalled();
  });

  it("filters by agent name", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run({
      ...baseOptions,
      agentFilter: ["nonexistent-agent"],
    });

    expect(output.results).toHaveLength(0);
    expect(output.summary.total).toBe(0);
    expect(mockAdapter.run).not.toHaveBeenCalled();
  });

  it("filters by scenario key", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run({
      ...baseOptions,
      scenarioFilter: ["nonexistent-scenario"],
    });

    expect(output.results).toHaveLength(0);
  });

  it("passes scenario and agent config to adapter", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    await run(baseOptions);

    const call = mockAdapter.run.mock.calls[0][0];
    expect(call.prompt).toBeDefined();
    expect(call.config).toBeDefined();
    expect(call.config.adapter).toBe("mock-agent");
    expect(call.scenario).toBeDefined();
    expect(call.workingDirectory).toMatch(/axis-/);
    expect(call.env).toBeDefined();
    expect(call.env.PATH).toBeDefined();
  });

  it("executes multiple scenarios in parallel", async () => {
    const callOrder: string[] = [];
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        callOrder.push(`start:${input.scenario.key}`);
        // Simulate async work — long enough to detect parallel overlap
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push(`end:${input.scenario.key}`);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
    const output = await run({
      configPath: path.join(realisticDir, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results).toHaveLength(4);
    expect(output.summary.total).toBe(4);
    expect(output.summary.completed).toBe(4);

    // Verify parallel: all starts should happen before all ends
    // (in sequential mode, it would be start/end/start/end/start/end)
    const starts = callOrder.filter((e) => e.startsWith("start:"));
    const ends = callOrder.filter((e) => e.startsWith("end:"));
    const lastStartIndex = callOrder.lastIndexOf(starts[starts.length - 1]);
    const firstEndIndex = callOrder.indexOf(ends[0]);
    expect(lastStartIndex).toBeLessThan(firstEndIndex);
  });

  it("calls onResult for each completed job", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
    const receivedResults: string[] = [];

    await run({
      configPath: path.join(realisticDir, "axis.config.json"),
      logger: silentLogger,
      onResult: (result) => {
        receivedResults.push(result.scenarioKey);
      },
    });

    expect(receivedResults).toHaveLength(4);
    expect(receivedResults).toContain("fetch-and-summarize");
    expect(receivedResults).toContain("generate-function");
    expect(receivedResults).toContain("debug-and-fix");
    expect(receivedResults).toContain("explain-docs");
  });

  it("awaits onResult before running teardown", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const order: string[] = [];

    // Track teardown calls
    mockExecuteLifecycle.mockImplementation(async (actions) => {
      const cmd = actions[0]?.command ?? "";
      if (cmd.includes("rm") || cmd.includes("cleanup") || cmd.includes("teardown")) {
        order.push("teardown");
      }
      return [];
    });

    const multiStepDir = path.resolve(import.meta.dirname, "../../e2e/multi-step");

    await run({
      configPath: path.join(multiStepDir, "axis.config.json"),
      logger: silentLogger,
      onResult: async () => {
        order.push("onResult:start");
        // Simulate async scoring work
        await new Promise((r) => setTimeout(r, 50));
        order.push("onResult:end");
      },
    });

    // onResult must fully complete before teardown runs
    const onResultEnd = order.indexOf("onResult:end");
    const teardownStart = order.indexOf("teardown");
    expect(onResultEnd).toBeGreaterThanOrEqual(0);
    expect(teardownStart).toBeGreaterThanOrEqual(0);
    expect(onResultEnd).toBeLessThan(teardownStart);
  });

  it("respects concurrency limit of 1 (sequential execution)", async () => {
    const callOrder: string[] = [];
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        callOrder.push(`start:${input.scenario.key}`);
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push(`end:${input.scenario.key}`);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
    const output = await run({
      configPath: path.join(realisticDir, "axis.config.json"),
      logger: silentLogger,
      concurrency: 1,
    });

    expect(output.results).toHaveLength(4);

    // With concurrency 1, execution must be strictly sequential:
    // start/end/start/end/start/end (no interleaved starts)
    for (let i = 0; i < callOrder.length - 1; i += 2) {
      expect(callOrder[i]).toMatch(/^start:/);
      expect(callOrder[i + 1]).toMatch(/^end:/);
    }
  });

  it("concurrency higher than job count runs all in parallel", async () => {
    const callOrder: string[] = [];
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        callOrder.push(`start:${input.scenario.key}`);
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push(`end:${input.scenario.key}`);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
    const output = await run({
      configPath: path.join(realisticDir, "axis.config.json"),
      logger: silentLogger,
      concurrency: 100,
    });

    expect(output.results).toHaveLength(4);

    // All starts should happen before all ends (parallel behavior)
    const starts = callOrder.filter((e) => e.startsWith("start:"));
    const ends = callOrder.filter((e) => e.startsWith("end:"));
    const lastStartIndex = callOrder.lastIndexOf(starts[starts.length - 1]);
    const firstEndIndex = callOrder.indexOf(ends[0]);
    expect(lastStartIndex).toBeLessThan(firstEndIndex);
  });

  it("skips scenarios with agents override that excludes the agent", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    const scenarioAgentsDir = path.resolve(import.meta.dirname, "../../e2e/scenario-agents");
    const output = await run({
      configPath: path.join(scenarioAgentsDir, "axis.config.json"),
      logger: silentLogger,
    });

    // Config has 2 agents × 2 scenarios = 4 potential jobs
    // But gemini-only.json has agents: ["gemini"], so claude-code is excluded from it
    // Expected: claude-code×all-agents, gemini×all-agents, gemini×gemini-only = 3 jobs
    expect(output.results).toHaveLength(3);

    const geminiOnlyResults = output.results.filter((r) => r.scenarioKey === "gemini-only");
    expect(geminiOnlyResults).toHaveLength(1);
    expect(geminiOnlyResults[0].agentName).toBe("gemini");

    const allAgentResults = output.results.filter((r) => r.scenarioKey === "all-agents");
    expect(allAgentResults).toHaveLength(2);
  });

  it("fails early when adapter requiredEnv vars are missing", async () => {
    const mockAdapter = {
      name: "mock-agent",
      requiredEnv: () => ["SOME_MISSING_KEY"],
      run: vi.fn().mockResolvedValue({
        transcript: [],
        result: "done",
        metadata: {
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          durationMs: 10,
          exitCode: 0,
        },
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    await expect(run(baseOptions)).rejects.toThrow("SOME_MISSING_KEY");
    expect(mockAdapter.run).not.toHaveBeenCalled();
  });

  it("stamps runStartedAt when the job transitions to running", async () => {
    const mockAdapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(mockAdapter);

    let seenRunning: number | undefined;
    const before = Date.now();
    await run({
      ...baseOptions,
      logger: {
        ...silentLogger,
        onJobUpdate: (jobs) => {
          if (jobs[0]?.status === "running" && jobs[0].runStartedAt !== undefined) {
            seenRunning ??= jobs[0].runStartedAt;
          }
        },
      },
    });
    const after = Date.now();

    expect(seenRunning).toBeDefined();
    expect(seenRunning!).toBeGreaterThanOrEqual(before);
    expect(seenRunning!).toBeLessThanOrEqual(after);
  });

  it("propagates monotonic liveTokens updates to onJobUpdate", async () => {
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        // Simulate an adapter that streams token estimates, including one
        // non-increasing value that must be dropped by the runner.
        input.onTokenProgress?.(50);
        input.onTokenProgress?.(75);
        input.onTokenProgress?.(60); // regression — should be ignored
        input.onTokenProgress?.(100);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
            tokenUsage: { input: 500, output: 200, cacheReadInput: 50 },
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const seen: number[] = [];
    await run({
      ...baseOptions,
      logger: {
        ...silentLogger,
        onJobUpdate: (jobs) => {
          const t = jobs[0]?.liveTokens;
          if (typeof t === "number") seen.push(t);
        },
      },
    });

    // Must be monotonically non-decreasing.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Regression (60 after 75) must not appear.
    expect(seen).not.toContain(60);
    // Adapter emissions observed.
    expect(seen).toContain(50);
    expect(seen).toContain(75);
    expect(seen).toContain(100);
    // Final bump to real total = 500 + 200 + 50 = 750.
    expect(seen[seen.length - 1]).toBe(750);
  });

  it("marks tokensFinal true after the real-total bump", async () => {
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        input.onTokenProgress?.(100);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
            tokenUsage: { input: 500, output: 200, cacheReadInput: 50 },
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    let finalSeen = false;
    let tokensWhenFinal: number | undefined;
    await run({
      ...baseOptions,
      logger: {
        ...silentLogger,
        onJobUpdate: (jobs) => {
          if (jobs[0]?.tokensFinal) {
            finalSeen = true;
            tokensWhenFinal = jobs[0].liveTokens;
          }
        },
      },
    });

    expect(finalSeen).toBe(true);
    expect(tokensWhenFinal).toBe(750);
  });

  it("does not mark tokensFinal when adapter omits tokenUsage", async () => {
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        input.onTokenProgress?.(42);
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 10,
            exitCode: 0,
            // no tokenUsage — like the generic cli adapter
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    let finalSeen = false;
    await run({
      ...baseOptions,
      logger: {
        ...silentLogger,
        onJobUpdate: (jobs) => {
          if (jobs[0]?.tokensFinal) finalSeen = true;
        },
      },
    });

    expect(finalSeen).toBe(false);
  });

  it("tracks failed results in summary", async () => {
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockResolvedValue({
        transcript: [],
        result: null,
        metadata: {
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          durationMs: 500,
          exitCode: 1,
        },
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run(baseOptions);

    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(0);
    expect(output.summary.failed).toBe(1);
  });
});
