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

  it("runs both scenarios across both adapters", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    // 2 scenarios × 2 agents = 4 results
    expect(output.results).toHaveLength(4);
    expect(output.summary.total).toBe(4);
    expect(output.summary.completed).toBe(4);
    expect(output.summary.failed).toBe(0);
  });

  it("produces results with correct agent names", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const agentNames = [...new Set(output.results.map((r) => r.agentName))].sort();
    expect(agentNames).toEqual(["claude-code", "codex"]);
  });

  it("includes both scenario keys", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const scenarioKeys = [...new Set(output.results.map((r) => r.scenarioKey))].sort();
    expect(scenarioKeys).toEqual(["echo-test", "summarize-docs"]);
  });

  it("echo-test scenario has correct prompt and rubric", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const echoResults = output.results.filter((r) => r.scenarioKey === "echo-test");
    expect(echoResults).toHaveLength(2);
    for (const result of echoResults) {
      expect(result.scenarioName).toBe("Largest English word");
      expect(result.prompt).toContain("largest word in the English language");
      expect(result.rubric).toBeInstanceOf(Array);
      expect(result.rubric).toHaveLength(2);
    }
  });

  it("summarize-docs scenario has correct prompt and rubric", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const docResults = output.results.filter((r) => r.scenarioKey === "summarize-docs");
    expect(docResults).toHaveLength(2);
    for (const result of docResults) {
      expect(result.scenarioName).toBe("Summarize async workloads docs");
      expect(result.prompt).toContain("https://docs.netlify.com/build/async-workloads/overview/");
      expect(result.rubric).toBeInstanceOf(Array);
      expect(result.rubric).toHaveLength(4);
    }
  });

  it("preserves adapter type in agentConfig", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const byAgent = Object.fromEntries(output.results.map((r) => [r.agentName, r]));
    expect(byAgent["claude-code"].agentConfig.adapter).toBe("claude-code");
    expect(byAgent["codex"].agentConfig.adapter).toBe("codex");
  });

  it("filters to single agent from mixed config", async () => {
    const output = await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
      agentFilter: ["codex"],
    });

    // 2 scenarios × 1 agent = 2 results
    expect(output.results).toHaveLength(2);
    expect(output.results.every((r) => r.agentName === "codex")).toBe(true);
  });

  it("calls each adapter once per scenario", async () => {
    const adapters = setupAdapters();

    await run({
      configPath: path.join(KITCHEN_SINK_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    // Each adapter runs 2 scenarios
    expect(adapters["claude-code"].run).toHaveBeenCalledTimes(2);
    expect(adapters["codex"].run).toHaveBeenCalledTimes(2);
  });
});
