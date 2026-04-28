import { describe, it, expect, vi, beforeEach } from "vitest";
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
  });

  setTimeout(() => {
    stdout.push(null);
    stderr.push(null);
    proc.emit("close", exitCode);
  }, delay);

  return proc;
}

function makeInput(prompt = "test prompt"): AgentInput {
  return {
    prompt,
    config: { adapter: "goose" },
    scenario: {
      key: "test",
      name: "Test",
      prompt,
      rubric: [{ check: "test", weight: 1.0 }],
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

  beforeEach(() => {
    vi.clearAllMocks();
    acpState.capturedClientFactory = null;
    acpState.capturedClient = null;

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
      isolationEnv: (ws) => ({ TEST_HOME: `${ws}/.test` }),
    });
    expect(a.isolationEnv!("/tmp/ws")).toEqual({ TEST_HOME: "/tmp/ws/.test" });
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
});
