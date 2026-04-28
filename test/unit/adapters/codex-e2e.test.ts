import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { EventEmitter, Readable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/codex");

// Mock spawn, lifecycle, and resolve
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "codex", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
import { run } from "../../../src/runner/runner.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess(lines: string[], exitCode = 0) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { end: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  setTimeout(() => {
    for (const line of lines) {
      stdout.push(line + "\n");
    }
    stdout.push(null);
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

const CODEX_EVENTS = [
  JSON.stringify({ type: "thread.started", thread_id: "mock-001" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "echo hello", status: "in_progress" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "echo hello", status: "completed", output: "hello" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "Hello from AXIS Codex adapter" },
  }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 150, output_tokens: 42, cached_input_tokens: 100 } }),
];

describe("Codex adapter e2e", () => {
  const origCodexKey = process.env.CODEX_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set a fake key so the runner's requiredEnv validation passes
    process.env.CODEX_API_KEY = "test-key";

    mockSpawn.mockImplementation((() => createMockProcess(CODEX_EVENTS)) as any);
  });

  afterEach(() => {
    if (origCodexKey !== undefined) {
      process.env.CODEX_API_KEY = origCodexKey;
    } else {
      delete process.env.CODEX_API_KEY;
    }
  });

  it("runs scenario through NDJSON parsing pipeline", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results).toHaveLength(1);

    const result = output.results[0];
    expect(result.agentName).toBe("codex");
    expect(result.scenarioKey).toBe("echo-test");
    expect(result.output.metadata.exitCode).toBe(0);
    expect(result.output.result).toBe("Hello from AXIS Codex adapter");
  });

  it("captures token usage from turn.completed events", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results[0].output.metadata.tokenUsage).toEqual({
      input: 150,
      output: 42,
      cacheReadInput: 100,
    });
  });

  it("maps command_execution to tool_use/tool_result transcript entries", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const transcript = output.results[0].output.transcript;

    expect(transcript).toHaveLength(3);
    expect(transcript[0].type).toBe("tool_use");
    expect(transcript[0].content).toMatchObject({ type: "command_execution", command: "echo hello" });
    expect(transcript[1].type).toBe("tool_result");
    expect(transcript[2].type).toBe("assistant");
    expect(transcript[2].content).toMatchObject({ type: "agent_message", text: "Hello from AXIS Codex adapter" });
  });

  it("runs full pipeline: config → runner → codex adapter → result", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.version).toBe("0.1.0");
    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.results[0].agentConfig.adapter).toBe("codex");
  });
});
