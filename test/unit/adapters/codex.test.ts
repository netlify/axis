import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodexAdapter } from "../../../src/adapters/codex.js";
import type { AgentAdapter } from "../../../src/types/agent.js";
import type { AgentInput } from "../../../src/types/agent.js";
import { EventEmitter, Readable } from "node:stream";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock resolve so adapters skip the real CLI check
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "codex", prefixArgs: [] }),
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
    config: { agent: "codex" },
    scenario: {
      key: "test",
      name: "Test",
      prompt,
      judge: [{ check: "test", weight: 1.0 }],
    },
    workingDirectory: "/tmp",
  };
}

describe("CodexAdapter", () => {
  let adapter: AgentAdapter;

  beforeEach(() => {
    adapter = createCodexAdapter();
    vi.clearAllMocks();

    mockSpawn.mockImplementation((() => createMockProcess([])) as any);
  });

  it("has name 'codex'", () => {
    expect(adapter.name).toBe("codex");
  });

  it("provides isolation env with CODEX_HOME under home, not workspace", () => {
    const env = adapter.isolationEnv!({ workspace: "/tmp/work", home: "/tmp/home" });
    expect(env.CODEX_HOME).toBe("/tmp/home/.codex");
    expect(env.CODEX_DISABLE_TELEMETRY).toBe("1");
  });

  it("extracts agent_message as result from NDJSON stream", async () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "abc-123" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "The answer is 42." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 500, output_tokens: 100, cached_input_tokens: 200 },
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("The answer is 42.");
    expect(output.metadata.exitCode).toBe(0);
    expect(output.metadata.tokenUsage?.input).toBe(500);
    expect(output.metadata.tokenUsage?.output).toBe(100);
    expect(output.metadata.tokenUsage?.cacheReadInput).toBe(200);
  });

  it("maps command_execution items to tool_use/tool_result transcript entries", async () => {
    const events = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.started",
        item: { id: "item_1", type: "command_execution", command: "ls -la", status: "in_progress" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls -la",
          status: "completed",
          output: "file1.txt\nfile2.txt",
        },
      }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(3);
    expect(output.transcript[0].type).toBe("tool_use");
    expect(output.transcript[0].content).toMatchObject({ type: "command_execution", command: "ls -la" });
    expect(output.transcript[1].type).toBe("tool_result");
    expect(output.transcript[2].type).toBe("assistant");
    expect(output.transcript[2].content).toMatchObject({ type: "agent_message", text: "Done." });
  });

  it("maps reasoning items to assistant transcript entries", async () => {
    const events = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "Let me think..." } }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "Here's the answer." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript[0].type).toBe("assistant");
    expect(output.transcript[0].content).toMatchObject({ type: "reasoning" });
    expect(output.transcript[1].type).toBe("assistant");
  });

  it("records error events in transcript", async () => {
    const events = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "something went wrong" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 0 } }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(1);
    expect(output.transcript[0].type).toBe("error");
  });

  it("records turn.failed as error in transcript", async () => {
    const events = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.failed", error: "rate limit exceeded" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events, 1)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(1);
    expect(output.transcript[0].type).toBe("error");
  });

  it("handles non-zero exit with no result message", async () => {
    mockSpawn.mockImplementation((() => createMockProcess([], 1)) as any);

    const output = await adapter.run(makeInput());

    expect(output.metadata.exitCode).toBe(1);
    expect(output.result).toBeNull();
  });

  it("includes --full-auto by default", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ]);
    }) as any);

    await adapter.run(makeInput());

    expect(capturedArgs).toContain("exec");
    expect(capturedArgs).toContain("--json");
    expect(capturedArgs).toContain("--full-auto");
  });

  it("omits --full-auto when explicitly set to false", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.flags = { "full-auto": false };
    await adapter.run(input);

    expect(capturedArgs).not.toContain("--full-auto");
  });

  it("passes --model flag when config specifies model", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.model = "o4-mini";
    await adapter.run(input);

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("o4-mini");
  });

  it("passes through additional flags from config", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ]);
    }) as any);

    const input = makeInput();
    input.config.flags = {
      sandbox: "read-only",
      ephemeral: true,
      color: false,
    };
    await adapter.run(input);

    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs).toContain("read-only");
    expect(capturedArgs).toContain("--ephemeral");
    expect(capturedArgs).not.toContain("--color");
  });

  it("puts prompt as last positional argument after exec --json", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ]);
    }) as any);

    await adapter.run(makeInput("do the thing"));

    expect(capturedArgs[0]).toBe("exec");
    expect(capturedArgs[1]).toBe("--json");
    expect(capturedArgs[capturedArgs.length - 1]).toBe("do the thing");
  });

  it("uses last agent_message when multiple are emitted", async () => {
    const events = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First message." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final message." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Final message.");
    expect(output.transcript.filter((e) => e.type === "assistant")).toHaveLength(2);
  });

  it("requires CODEX_API_KEY environment variable", () => {
    expect(adapter.requiredEnv!()).toEqual(["CODEX_API_KEY"]);
  });

  it("maps file_changes and web_search to tool entries", async () => {
    const events = [
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "file_changes", status: "in_progress" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "file_changes", files: ["src/main.ts"] } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "web_search", query: "how to fix" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(events)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript[0].type).toBe("tool_use");
    expect(output.transcript[1].type).toBe("tool_result");
    expect(output.transcript[1].content).toMatchObject({ type: "file_changes" });
    expect(output.transcript[2].type).toBe("tool_result");
    expect(output.transcript[2].content).toMatchObject({ type: "web_search" });
  });

  it("captures raw output when captureRawOutput is true", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
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
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
      ])) as any);

    const output = await adapter.run(makeInput());

    expect(output.rawOutput).toBeUndefined();
  });
});
