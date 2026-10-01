import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";
import type { JobState, Logger } from "../../../src/types/output.js";

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

const mockGetAdapter = vi.mocked(getAdapter);
const mockLifecycle = vi.mocked(runLifecyclePhase);

let tmpDir: string;

/** Write a throwaway config with the given scenarios and settings. */
function writeConfig(opts: {
  scenarios: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  agents?: unknown[];
}): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-runner-multirun-"));
  const scenariosDir = path.join(tmpDir, "scenarios");
  fs.mkdirSync(scenariosDir);

  for (const scenario of opts.scenarios) {
    const { key, ...body } = scenario as { key: string };
    fs.writeFileSync(path.join(scenariosDir, `${key}.json`), JSON.stringify(body));
  }

  const configPath = path.join(tmpDir, "axis.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      scenarios: "./scenarios",
      agents: opts.agents ?? ["mock-agent"],
      ...(opts.settings ? { settings: opts.settings } : {}),
    }),
  );
  return configPath;
}

function scenario(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, name: key, prompt: "do it", judge: "it was done", ...extra };
}

function createMockAdapter() {
  return {
    name: "mock-agent",
    run: vi.fn().mockImplementation(() => {
      const now = new Date().toISOString();
      return Promise.resolve({
        transcript: [{ type: "assistant", timestamp: now, content: { text: "worked" } }],
        result: "ok",
        metadata: { startTime: now, endTime: now, durationMs: 5, exitCode: 0, tokenUsage: { input: 10, output: 5 } },
      });
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLifecycle.mockResolvedValue({ results: [] } as never);
  mockGetAdapter.mockReturnValue(createMockAdapter() as never);
});

describe("run counts", () => {
  it("runs a pair once by default", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].runIndex).toBeUndefined();
    expect(output.results[0].runCount).toBeUndefined();
  });

  it("repeats each pair settings.runs times", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 3 } });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.results).toHaveLength(3);
    expect(output.results.map((r) => r.runIndex).sort()).toEqual([1, 2, 3]);
    expect(output.results.every((r) => r.runCount === 3)).toBe(true);
  });

  it("lets a scenario override the suite default", async () => {
    const configPath = writeConfig({
      scenarios: [scenario("a", { runs: 3 }), scenario("b")],
      settings: { runs: 5 },
    });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.results.filter((r) => r.scenarioKey === "a")).toHaveLength(3);
    expect(output.results.filter((r) => r.scenarioKey === "b")).toHaveLength(5);
  });

  it("lets the caller override both", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a", { runs: 3 })], settings: { runs: 5 } });
    const output = await run({ configPath, logger: silentLogger, runs: 1 });

    expect(output.results).toHaveLength(1);
  });

  it("rejects a run count below one rather than guessing at intent", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    await expect(run({ configPath, logger: silentLogger, runs: 0 })).rejects.toThrow(/positive integer/);
    await expect(run({ configPath, logger: silentLogger, runs: -1 })).rejects.toThrow(/positive integer/);
  });

  it("rejects an even override rather than silently rounding it", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    await expect(run({ configPath, logger: silentLogger, runs: 4 })).rejects.toThrow(/must be odd/);
  });

  it("rejects an even override before doing any work", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    await expect(run({ configPath, logger: silentLogger, runs: 2 })).rejects.toThrow(/must be odd/);
    // Failing during pre-flight rather than after discovery means no agent ran.
    expect(mockGetAdapter).not.toHaveBeenCalled();
  });

  it("rejects an even runs value in the config", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 4 } });
    await expect(run({ configPath, logger: silentLogger })).rejects.toThrow(/must be odd/);
  });

  it("applies the repeat count per agent", async () => {
    const configPath = writeConfig({
      scenarios: [scenario("a")],
      agents: ["mock-agent", { agent: "mock-agent", name: "second" }],
      settings: { runs: 3 },
    });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.results).toHaveLength(6);
  });

  it("inherits runs into variants and lets a variant override it", async () => {
    const configPath = writeConfig({
      scenarios: [
        scenario("a", {
          runs: 3,
          variants: [{ name: "fast" }, { name: "slow", runs: 1 }],
        }),
      ],
    });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.results.filter((r) => r.scenarioKey === "a@fast")).toHaveLength(3);
    expect(output.results.filter((r) => r.scenarioKey === "a@slow")).toHaveLength(1);
  });
});

describe("run-major ordering", () => {
  it("starts every pair's first run before any pair's second", async () => {
    const configPath = writeConfig({
      scenarios: [scenario("a"), scenario("b")],
      settings: { runs: 3 },
    });

    // Concurrency 1 makes the queue order observable through job updates.
    const order: string[] = [];
    const logger: Logger = {
      info() {},
      error() {},
      onJobUpdate(jobs: JobState[]) {
        for (const job of jobs) {
          if (job.status !== "starting") continue;
          const id = `${job.scenarioKey}#${job.runIndex}`;
          if (!order.includes(id)) order.push(id);
        }
      },
    };

    await run({ configPath, logger, concurrency: 1 });

    expect(order).toEqual(["a#1", "b#1", "a#2", "b#2", "a#3", "b#3"]);
  });
});

describe("pair-level summary", () => {
  it("counts pairs, not runs, in the totals", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a"), scenario("b")], settings: { runs: 3 } });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.summary.total).toBe(2);
    expect(output.summary.completed).toBe(2);
    expect(output.summary.runsTotal).toBe(6);
    expect(output.summary.runsFailed).toBe(0);
  });

  it("omits the run counters when every pair ran once", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.summary.runsTotal).toBeUndefined();
    expect(output.summary.runsFailed).toBeUndefined();
  });

  it("keeps a pair completed when only some of its runs failed", async () => {
    let call = 0;
    mockGetAdapter.mockReturnValue({
      name: "mock-agent",
      run: vi.fn().mockImplementation(() => {
        const now = new Date().toISOString();
        const fails = ++call === 1;
        return Promise.resolve({
          transcript: fails ? [] : [{ type: "assistant", timestamp: now, content: { text: "worked" } }],
          result: fails ? null : "ok",
          metadata: {
            startTime: now,
            endTime: now,
            durationMs: 5,
            exitCode: fails ? 1 : 0,
            ...(fails ? { error: "crashed" } : {}),
          },
        });
      }),
    } as never);

    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 3 } });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.summary.runsFailed).toBe(1);
  });

  it("fails a pair only when every run failed", async () => {
    mockGetAdapter.mockReturnValue({
      name: "mock-agent",
      run: vi.fn().mockImplementation(() => {
        const now = new Date().toISOString();
        return Promise.resolve({
          transcript: [],
          result: null,
          metadata: { startTime: now, endTime: now, durationMs: 5, exitCode: 1, error: "crashed" },
        });
      }),
    } as never);

    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 3 } });
    const output = await run({ configPath, logger: silentLogger });

    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(0);
    expect(output.summary.failed).toBe(1);
    expect(output.summary.runsFailed).toBe(3);
  });
});

describe("job state", () => {
  it("stamps run identity on every job row for a repeated pair", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 3 } });
    let lastJobs: JobState[] = [];
    await run({
      configPath,
      logger: {
        info() {},
        error() {},
        onJobUpdate: (jobs) => {
          lastJobs = jobs;
        },
      },
    });

    expect(lastJobs).toHaveLength(3);
    expect(lastJobs.map((j) => j.runIndex)).toEqual([1, 2, 3]);
    expect(lastJobs.every((j) => j.runCount === 3)).toBe(true);
  });

  it("leaves run identity off a single-run job row", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a")] });
    let lastJobs: JobState[] = [];
    await run({
      configPath,
      logger: {
        info() {},
        error() {},
        onJobUpdate: (jobs) => {
          lastJobs = jobs;
        },
      },
    });

    expect(lastJobs[0].runIndex).toBeUndefined();
    expect(lastJobs[0].runCount).toBeUndefined();
  });
});

describe("jobFilter", () => {
  it("retries a repeated pair in full, so the retried sample is complete", async () => {
    // Filtering is per pair, never per run: re-running a subset would leave the
    // retry report holding a partial (possibly even-sized) sample, which is the
    // case odd run counts exist to rule out.
    const configPath = writeConfig({ scenarios: [scenario("a")], settings: { runs: 3 } });
    const output = await run({
      configPath,
      logger: silentLogger,
      jobFilter: [{ scenarioKey: "a", agentName: "mock-agent" }],
    });

    expect(output.results).toHaveLength(3);
    expect(output.results.map((r) => r.runIndex).sort()).toEqual([1, 2, 3]);
  });

  it("drops pairs the filter does not name", async () => {
    const configPath = writeConfig({ scenarios: [scenario("a"), scenario("b")], settings: { runs: 3 } });
    const output = await run({
      configPath,
      logger: silentLogger,
      jobFilter: [{ scenarioKey: "b", agentName: "mock-agent" }],
    });

    expect(output.results).toHaveLength(3);
    expect(new Set(output.results.map((r) => r.scenarioKey))).toEqual(new Set(["b"]));
  });
});

describe("lifecycle context", () => {
  it("exposes the run index and count to setup scripts", async () => {
    const configPath = writeConfig({
      scenarios: [scenario("a", { setup: [{ action: "run_script", command: "echo hi" }] })],
      settings: { runs: 3 },
    });

    await run({ configPath, logger: silentLogger });

    const setupCalls = mockLifecycle.mock.calls.filter((call) => call[3] === "setup");
    expect(setupCalls).toHaveLength(3);
    const contexts = setupCalls.map((call) => call[4] as { runIndex?: number; runCount?: number });
    expect(contexts.map((c) => c.runIndex).sort()).toEqual([1, 2, 3]);
    expect(contexts.every((c) => c.runCount === 3)).toBe(true);
  });

  it("passes run 1 of 1 for an unrepeated pair so scripts need no branch", async () => {
    const configPath = writeConfig({
      scenarios: [scenario("a", { setup: [{ action: "run_script", command: "echo hi" }] })],
    });

    await run({ configPath, logger: silentLogger });

    const setupCall = mockLifecycle.mock.calls.find((call) => call[3] === "setup")!;
    expect(setupCall[4]).toMatchObject({ runIndex: 1, runCount: 1 });
  });
});
