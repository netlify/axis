import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, Readable, Writable } from "node:stream";
import type { AgentAdapter, AgentInput } from "../../../src/types/agent.js";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockInitialize, mockNewSession, mockPrompt, acpState } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue({}),
  mockNewSession: vi.fn().mockResolvedValue({ sessionId: "sess-acp-001" }),
  mockPrompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
  acpState: {
    capturedClientFactory: null as ((agent: any) => any) | null,
    capturedClient: null as any,
  },
}));

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// Mock resolve so adapters skip the real CLI check
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "goose", prefixArgs: [] }),
}));

// ---------------------------------------------------------------------------
// Mock @agentclientprotocol/sdk
// ---------------------------------------------------------------------------
vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn().mockReturnValue({ readable: {}, writable: {} }),
  ClientSideConnection: vi.fn().mockImplementation((clientFactory: any) => {
    acpState.capturedClientFactory = clientFactory;
    acpState.capturedClient = clientFactory({});
    return {
      initialize: mockInitialize,
      newSession: mockNewSession,
      prompt: mockPrompt,
    };
  }),
}));

import { spawn } from "node:child_process";
import { createAcpBasedAdapter } from "../../../src/adapters/base/acp-adapter.js";

const mockSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcess(exitCode = 0, delay = 10) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinStream = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: stdinStream,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });

  setTimeout(() => {
    stdout.push(null);
    stderr.push(null);
    proc.exitCode = exitCode;
    proc.emit("close", exitCode);
  }, delay);

  return proc;
}

function makeInput(prompt = "test prompt"): AgentInput {
  return {
    prompt,
    config: { agent: "goose" },
    scenario: {
      key: "test",
      name: "Test",
      prompt,
      judge: [{ check: "test", weight: 1.0 }],
    },
    workingDirectory: "/tmp/test-workspace",
  };
}

/** Simulate ACP session updates by calling the captured client's sessionUpdate. */
async function sendUpdate(update: Record<string, unknown>) {
  if (!acpState.capturedClient) throw new Error("Client not captured — did spawn run?");
  await acpState.capturedClient.sessionUpdate({ update });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAcpBasedAdapter", () => {
  let adapter: AgentAdapter;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    acpState.capturedClientFactory = null;
    acpState.capturedClient = null;

    // Never let the adapter's process-group teardown signal the real OS during
    // unit tests — the mock child's pid would otherwise be passed to the real
    // `process.kill(-pid, …)`. Asserting on it is also handy.
    processKillSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    // Reset mock return values
    mockInitialize.mockResolvedValue({});
    mockNewSession.mockResolvedValue({ sessionId: "sess-acp-001" });
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    mockSpawn.mockImplementation((() => createMockProcess()) as any);

    adapter = createAcpBasedAdapter({
      name: "test-acp",
      cliCommand: "goose",
      buildArgs: () => ["acp"],
    });
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    vi.useRealTimers();
  });

  it("has the correct adapter name", () => {
    expect(adapter.name).toBe("test-acp");
  });

  it("exposes requiredEnv from spec", () => {
    const a = createAcpBasedAdapter({
      name: "test",
      requiredEnv: () => ["MY_API_KEY"],
    });
    expect(a.requiredEnv!()).toEqual(["MY_API_KEY"]);
  });

  it("exposes isolationEnv from spec", () => {
    const a = createAcpBasedAdapter({
      name: "test",
      isolationEnv: ({ home }) => ({ TEST_HOME: `${home}/.test` }),
    });
    expect(a.isolationEnv!({ workspace: "/tmp/ws", home: "/tmp/home" })).toEqual({
      TEST_HOME: "/tmp/home/.test",
    });
  });

  it("spawns the resolved CLI command with args", async () => {
    // Configure prompt to invoke session updates before resolving
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      });
      return { stopReason: "end_turn" };
    });

    await adapter.run(makeInput());

    expect(mockSpawn).toHaveBeenCalledWith(
      "goose",
      ["acp"],
      expect.objectContaining({
        cwd: "/tmp/test-workspace",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("throws when no command is available", async () => {
    const a = createAcpBasedAdapter({ name: "no-cmd" });
    await expect(a.run(makeInput())).rejects.toThrow('The "no-cmd" adapter has no command to spawn.');
  });

  it("calls ACP lifecycle: initialize → newSession → prompt", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    await adapter.run(makeInput());

    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 1,
        clientInfo: expect.objectContaining({ name: "axis" }),
      }),
    );
    expect(mockNewSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/test-workspace" }));
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-acp-001",
        prompt: [{ type: "text", text: "test prompt" }],
      }),
    );
  });

  it("maps agent_message_chunk to assistant transcript entry", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      });
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world!" },
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Hello world!");
    expect(output.transcript).toHaveLength(2);
    expect(output.transcript[0].type).toBe("user");
    expect(output.transcript[0].content).toMatchObject({ content: "test prompt" });
    expect(output.transcript[1].type).toBe("assistant");
    expect(output.transcript[1].content).toMatchObject({
      content: "Hello world!",
      text: "Hello world!",
    });
  });

  it("flushes message chunks when a tool_call arrives", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Let me check." },
      });
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "ReadFile",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "/tmp/file.txt" },
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(3);
    expect(output.transcript[0].type).toBe("user");
    expect(output.transcript[1].type).toBe("assistant");
    expect(output.transcript[1].content).toMatchObject({ content: "Let me check." });
    expect(output.transcript[2].type).toBe("tool_use");
    expect(output.transcript[2].content).toMatchObject({
      tool_name: "ReadFile",
      tool_id: "tc-1",
      kind: "read",
      parameters: { path: "/tmp/file.txt" },
    });
  });

  it("maps tool_call to tool_use entry with correct fields", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-bash",
        title: "Bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls -la" },
        locations: [{ uri: "file:///tmp/test" }],
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    const entry = output.transcript[1];
    expect(entry.type).toBe("tool_use");
    expect(entry.content).toMatchObject({
      tool_name: "Bash",
      tool_id: "tc-bash",
      kind: "execute",
      parameters: { command: "ls -la" },
      locations: [{ uri: "file:///tmp/test" }],
    });
  });

  it("maps completed tool_call_update to tool_result entry", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "ReadFile",
        kind: "read",
        status: "in_progress",
      });
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: "file contents here",
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(3);
    expect(output.transcript[2].type).toBe("tool_result");
    expect(output.transcript[2].content).toMatchObject({
      tool_id: "tc-1",
      output: "file contents here",
      name: "ReadFile",
      kind: "read",
    });
  });

  it("maps failed tool_call_update to error entry", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-fail",
        title: "WriteFile",
        kind: "edit",
        status: "in_progress",
      });
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-fail",
        status: "failed",
        rawOutput: "Permission denied",
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(3);
    expect(output.transcript[2].type).toBe("error");
    expect(output.transcript[2].content).toMatchObject({
      error: "Tool failed: WriteFile",
      tool_id: "tc-fail",
      output: "Permission denied",
      kind: "edit",
    });
  });

  it("maps plan updates to system entries", async () => {
    const planEntries = [
      { title: "Step 1", description: "Do the thing" },
      { title: "Step 2", description: "Verify it worked" },
    ];

    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "plan",
        entries: planEntries,
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(2);
    expect(output.transcript[1].type).toBe("system");
    expect(output.transcript[1].content).toMatchObject({
      type: "plan",
      entries: planEntries,
    });
  });

  it("auto-approves permission requests with allow_always", async () => {
    // Run adapter to capture client
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });
    await adapter.run(makeInput());

    expect(acpState.capturedClient).not.toBeNull();
    const result = await acpState.capturedClient.requestPermission({
      options: [
        { kind: "reject_once", optionId: "reject", name: "Reject" },
        { kind: "allow_always", optionId: "allow", name: "Allow" },
      ],
    });

    expect(result.outcome.outcome).toBe("selected");
    expect(result.outcome.optionId).toBe("allow");
  });

  it("falls back to first option if no allow_always", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });
    await adapter.run(makeInput());

    const result = await acpState.capturedClient.requestPermission({
      options: [
        { kind: "allow_once", optionId: "once", name: "Allow Once" },
        { kind: "reject_once", optionId: "reject", name: "Reject" },
      ],
    });

    expect(result.outcome.optionId).toBe("once");
  });

  it("extracts token usage from PromptResponse", async () => {
    mockPrompt.mockResolvedValue({
      stopReason: "end_turn",
      usage: { inputTokens: 500, outputTokens: 150, cachedReadTokens: 100 },
    });

    const output = await adapter.run(makeInput());

    expect(output.metadata.tokenUsage).toEqual({
      input: 500,
      output: 150,
      cacheReadInput: 100,
    });
  });

  it("stores sessionId in metadata", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "my-session-123" });
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.sessionId).toBe("my-session-123");
  });

  it("sets error for cancelled stop reason", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "cancelled" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Agent cancelled");
  });

  it("sets error for max_tokens stop reason", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "max_tokens" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Agent hit max tokens limit");
  });

  it("sets error for refusal stop reason", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "refusal" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Agent refused to continue");
  });

  it("sets error for max_turn_requests stop reason", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "max_turn_requests" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Agent exceeded max turn requests");
  });

  it("captures raw output when captureRawOutput is true", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi" },
      });
      return { stopReason: "end_turn" };
    });

    const input = makeInput();
    input.captureRawOutput = true;
    const output = await adapter.run(input);

    expect(output.rawOutput).toBeDefined();
    expect(output.rawOutput!.length).toBeGreaterThan(0);

    // Raw output now includes ACP lifecycle events before session updates
    const types = output.rawOutput!.map((line) => {
      const obj = JSON.parse(line);
      return obj.type ?? obj.sessionUpdate;
    });
    expect(types).toContain("initialize_result");
    expect(types).toContain("session_result");
    expect(types).toContain("prompt");
    expect(types).toContain("agent_message_chunk");
    expect(types).toContain("prompt_result");
  });

  it("does not capture raw output by default", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });
    const output = await adapter.run(makeInput());
    expect(output.rawOutput).toBeUndefined();
  });

  it("passes MCP servers through to session/new", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const input = makeInput();
    input.mcpServers = {
      "my-server": {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "abc" },
      },
    };

    await adapter.run(input);

    expect(mockNewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          {
            name: "my-server",
            command: "node",
            args: ["server.js"],
            env: [{ name: "TOKEN", value: "abc" }],
          },
        ],
      }),
    );
  });

  it("converts HTTP MCP servers correctly", async () => {
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const input = makeInput();
    input.mcpServers = {
      "http-server": {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer xyz" },
      },
    };

    await adapter.run(input);

    expect(mockNewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          {
            type: "http",
            name: "http-server",
            url: "https://example.com/mcp",
            headers: [{ name: "Authorization", value: "Bearer xyz" }],
          },
        ],
      }),
    );
  });

  it("handles SDK errors gracefully", async () => {
    mockPrompt.mockRejectedValue(new Error("Connection lost"));

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Connection lost");
  });

  it("handles non-zero exit code with no result", async () => {
    mockSpawn.mockImplementation((() => createMockProcess(1)) as any);
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const output = await adapter.run(makeInput());

    expect(output.metadata.exitCode).toBe(1);
    expect(output.result).toBeNull();
  });

  it("calls prepare before spawning", async () => {
    const prepareFn = vi.fn();
    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const a = createAcpBasedAdapter({
      name: "prep-test",
      cliCommand: "goose",
      buildArgs: () => ["acp"],
      prepare: prepareFn,
    });

    await a.run(makeInput());

    expect(prepareFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/tmp/test-workspace",
      }),
    );
    // prepare is called before spawn
    expect(prepareFn.mock.invocationCallOrder[0]).toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it("handles tool_call_update with content blocks", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-read",
        title: "ReadFile",
        kind: "read",
        status: "in_progress",
      });
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-read",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "File contents here" },
          },
        ],
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    const resultEntry = output.transcript[2];
    expect(resultEntry.type).toBe("tool_result");
    expect(resultEntry.content.output).toBe("File contents here");
  });

  it("backfills parameters from intermediate tool_call_update", async () => {
    mockPrompt.mockImplementation(async () => {
      // Initial tool_call with empty rawInput (ACP bridge pattern)
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-fetch",
        title: "Fetch",
        kind: "fetch",
        status: "pending",
        rawInput: {},
      });
      // Intermediate update with actual parameters
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-fetch",
        rawInput: { url: "https://example.com", prompt: "Extract info" },
        title: "Fetch https://example.com",
      });
      // Completion
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-fetch",
        status: "completed",
        rawOutput: "Page content here",
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    // tool_use entry should have the backfilled parameters
    const toolUse = output.transcript.find((e) => e.type === "tool_use")!;
    expect(toolUse.content).toMatchObject({
      tool_name: "Fetch",
      tool_id: "tc-fetch",
      parameters: { url: "https://example.com", prompt: "Extract info" },
    });

    // tool_result should use the updated title from intermediate update
    const toolResult = output.transcript.find((e) => e.type === "tool_result")!;
    expect(toolResult.content).toMatchObject({
      name: "Fetch https://example.com",
    });
  });

  it("handles complete conversation flow", async () => {
    mockPrompt.mockImplementation(async () => {
      // Assistant speaks
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll read the file." },
      });
      // Tool call
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "ReadFile",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "README.md" },
      });
      // Tool result
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: "# My Project",
      });
      // Assistant responds
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The README contains a project header." },
      });
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 200, outputTokens: 80 },
      };
    });

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(5);
    expect(output.transcript[0].type).toBe("user");
    expect(output.transcript[0].content).toMatchObject({ content: "test prompt" });
    expect(output.transcript[1].type).toBe("assistant");
    expect(output.transcript[1].content).toMatchObject({ text: "I'll read the file." });
    expect(output.transcript[2].type).toBe("tool_use");
    expect(output.transcript[2].content).toMatchObject({ tool_name: "ReadFile" });
    expect(output.transcript[3].type).toBe("tool_result");
    expect(output.transcript[3].content).toMatchObject({ output: "# My Project" });
    expect(output.transcript[4].type).toBe("assistant");
    expect(output.transcript[4].content).toMatchObject({ text: "The README contains a project header." });

    expect(output.result).toBe("The README contains a project header.");
    expect(output.metadata.tokenUsage).toEqual({ input: 200, output: 80 });
    expect(output.metadata.exitCode).toBe(0);
  });

  it("ignores non-text content blocks in message chunks", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "base64data", mimeType: "image/png" },
      });
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "After image." },
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("After image.");
    expect(output.transcript).toHaveLength(2);
    expect(output.transcript[1].content).toMatchObject({ text: "After image." });
  });

  it("handles usage_update events", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "usage_update",
        used: 1500,
        size: 100000,
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    // usage_update sets input tokens
    expect(output.metadata.tokenUsage?.input).toBe(1500);
  });

  it("captures totalCostUsd from usage_update cost", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "usage_update",
        used: 2000,
        size: 200000,
        cost: { amount: 0.042, currency: "USD" },
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    expect(output.metadata.totalCostUsd).toBe(0.042);
  });

  it("uses last usage_update cost when multiple are sent", async () => {
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "usage_update",
        used: 1000,
        size: 200000,
        cost: { amount: 0.01, currency: "USD" },
      });
      await sendUpdate({
        sessionUpdate: "usage_update",
        used: 3000,
        size: 200000,
        cost: { amount: 0.035, currency: "USD" },
      });
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    // Last cumulative cost wins
    expect(output.metadata.totalCostUsd).toBe(0.035);
  });

  it("ends stdin and sends SIGTERM after the prompt completes", async () => {
    const endSpy = vi.fn();
    let killSpy: ReturnType<typeof vi.fn> = vi.fn();

    mockSpawn.mockImplementation((() => {
      const proc = createMockProcess();
      proc.stdin.end = endSpy as any;
      killSpy = proc.kill as ReturnType<typeof vi.fn>;
      return proc;
    }) as any);

    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });
    await adapter.run(makeInput());

    expect(endSpy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
  });

  it("schedules SIGKILL fallback when the agent ignores SIGTERM", async () => {
    vi.useFakeTimers();

    const killCalls: NodeJS.Signals[] = [];
    let proc: ReturnType<typeof createMockProcess>;

    mockSpawn.mockImplementation((() => {
      // Build a process that does NOT auto-close — simulates an ACP agent
      // that keeps the JSON-RPC channel alive after prompt_result.
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const stdinStream = new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin: stdinStream,
        kill: vi.fn((signal: NodeJS.Signals) => {
          killCalls.push(signal);
          // Only honor SIGKILL — SIGTERM is silently ignored
          if (signal === "SIGKILL") {
            queueMicrotask(() => proc.emit("close", 137));
          }
        }),
        pid: 12345,
        exitCode: null,
        signalCode: null,
      }) as any;
      return proc;
    }) as any);

    mockPrompt.mockResolvedValue({ stopReason: "end_turn" });

    const runPromise = adapter.run(makeInput());

    // Let the prompt resolve and the finally block run
    await vi.advanceTimersByTimeAsync(0);
    expect(killCalls).toEqual(["SIGTERM"]);

    // Advance past the SIGTERM → SIGKILL grace window
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    await runPromise;
    vi.useRealTimers();
  });

  it("measures durationMs from prompt call, not full process lifecycle", async () => {
    mockPrompt.mockImplementation(async () => {
      // Simulate some agent work time
      await new Promise((r) => setTimeout(r, 50));
      return { stopReason: "end_turn" };
    });

    const output = await adapter.run(makeInput());

    // durationMs should reflect prompt time (~50ms), not total wall-clock
    // which includes spawn + ACP handshake + process exit
    expect(output.metadata.durationMs).toBeGreaterThanOrEqual(40);
    // Should be well under 5s (generous bound to avoid flakiness)
    expect(output.metadata.durationMs).toBeLessThan(5000);
  });

  // -------------------------------------------------------------------------
  // Completion vs. timeout / abort racing the agent finishing.
  //
  // Regression coverage for Gemini runs that finished (terminal
  // prompt_result / end_turn) but were recorded as "Scenario time limit
  // reached" failures with a zeroed score and 0 tokens — because the CLI (or a
  // subprocess like `node --test`) lingered and the timeout/abort fired right
  // after the agent completed.
  // -------------------------------------------------------------------------

  /**
   * A mock process that stays alive until signalled. On kill it closes (after a
   * microtask), modelling a CLI that only dies when we tear it down. `onKill`
   * lets a test break the ACP connection (reject the in-flight prompt) the way
   * a real SIGTERM would.
   */
  function createLingeringProcess(pid: number, onKill?: (signal: NodeJS.Signals) => void) {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      kill: vi.fn((signal: NodeJS.Signals) => {
        onKill?.(signal);
        queueMicrotask(() => {
          proc.exitCode = 143;
          proc.emit("close", 143);
        });
        return true;
      }),
      pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    return proc;
  }

  it("records a completed run when the timeout fires after the agent finishes", async () => {
    vi.useFakeTimers();

    mockSpawn.mockImplementation((() => createLingeringProcess(4242)) as any);

    // The prompt sends its final message, then parks until we release it —
    // simulating the agent having finished while the child lingers.
    let releasePrompt!: () => void;
    const gate = new Promise<void>((r) => {
      releasePrompt = r;
    });
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All tests pass." },
      });
      await gate;
      return { stopReason: "end_turn", usage: { inputTokens: 285071, outputTokens: 4742 } };
    });

    const input = makeInput();
    input.timeoutMs = 600;
    const runPromise = adapter.run(input);

    // Let the ACP handshake run and the prompt send its message + park.
    await vi.advanceTimersByTimeAsync(0);
    // Fire the timeout — tears down the lingering child.
    await vi.advanceTimersByTimeAsync(600);
    // The agent's terminal result lands right after.
    releasePrompt();

    const output = await runPromise;

    // Success, not a timeout failure: real result, real usage, exit 0.
    expect(output.metadata.error).toBeUndefined();
    expect(output.metadata.exitCode).toBe(0);
    expect(output.metadata.tokenUsage).toEqual({ input: 285071, output: 4742 });
    expect(output.result).toBe("All tests pass.");
  });

  it("records a completed run when an abort signal fires after the agent finishes", async () => {
    vi.useFakeTimers();

    mockSpawn.mockImplementation((() => createLingeringProcess(4243)) as any);

    let releasePrompt!: () => void;
    const gate = new Promise<void>((r) => {
      releasePrompt = r;
    });
    mockPrompt.mockImplementation(async () => {
      await sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Resource config applied." },
      });
      await gate;
      return { stopReason: "end_turn", usage: { inputTokens: 758017, outputTokens: 13569 } };
    });

    const controller = new AbortController();
    const input = makeInput();
    input.signal = controller.signal;
    const runPromise = adapter.run(input);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort("Scenario token limit reached (500000 tokens)");
    await vi.advanceTimersByTimeAsync(0);
    releasePrompt();

    const output = await runPromise;

    expect(output.metadata.error).toBeUndefined();
    expect(output.metadata.exitCode).toBe(0);
    expect(output.metadata.tokenUsage).toEqual({ input: 758017, output: 13569 });
    expect(output.result).toBe("Resource config applied.");
  });

  it("still fails as a timeout when no terminal result arrives, honouring input.timeoutMs", async () => {
    vi.useFakeTimers();

    // Spec default is far larger than the per-run timeout the runner passes.
    const a = createAcpBasedAdapter({
      name: "test-acp",
      cliCommand: "goose",
      buildArgs: () => ["acp"],
      timeoutMs: 10 * 60 * 1000,
    });

    let rejectPrompt!: (err: Error) => void;
    mockPrompt.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );

    // The connection breaks when we signal the child, as a real SIGTERM would.
    mockSpawn.mockImplementation((() =>
      createLingeringProcess(4244, () => rejectPrompt(new Error("Connection closed")))) as any);

    const input = makeInput();
    input.timeoutMs = 600;
    const runPromise = a.run(input);

    await vi.advanceTimersByTimeAsync(0);
    // Nothing should be torn down before the per-run timeout.
    expect(processKillSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);

    const output = await runPromise;

    expect(output.result).toBeNull();
    // 0.6s == input.timeoutMs (600ms), NOT the 10-minute spec default.
    expect(output.metadata.error).toMatch(/timed out after 0\.6s/i);
  });

  it("tears down the child process group and fails when aborted before completion", async () => {
    vi.useFakeTimers();

    let rejectPrompt!: (err: Error) => void;
    mockPrompt.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    mockSpawn.mockImplementation((() =>
      createLingeringProcess(9999, () => rejectPrompt(new Error("Connection closed")))) as any);

    const controller = new AbortController();
    const input = makeInput();
    input.signal = controller.signal;
    const runPromise = adapter.run(input);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort("Scenario token limit reached (500000 tokens)");
    await vi.advanceTimersByTimeAsync(0);

    const output = await runPromise;

    expect(output.result).toBeNull();
    expect(output.metadata.error).toBe("Scenario token limit reached (500000 tokens)");
    // The whole process group is signalled (negative pid), not just the child.
    expect(processKillSpy).toHaveBeenCalledWith(-9999, "SIGTERM");
  });
});
