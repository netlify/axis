import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

// Mock the adapter registry and lifecycle executor
vi.mock("../../../src/adapters/registry.js", () => ({
  getAdapter: vi.fn(),
  registerAdapter: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
  runLifecyclePhase: vi.fn().mockResolvedValue({ results: [] }),
}));

import { run } from "../../../src/runner/runner.js";
import { getAdapter } from "../../../src/adapters/registry.js";

const mockGetAdapter = vi.mocked(getAdapter);

const KITCHEN_SINK_DIR = path.resolve(import.meta.dirname, "../../e2e/kitchen-sink");

function createMockAdapter(name: string) {
  return {
    name,
    run: vi.fn().mockResolvedValue({
      transcript: [
        { type: "assistant", timestamp: new Date().toISOString(), content: { text: `Response from ${name}` } },
      ],
      result: `Response from ${name}`,
      metadata: {
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 100,
        exitCode: 0,
      },
    }),
  };
}

function setupAdapters() {
  const adapters: Record<string, ReturnType<typeof createMockAdapter>> = {
    "claude-code": createMockAdapter("claude-code"),
    codex: createMockAdapter("codex"),
  };
  mockGetAdapter.mockImplementation((name: string) => adapters[name]);
  return adapters;
}

describe("kitchen-sink (all adapters)", () => {
  const origCodexKey = process.env.CODEX_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEX_API_KEY = "test-key";
    setupAdapters();
  });

  afterEach(() => {
    if (origCodexKey !== undefined) {
      process.env.CODEX_API_KEY = origCodexKey;
    } else {
      delete process.env.CODEX_API_KEY;
    }
  });

  it("runs active scenarios across all agent instances (skipped excluded)", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    // 1 active scenario (echo-test) × 3 agent instances = 3 results.
    // summarize-docs has skip:true, which propagates to its 2 variants — so 2 skipped keys.
    expect(output.results).toHaveLength(3);
    expect(output.summary.total).toBe(3);
    expect(output.summary.completed).toBe(3);
    expect(output.summary.failed).toBe(0);
    expect(output.summary.skipped).toBe(2);
  });

  it("produces results with correct agent names", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const agentNames = [...new Set(output.results.map((r) => r.agentName))].sort();
    expect(agentNames).toEqual(["claude-code|claude-opus-4-6", "claude-code|claude-sonnet-4-6", "codex"]);
  });

  it("includes only active scenario keys", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const scenarioKeys = [...new Set(output.results.map((r) => r.scenarioKey))].sort();
    expect(scenarioKeys).toEqual(["echo-test"]);
  });

  it("echo-test scenario has correct prompt and rubric", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const echoResults = output.results.filter((r) => r.scenarioKey === "echo-test");
    expect(echoResults).toHaveLength(3);
    for (const result of echoResults) {
      expect(result.scenarioName).toBe("Largest English word");
      expect(result.prompt).toContain("largest word in the English language");
      expect(result.rubric).toBeInstanceOf(Array);
      expect(result.rubric).toHaveLength(2);
    }
  });

  it("preserves agent type in agentConfig", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const byAgent = Object.fromEntries(output.results.map((r) => [r.agentName, r]));
    expect(byAgent["claude-code|claude-sonnet-4-6"].agentConfig.agent).toBe("claude-code");
    expect(byAgent["claude-code|claude-sonnet-4-6"].agentConfig.model).toBe("claude-sonnet-4-6");
    expect(byAgent["claude-code|claude-opus-4-6"].agentConfig.agent).toBe("claude-code");
    expect(byAgent["claude-code|claude-opus-4-6"].agentConfig.model).toBe("claude-opus-4-6");
    expect(byAgent["codex"].agentConfig.agent).toBe("codex");
  });

  it("filters to single agent from mixed config", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
      agentFilter: ["codex"],
    });

    // 1 active scenario × 1 agent = 1 result
    expect(output.results).toHaveLength(1);
    expect(output.results.every((r) => r.agentName === "codex")).toBe(true);
  });

  it("calls each adapter once per active scenario", async () => {
    const adapters = setupAdapters();

    await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    // claude-code is registered twice (sonnet + opus instances), codex once.
    expect(adapters["claude-code"].run).toHaveBeenCalledTimes(2);
    expect(adapters["codex"].run).toHaveBeenCalledTimes(1);
  });
});
