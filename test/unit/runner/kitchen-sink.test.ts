import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
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
import { setCloneImplForTests } from "../../../src/config/remote-scenarios.js";

const mockGetAdapter = vi.mocked(getAdapter);

const KITCHEN_SINK_FIXTURE = path.resolve(import.meta.dirname, "../../e2e/kitchen-sink");

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
  let restoreClone: () => void;
  let tmpFixtureDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CODEX_API_KEY = "test-key";
    setupAdapters();

    // Copy the kitchen-sink fixture to a tempdir so the remote-scenarios
    // writes to `<configDir>/.axis/remotes/` don't leak back into the
    // repo-tracked fixture. (A stale stub clone there would be picked up by
    // subsequent real `axis run` invocations from the fixture and show 0
    // remote scenarios.)
    tmpFixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "axis-kitchen-"));
    await fsp.cp(KITCHEN_SINK_FIXTURE, tmpFixtureDir, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.axis${path.sep}`),
    });
    configPath = path.join(tmpFixtureDir, "axis.config.json");

    // Stub the clone to inject a minimal config that contributes 0 scenarios
    // so this test stays hermetic.
    restoreClone = setCloneImplForTests((_url, target) => {
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
      fs.writeFileSync(path.join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(
        path.join(target, "axis.config.json"),
        JSON.stringify({ scenarios: [], agents: ["mock-agent"] }),
      );
    });
  });

  afterEach(async () => {
    restoreClone();
    if (origCodexKey !== undefined) {
      process.env.CODEX_API_KEY = origCodexKey;
    } else {
      delete process.env.CODEX_API_KEY;
    }
    if (tmpFixtureDir) {
      await fsp.rm(tmpFixtureDir, { recursive: true, force: true });
    }
  });

  it("runs active scenarios across all agent instances (skipped excluded)", async () => {
    const output = await run({
      configPath,
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
      configPath,
      logger: silentLogger,
    });

    const agentNames = [...new Set(output.results.map((r) => r.agentName))].sort();
    expect(agentNames).toEqual(["claude-code|claude-opus-4-6", "claude-code|claude-sonnet-4-6", "codex"]);
  });

  it("includes only active scenario keys", async () => {
    const output = await run({
      configPath,
      logger: silentLogger,
    });

    const scenarioKeys = [...new Set(output.results.map((r) => r.scenarioKey))].sort();
    expect(scenarioKeys).toEqual(["echo-test"]);
  });

  it("echo-test scenario has correct prompt and judge", async () => {
    const output = await run({
      configPath,
      logger: silentLogger,
    });

    const echoResults = output.results.filter((r) => r.scenarioKey === "echo-test");
    expect(echoResults).toHaveLength(3);
    for (const result of echoResults) {
      expect(result.scenarioName).toBe("Largest English word");
      expect(result.prompt).toContain("largest word in the English language");
      expect(result.judge).toBeInstanceOf(Array);
      expect(result.judge).toHaveLength(2);
    }
  });

  it("preserves agent type in agentConfig", async () => {
    const output = await run({
      configPath,
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
      configPath,
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
      configPath,
      logger: silentLogger,
    });

    // claude-code is registered twice (sonnet + opus instances), codex once.
    expect(adapters["claude-code"].run).toHaveBeenCalledTimes(2);
    expect(adapters["codex"].run).toHaveBeenCalledTimes(1);
  });
});
