import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiAdapter } from "../../../src/adapters/gemini.js";
import type { AgentAdapter, AgentInput } from "../../../src/types/agent.js";
import { EventEmitter, Readable } from "node:stream";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock resolve so adapters skip the real CLI check
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "gemini", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
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

function makeInput(prompt = "test prompt"): AgentInput {
  return {
    prompt,
    config: { agent: "gemini" },
    scenario: {
      key: "test",
      name: "Test",
      prompt,
      rubric: [{ check: "test", weight: 1.0 }],
    },
    workingDirectory: "/tmp",
  };
}

describe("GeminiAdapter", () => {
  let adapter: AgentAdapter;

  beforeEach(() => {
    adapter = createGeminiAdapter();
    vi.clearAllMocks();

    mockSpawn.mockImplementation((() => createMockProcess([])) as any);
  });

  it("has name 'gemini'", () => {
    expect(adapter.name).toBe("gemini");
  });

  it("requires GEMINI_API_KEY environment variable", () => {
    expect(adapter.requiredEnv!()).toEqual(["GEMINI_API_KEY"]);
  });

  it("provides isolation env with GEMINI_CLI_HOME", () => {
    const env = adapter.isolationEnv!("/tmp/workspace");
    expect(env.GEMINI_CLI_HOME).toBe("/tmp/workspace/.gemini");
    expect(env.GEMINI_TELEMETRY_ENABLED).toBe("false");
  });

  it("extracts assistant message as result from NDJSON stream", async () => {
    const events = [
      JSON.stringify({
        type: "init",
        session_id: "sess-001",
        model: "gemini-2.5-flash",
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "The answer is 42.",
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 500, output_tokens: 100 },
        timestamp: "2025-01-01T00:00:02Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("The answer is 42.");
    expect(output.metadata.exitCode).toBe(0);
    expect(output.metadata.sessionId).toBe("sess-001");
  });

  it("extracts token usage from result event", async () => {
    const events = [
      JSON.stringify({ type: "message", role: "assistant", content: "Done.", timestamp: "2025-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 300, output_tokens: 75 },
        timestamp: "2025-01-01T00:00:01Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.metadata.tokenUsage?.input).toBe(300);
    expect(output.metadata.tokenUsage?.output).toBe(75);
  });

  it("maps tool_use events to tool_use transcript entries", async () => {
    const events = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "Bash",
        tool_id: "bash-123",
        parameters: { command: "ls -la" },
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "tool_result",
        tool_id: "bash-123",
        status: "success",
        output: "file1.txt",
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Found files.",
        timestamp: "2025-01-01T00:00:02Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 100, output_tokens: 50 },
        timestamp: "2025-01-01T00:00:03Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(3);
    expect(output.transcript[0].type).toBe("tool_use");
    expect(output.transcript[0].content).toMatchObject({ tool_name: "Bash", tool_id: "bash-123" });
    expect(output.transcript[1].type).toBe("tool_result");
    expect(output.transcript[1].content).toMatchObject({ tool_id: "bash-123", status: "success" });
    expect(output.transcript[2].type).toBe("assistant");
  });

  it("records error events in transcript", async () => {
    const events = [
      JSON.stringify({
        type: "error",
        severity: "error",
        message: "something went wrong",
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "result",
        status: "error",
        error: { type: "api", message: "Quota exceeded" },
        timestamp: "2025-01-01T00:00:01Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events, 1)) as any);

    const output = await adapter.run(makeInput());

    // Both the error event and the error result produce transcript entries
    expect(output.transcript).toHaveLength(2);
    expect(output.transcript[0].type).toBe("error");
    expect(output.transcript[0].content).toMatchObject({ severity: "error", message: "something went wrong" });
    expect(output.transcript[1].type).toBe("error");
    expect(output.transcript[1].content).toMatchObject({ status: "error" });
    // Clean error message from result event used as metadata error
    expect((output.metadata as any).error).toBe("Quota exceeded");
  });

  it("handles non-zero exit with no result message", async () => {
    mockSpawn.mockImplementation((() => createMockProcess([], 1)) as any);

    const output = await adapter.run(makeInput());

    expect(output.metadata.exitCode).toBe(1);
    expect(output.result).toBeNull();
  });

  it("includes --yolo by default", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "message", role: "assistant", content: "ok", timestamp: "2025-01-01T00:00:00Z" }),
      ]);
    }) as any);

    await adapter.run(makeInput());

    expect(capturedArgs).toContain("--yolo");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs).toContain("stream-json");
  });

  it("omits --yolo when explicitly set to false", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "message", role: "assistant", content: "ok", timestamp: "2025-01-01T00:00:00Z" }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.flags = { yolo: false };
    await adapter.run(input);

    expect(capturedArgs).not.toContain("--yolo");
  });

  it("passes --model flag when config specifies model", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "message", role: "assistant", content: "ok", timestamp: "2025-01-01T00:00:00Z" }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.model = "gemini-2.5-pro";
    await adapter.run(input);

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("gemini-2.5-pro");
  });

  it("passes through additional flags from config", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "message", role: "assistant", content: "ok", timestamp: "2025-01-01T00:00:00Z" }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.flags = {
      sandbox: "docker",
      debug: true,
      "raw-output": false,
    };
    await adapter.run(input);

    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs).toContain("docker");
    expect(capturedArgs).toContain("--debug");
    expect(capturedArgs).not.toContain("--raw-output");
  });

  it("puts prompt with -p flag", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "message", role: "assistant", content: "ok", timestamp: "2025-01-01T00:00:00Z" }),
      ]);
    }) as any);

    await adapter.run(makeInput("do the thing"));

    expect(capturedArgs[0]).toBe("-p");
    expect(capturedArgs[1]).toBe("do the thing");
  });

  it("uses last assistant message when multiple are emitted", async () => {
    const events = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "First message.",
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Final message.",
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 100, output_tokens: 50 },
        timestamp: "2025-01-01T00:00:02Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Final message.");
    expect(output.transcript.filter((e) => e.type === "assistant")).toHaveLength(2);
  });

  it("accumulates delta messages into a single transcript entry", async () => {
    const events = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Hello ",
        delta: true,
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "world!",
        delta: true,
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 100, output_tokens: 50 },
        timestamp: "2025-01-01T00:00:02Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Hello world!");
    expect(output.transcript).toHaveLength(1);
    expect(output.transcript[0].type).toBe("assistant");
    expect(output.transcript[0].content).toMatchObject({
      role: "assistant",
      content: "Hello world!",
    });
    // Uses timestamp from first delta in the sequence
    expect(output.transcript[0].timestamp).toBe("2025-01-01T00:00:00Z");
  });

  it("flushes deltas when a non-delta event arrives", async () => {
    const events = [
      // First assistant turn (deltas)
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Let me ",
        delta: true,
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "check that.",
        delta: true,
        timestamp: "2025-01-01T00:00:01Z",
      }),
      // Tool use flushes the accumulated deltas
      JSON.stringify({
        type: "tool_use",
        tool_name: "Bash",
        tool_id: "t1",
        parameters: { command: "ls" },
        timestamp: "2025-01-01T00:00:02Z",
      }),
      JSON.stringify({
        type: "tool_result",
        tool_id: "t1",
        status: "success",
        output: "file.txt",
        timestamp: "2025-01-01T00:00:03Z",
      }),
      // Second assistant turn (deltas)
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Found ",
        delta: true,
        timestamp: "2025-01-01T00:00:04Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "the file.",
        delta: true,
        timestamp: "2025-01-01T00:00:05Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 200, output_tokens: 80 },
        timestamp: "2025-01-01T00:00:06Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    // Result is the complete last assistant turn
    expect(output.result).toBe("Found the file.");

    // Transcript: assistant, tool_use, tool_result, assistant (4, not 6+)
    expect(output.transcript).toHaveLength(4);
    expect(output.transcript[0].type).toBe("assistant");
    expect(output.transcript[0].content).toMatchObject({ content: "Let me check that." });
    expect(output.transcript[1].type).toBe("tool_use");
    expect(output.transcript[2].type).toBe("tool_result");
    expect(output.transcript[3].type).toBe("assistant");
    expect(output.transcript[3].content).toMatchObject({ content: "Found the file." });
  });

  it("handles mix of delta and non-delta assistant messages", async () => {
    const events = [
      // Non-delta complete message
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "First complete.",
        timestamp: "2025-01-01T00:00:00Z",
      }),
      // Delta messages
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Second ",
        delta: true,
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "part.",
        delta: true,
        timestamp: "2025-01-01T00:00:02Z",
      }),
      JSON.stringify({ type: "result", status: "success", timestamp: "2025-01-01T00:00:03Z" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Second part.");
    expect(output.transcript).toHaveLength(2);
    expect(output.transcript[0].content).toMatchObject({ content: "First complete." });
    expect(output.transcript[1].content).toMatchObject({ content: "Second part." });
  });

  it("maps user messages to tool_result transcript entries", async () => {
    const events = [
      JSON.stringify({ type: "message", role: "user", content: "tool output here", timestamp: "2025-01-01T00:00:00Z" }),
      JSON.stringify({ type: "message", role: "assistant", content: "Got it.", timestamp: "2025-01-01T00:00:01Z" }),
      JSON.stringify({ type: "result", status: "success", timestamp: "2025-01-01T00:00:02Z" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript[0].type).toBe("tool_result");
    expect(output.transcript[0].content).toMatchObject({ role: "user" });
    expect(output.transcript[1].type).toBe("assistant");
  });

  it("preserves event timestamps in transcript entries", async () => {
    const events = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "Bash",
        tool_id: "t1",
        parameters: {},
        timestamp: "2025-06-15T10:30:00Z",
      }),
      JSON.stringify({ type: "message", role: "assistant", content: "Done.", timestamp: "2025-06-15T10:30:05Z" }),
      JSON.stringify({ type: "result", status: "success", timestamp: "2025-06-15T10:30:06Z" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript[0].timestamp).toBe("2025-06-15T10:30:00Z");
    expect(output.transcript[1].timestamp).toBe("2025-06-15T10:30:05Z");
  });

  it("captures raw output when captureRawOutput is true", async () => {
    const lines = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Hello ",
        delta: true,
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "world!",
        delta: true,
        timestamp: "2025-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { input_tokens: 10, output_tokens: 5 },
        timestamp: "2025-01-01T00:00:02Z",
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(lines)) as any);

    const input = makeInput();
    input.captureRawOutput = true;
    const output = await adapter.run(input);

    expect(output.rawOutput).toEqual(lines);
  });

  it("does not capture raw output by default", async () => {
    mockSpawn.mockImplementation((() =>
      createMockProcess([
        JSON.stringify({ type: "result", status: "success", timestamp: "2025-01-01T00:00:00Z" }),
      ])) as any);

    const output = await adapter.run(makeInput());

    expect(output.rawOutput).toBeUndefined();
  });
});
