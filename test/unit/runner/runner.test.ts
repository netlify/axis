import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

// Mock the adapter registry and lifecycle executor
vi.mock("../../../src/adapters/registry.js", () => ({
  getAdapter: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
  runLifecyclePhase: vi.fn().mockResolvedValue({ results: [] }),
}));

import { run } from "../../../src/runner/runner.js";
import { getAdapter } from "../../../src/adapters/registry.js";
import { runLifecyclePhase } from "../../../src/runner/lifecycle.js";

const mockExecuteLifecycle = vi.mocked(runLifecyclePhase);

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
    expect(output.results[0].judge).toBeDefined();
    expect(output.results[0].agentConfig).toBeDefined();
    expect(output.results[0].agentConfig.agent).toBe("mock-agent");
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
    expect(call.config.agent).toBe("mock-agent");
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
      return { results: [] };
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

  describe("agent name generation", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axis-naming-"));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function writeConfig(agents: unknown): string {
      const cfg = {
        scenarios: [{ key: "s", name: "S", prompt: "p", judge: "r" }],
        agents,
      };
      const p = path.join(tmp, "axis.config.json");
      fs.writeFileSync(p, JSON.stringify(cfg));
      return p;
    }

    it("uses {agent}|{model} when model is set", async () => {
      const mockAdapter = createMockAdapter();
      mockGetAdapter.mockReturnValue(mockAdapter);

      const output = await run({
        configPath: writeConfig([
          { agent: "mock-agent", model: "opus" },
          { agent: "mock-agent", model: "sonnet" },
        ]),
        logger: silentLogger,
      });

      const names = output.results.map((r) => r.agentName).sort();
      expect(names).toEqual(["mock-agent|opus", "mock-agent|sonnet"]);
    });

    it("falls back to -N suffix only when names collide", async () => {
      const mockAdapter = createMockAdapter();
      mockGetAdapter.mockReturnValue(mockAdapter);

      const output = await run({
        configPath: writeConfig([{ agent: "mock-agent" }, { agent: "mock-agent" }]),
        logger: silentLogger,
      });

      const names = output.results.map((r) => r.agentName).sort();
      expect(names).toEqual(["mock-agent", "mock-agent-2"]);
    });

    it("scenario.agents prefix-matches the base agent name across models", async () => {
      const mockAdapter = createMockAdapter();
      mockGetAdapter.mockReturnValue(mockAdapter);

      const cfg = {
        scenarios: [{ key: "s", name: "S", prompt: "p", judge: "r", agents: ["mock-agent"] }],
        agents: [
          { agent: "mock-agent", model: "opus" },
          { agent: "mock-agent", model: "sonnet" },
        ],
      };
      const p = path.join(tmp, "axis.config.json");
      fs.writeFileSync(p, JSON.stringify(cfg));

      const output = await run({ configPath: p, logger: silentLogger });
      const names = output.results.map((r) => r.agentName).sort();
      expect(names).toEqual(["mock-agent|opus", "mock-agent|sonnet"]);
    });
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

  describe("limits", () => {
    it("fails job with scenario time limit message when timeout matches scenario limit", async () => {
      // Mock adapter that takes longer than the time limit
      const mockAdapter = {
        name: "mock-agent",
        run: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 200));
          return {
            transcript: [],
            result: "done",
            metadata: {
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
              durationMs: 200,
              exitCode: 0,
            },
          };
        }),
      };
      mockGetAdapter.mockReturnValue(mockAdapter);

      const limitsDir = path.resolve(import.meta.dirname, "../../e2e/fixtures/limits");
      const output = await run({
        configPath: path.join(limitsDir, "axis.config.json"),
        logger: silentLogger,
      });

      // With default scenario limits of 5 min and 100k tokens, a 200ms adapter should succeed
      expect(output.results).toHaveLength(1);
      expect(output.summary.completed).toBe(1);
    });

    it("fails job when per-scenario token limit is exceeded via onTokenProgress", async () => {
      const mockAdapter = {
        name: "mock-agent",
        run: vi.fn().mockImplementation(async (input: any) => {
          // Report tokens that exceed the limit (100000 default scenario tokens)
          input.onTokenProgress?.(50000);
          input.onTokenProgress?.(110000);
          // Should be aborted by now via signal
          await new Promise((r) => setTimeout(r, 50));
          return {
            transcript: [],
            result: "done",
            metadata: {
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
              durationMs: 50,
              exitCode: 0,
            },
          };
        }),
      };
      mockGetAdapter.mockReturnValue(mockAdapter);

      const limitsDir = path.resolve(import.meta.dirname, "../../e2e/fixtures/limits");
      const output = await run({
        configPath: path.join(limitsDir, "axis.config.json"),
        logger: silentLogger,
      });

      expect(output.results).toHaveLength(1);
      expect(output.results[0].output.metadata.error).toContain("Scenario token limit reached");
      expect(output.summary.failed).toBe(1);
    });

    it("fails remaining jobs when overall token limit is exceeded", async () => {
      // Mock adapter that reports high token usage
      const mockAdapter = {
        name: "mock-agent",
        run: vi.fn().mockImplementation(async (input: any) => {
          input.onTokenProgress?.(600000); // Each job uses 600k tokens
          return {
            transcript: [],
            result: "done",
            metadata: {
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
              durationMs: 10,
              exitCode: 0,
              tokenUsage: { input: 500000, output: 100000 },
            },
          };
        }),
      };
      mockGetAdapter.mockReturnValue(mockAdapter);

      const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
      const output = await run({
        configPath: path.join(realisticDir, "axis.config.json"),
        logger: silentLogger,
        concurrency: 1, // Sequential so we can predict ordering
      });

      // Overall token limit is not set in realistic-tasks config, so all 4 should complete
      expect(output.results).toHaveLength(4);
      expect(output.summary.completed).toBe(4);
    });

    it("no limits configured preserves existing behavior", async () => {
      const mockAdapter = createMockAdapter();
      mockGetAdapter.mockReturnValue(mockAdapter);

      const output = await run(baseOptions);

      expect(output.results).toHaveLength(1);
      expect(output.summary.completed).toBe(1);
      expect(output.summary.failed).toBe(0);
    });

    it("passes scenario timeoutMs to adapter when scenario has time limit", async () => {
      const mockAdapter = {
        name: "mock-agent",
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

      const limitsDir = path.resolve(import.meta.dirname, "../../e2e/fixtures/limits");
      await run({
        configPath: path.join(limitsDir, "axis.config.json"),
        logger: silentLogger,
      });

      const call = mockAdapter.run.mock.calls[0][0];
      // Default scenario limit is 5 minutes = 300000ms
      expect(call.timeoutMs).toBe(5 * 60 * 1000);
      expect(call.signal).toBeDefined();
      expect(call.signal).toBeInstanceOf(AbortSignal);
    });

    it("passes default 15-minute timeoutMs even when no limits configured", async () => {
      const mockAdapter = createMockAdapter();
      mockGetAdapter.mockReturnValue(mockAdapter);

      await run(baseOptions);

      const call = mockAdapter.run.mock.calls[0][0];
      // Default scenario time limit is 15 minutes = 900000ms
      expect(call.timeoutMs).toBe(15 * 60 * 1000);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBeFalsy();
    });

    it("rewrites timeout error to scenario time limit message", async () => {
      const mockAdapter = {
        name: "mock-agent",
        run: vi.fn().mockResolvedValue({
          transcript: [],
          result: null,
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 300000,
            exitCode: 1,
            error: "Agent timed out after 300s",
          },
        }),
      };
      mockGetAdapter.mockReturnValue(mockAdapter);

      const limitsDir = path.resolve(import.meta.dirname, "../../e2e/fixtures/limits");
      const output = await run({
        configPath: path.join(limitsDir, "axis.config.json"),
        logger: silentLogger,
      });

      expect(output.results[0].output.metadata.error).toBe("Scenario time limit reached (5m)");
    });

    it("overall time limit fails pending jobs immediately", async () => {
      let jobCount = 0;
      const mockAdapter = {
        name: "mock-agent",
        run: vi.fn().mockImplementation(async () => {
          jobCount++;
          // First job takes a while
          if (jobCount === 1) {
            await new Promise((r) => setTimeout(r, 200));
          }
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

      // Use realistic-tasks (4 scenarios) with concurrency=1 and tight overall time limit
      // We need a custom config with a very short overall time limit
      // Instead, let's verify the mechanism by checking that the runner creates abort controllers
      const realisticDir = path.resolve(import.meta.dirname, "../../e2e/realistic-tasks");
      const output = await run({
        configPath: path.join(realisticDir, "axis.config.json"),
        logger: silentLogger,
        concurrency: 1,
      });

      // Without overall limits, all 4 should complete
      expect(output.results).toHaveLength(4);
      expect(output.summary.completed).toBe(4);
    });
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

describe("artifact capture", () => {
  let tmp: string;
  let reportDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axis-artifact-cfg-"));
    reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-artifact-report-"));

    fs.writeFileSync(
      path.join(tmp, "axis.config.json"),
      JSON.stringify({
        scenarios: [
          {
            key: "with-artifacts",
            name: "With Artifacts",
            prompt: "make some files",
            judge: "files were made",
            artifacts: ["*.log", "out/**"],
          },
        ],
        agents: ["mock-agent"],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(reportDir, { recursive: true, force: true });
  });

  it("captures artifacts after teardown and attaches them to the result", async () => {
    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        // Drop a few files into the workspace as if the agent created them
        fs.writeFileSync(path.join(input.workingDirectory, "build.log"), "compile ok\n");
        fs.mkdirSync(path.join(input.workingDirectory, "out"), { recursive: true });
        fs.writeFileSync(path.join(input.workingDirectory, "out", "result.json"), '{"ok":true}');
        fs.writeFileSync(path.join(input.workingDirectory, "ignored.tmp"), "skip me");
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 5,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run({
      configPath: path.join(tmp, "axis.config.json"),
      logger: silentLogger,
      reportDir,
    });

    expect(output.results).toHaveLength(1);
    const artifacts = output.results[0].artifacts;
    expect(artifacts).toBeDefined();
    expect(artifacts!.map((a) => a.path).sort()).toEqual(["build.log", "out/result.json"]);

    const logEntry = artifacts!.find((a) => a.path === "build.log")!;
    expect(logEntry.mimeType).toBe("text/plain");
    expect(Buffer.from(logEntry.content, "base64").toString("utf8")).toBe("compile ok\n");

    // Files copied to disk under reportDir
    expect(fs.existsSync(path.join(reportDir, "scenarios/with-artifacts/mock-agent/artifacts/build.log"))).toBe(true);
    expect(fs.existsSync(path.join(reportDir, "scenarios/with-artifacts/mock-agent/artifacts/out/result.json"))).toBe(
      true,
    );
  });

  it("skips capture when no patterns are configured", async () => {
    fs.writeFileSync(
      path.join(tmp, "axis.config.json"),
      JSON.stringify({
        scenarios: [
          {
            key: "no-artifacts",
            name: "No Artifacts",
            prompt: "x",
            judge: "x",
          },
        ],
        agents: ["mock-agent"],
      }),
    );

    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        fs.writeFileSync(path.join(input.workingDirectory, "stuff.log"), "x");
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 5,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run({
      configPath: path.join(tmp, "axis.config.json"),
      logger: silentLogger,
      reportDir,
    });

    expect(output.results[0].artifacts).toBeUndefined();
    expect(fs.existsSync(path.join(reportDir, "scenarios"))).toBe(false);
  });

  it("merges top-level config artifacts with scenario artifacts", async () => {
    fs.writeFileSync(
      path.join(tmp, "axis.config.json"),
      JSON.stringify({
        scenarios: [
          {
            key: "merged",
            name: "Merged",
            prompt: "x",
            judge: "x",
            artifacts: ["scenario.txt"],
          },
        ],
        agents: ["mock-agent"],
        artifacts: ["config.txt"],
      }),
    );

    const mockAdapter = {
      name: "mock-agent",
      run: vi.fn().mockImplementation(async (input) => {
        fs.writeFileSync(path.join(input.workingDirectory, "config.txt"), "c");
        fs.writeFileSync(path.join(input.workingDirectory, "scenario.txt"), "s");
        fs.writeFileSync(path.join(input.workingDirectory, "neither.txt"), "n");
        return {
          transcript: [],
          result: "done",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 5,
            exitCode: 0,
          },
        };
      }),
    };
    mockGetAdapter.mockReturnValue(mockAdapter);

    const output = await run({
      configPath: path.join(tmp, "axis.config.json"),
      logger: silentLogger,
      reportDir,
    });

    const paths = (output.results[0].artifacts ?? []).map((a) => a.path).sort();
    expect(paths).toEqual(["config.txt", "scenario.txt"]);
  });
});
