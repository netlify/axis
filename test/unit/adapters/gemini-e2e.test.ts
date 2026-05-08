import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { EventEmitter, Readable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/gemini");

// Mock spawn, lifecycle, and resolve
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "gemini", prefixArgs: [] }),
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

const GEMINI_EVENTS = [
  JSON.stringify({
    type: "init",
    session_id: "sess-gemini-001",
    model: "gemini-2.5-flash",
    timestamp: "2025-01-01T00:00:00Z",
  }),
  // Gemini streams assistant messages as deltas
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Let me ",
    delta: true,
    timestamp: "2025-01-01T00:00:00.5Z",
  }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "run that.",
    delta: true,
    timestamp: "2025-01-01T00:00:00.6Z",
  }),
  JSON.stringify({
    type: "tool_use",
    tool_name: "Bash",
    tool_id: "bash-001",
    parameters: { command: "echo hello" },
    timestamp: "2025-01-01T00:00:01Z",
  }),
  JSON.stringify({
    type: "tool_result",
    tool_id: "bash-001",
    status: "success",
    output: "hello",
    timestamp: "2025-01-01T00:00:02Z",
  }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Hello from AXIS ",
    delta: true,
    timestamp: "2025-01-01T00:00:03Z",
  }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Gemini adapter",
    delta: true,
    timestamp: "2025-01-01T00:00:03.5Z",
  }),
  JSON.stringify({
    type: "result",
    status: "success",
    stats: { input_tokens: 200, output_tokens: 60 },
    timestamp: "2025-01-01T00:00:04Z",
  }),
];

describe("Gemini adapter e2e", () => {
  const origGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set a fake key so the runner's requiredEnv validation passes
    process.env.GEMINI_API_KEY = "test-key";

    mockSpawn.mockImplementation((() => createMockProcess(GEMINI_EVENTS)) as any);
  });

  afterEach(() => {
    if (origGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = origGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("runs scenario through NDJSON parsing pipeline", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results).toHaveLength(1);

    const result = output.results[0];
    expect(result.agentName).toBe("gemini");
    expect(result.scenarioKey).toBe("echo-test");
    expect(result.output.metadata.exitCode).toBe(0);
    expect(result.output.result).toBe("Hello from AXIS Gemini adapter");
  });

  it("captures token usage from result event", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results[0].output.metadata.tokenUsage).toEqual({
      input: 200,
      output: 60,
    });
  });

  it("captures session ID from init event", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results[0].output.metadata.sessionId).toBe("sess-gemini-001");
  });

  it("maps tool_use and tool_result to transcript entries with consolidated deltas", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    const transcript = output.results[0].output.transcript;

    // assistant (consolidated deltas) + tool_use + tool_result + assistant (consolidated deltas)
    expect(transcript).toHaveLength(4);
    expect(transcript[0].type).toBe("assistant");
    expect(transcript[0].content).toMatchObject({ content: "Let me run that." });
    expect(transcript[1].type).toBe("tool_use");
    expect(transcript[1].content).toMatchObject({ tool_name: "Bash", tool_id: "bash-001" });
    expect(transcript[2].type).toBe("tool_result");
    expect(transcript[2].content).toMatchObject({ tool_id: "bash-001", status: "success" });
    expect(transcript[3].type).toBe("assistant");
    expect(transcript[3].content).toMatchObject({ content: "Hello from AXIS Gemini adapter" });
  });

  it("runs full pipeline: config → runner → gemini adapter → result", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.version).toBe("0.1.0");
    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.results[0].agentConfig.agent).toBe("gemini");
  });
});
