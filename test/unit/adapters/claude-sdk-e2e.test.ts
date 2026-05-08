import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { EventEmitter, Readable, Writable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/claude-sdk");

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockInitialize, mockNewSession, mockPrompt, acpState } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue({}),
  mockNewSession: vi.fn().mockResolvedValue({ sessionId: "sess-claude-sdk-001" }),
  mockPrompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
  acpState: { capturedClient: null as any },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "claude-agent-acp", prefixArgs: [] }),
}));
vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn().mockReturnValue({ readable: {}, writable: {} }),
  ClientSideConnection: vi.fn().mockImplementation((clientFactory: any) => {
    acpState.capturedClient = clientFactory({});
    return { initialize: mockInitialize, newSession: mockNewSession, prompt: mockPrompt };
  }),
}));

import { spawn } from "node:child_process";
import { run } from "../../../src/runner/runner.js";

const mockSpawn = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcess(exitCode = 0) {
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
    pid: 77777,
  });

  setTimeout(() => {
    stdout.push(null);
    stderr.push(null);
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

async function sendUpdate(update: Record<string, unknown>) {
  await acpState.capturedClient.sessionUpdate({ update });
}

function runConfig() {
  return run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });
}

// ---------------------------------------------------------------------------
// Simulated ACP conversations
// ---------------------------------------------------------------------------

/** Simple conversation: message chunks → tool → message chunks */
function setupSimpleConversation() {
  mockPrompt.mockImplementation(async () => {
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me " },
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "check that." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-001",
      title: "Read",
      kind: "read",
      status: "in_progress",
      rawInput: { file_path: "/workspace/README.md" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-read-001",
      status: "completed",
      rawOutput: "# My Project\nA test project.",
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from AXIS " },
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Claude SDK adapter" },
    });
    return { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 80 } };
  });
}

/**
 * Comprehensive conversation exercising key ACP features:
 * - Thought chunks (should NOT appear in transcript)
 * - Multiple tool calls with different kinds
 * - Failed tool call → error entry
 * - Tool retry after failure
 * - Usage update event
 * - cachedReadTokens in final PromptResponse
 */
function setupComprehensiveConversation() {
  mockPrompt.mockImplementation(async () => {
    // 1. Thought chunk — should NOT produce transcript entry
    await sendUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "The user wants me to read and edit a file..." },
    });

    // 2. Assistant message
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'll read the file first." },
    });

    // 3. Read tool call
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-001",
      title: "Read",
      kind: "read",
      status: "in_progress",
      rawInput: { file_path: "/workspace/config.ts" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-read-001",
      status: "completed",
      rawOutput: "export const config = { debug: false };",
    });

    // 4. Edit tool call — will FAIL
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Now I'll edit the config." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit-001",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: "/workspace/config.ts", old_string: "debug: false", new_string: "debug: true" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-edit-001",
      status: "failed",
      rawOutput: "old_string not found in file",
    });

    // 5. Retry with Bash
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me try a different approach." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-bash-001",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sed -i 's/debug: false/debug: true/' config.ts" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bash-001",
      status: "completed",
      rawOutput: "",
    });

    // 6. Usage update
    await sendUpdate({
      sessionUpdate: "usage_update",
      used: 2800,
      size: 200000,
      cost: { amount: 0.012, currency: "USD" },
    });

    // 7. Final assistant response
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done. The debug flag is now set to true." },
    });

    return {
      stopReason: "end_turn",
      usage: { inputTokens: 800, outputTokens: 220, cachedReadTokens: 150 },
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Claude SDK adapter e2e", () => {
  const origKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    acpState.capturedClient = null;
    mockInitialize.mockResolvedValue({});
    mockNewSession.mockResolvedValue({ sessionId: "sess-claude-sdk-001" });
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSpawn.mockImplementation((() => createMockProcess()) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = origKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // -------------------------------------------------------------------------
  // Basic pipeline tests
  // -------------------------------------------------------------------------

  describe("basic pipeline", () => {
    beforeEach(() => setupSimpleConversation());

    it("runs scenario through ACP pipeline", async () => {
      const output = await runConfig();

      expect(output.results).toHaveLength(1);
      const result = output.results[0];
      expect(result.agentName).toBe("claude-sdk");
      expect(result.scenarioKey).toBe("echo-test");
      expect(result.output.metadata.exitCode).toBe(0);
      expect(result.output.result).toBe("Hello from AXIS Claude SDK adapter");
    });

    it("captures token usage from PromptResponse", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.tokenUsage).toEqual({ input: 300, output: 80 });
    });

    it("maps tool_call and tool_call_update to transcript entries with consolidated chunks", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      expect(transcript).toHaveLength(5);
      expect(transcript[0].type).toBe("user");
      expect(transcript[1].type).toBe("assistant");
      expect(transcript[1].content).toMatchObject({ content: "Let me check that." });
      expect(transcript[2].type).toBe("tool_use");
      expect(transcript[2].content).toMatchObject({ tool_name: "Read", tool_id: "tc-read-001", kind: "read" });
      expect(transcript[3].type).toBe("tool_result");
      expect(transcript[3].content).toMatchObject({ tool_id: "tc-read-001", output: "# My Project\nA test project." });
      expect(transcript[4].type).toBe("assistant");
      expect(transcript[4].content).toMatchObject({ content: "Hello from AXIS Claude SDK adapter" });
    });

    it("captures session ID", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.sessionId).toBe("sess-claude-sdk-001");
    });

    it("runs full pipeline: config → runner → claude-sdk adapter → result", async () => {
      const output = await runConfig();
      expect(output.version).toBe("0.1.0");
      expect(output.summary.total).toBe(1);
      expect(output.summary.completed).toBe(1);
      expect(output.summary.failed).toBe(0);
      expect(output.results[0].agentConfig.agent).toBe("claude-sdk");
    });
  });

  // -------------------------------------------------------------------------
  // Comprehensive ACP feature coverage
  // -------------------------------------------------------------------------

  describe("comprehensive ACP features", () => {
    beforeEach(() => setupComprehensiveConversation());

    it("produces the correct transcript structure", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // Expected sequence:
      //  0: user      (initial prompt)
      //  1: assistant ("I'll read the file first.")
      //  2: tool_use  (Read)
      //  3: tool_result (Read completed)
      //  4: assistant ("Now I'll edit the config.")
      //  5: tool_use  (Edit)
      //  6: error     (Edit failed)
      //  7: assistant ("Let me try a different approach.")
      //  8: tool_use  (Bash)
      //  9: tool_result (Bash completed)
      // 10: assistant ("Done. The debug flag is now set to true.")

      expect(transcript).toHaveLength(11);

      const types = transcript.map((e) => e.type);
      expect(types).toEqual([
        "user",
        "assistant",
        "tool_use",
        "tool_result",
        "assistant",
        "tool_use",
        "error",
        "assistant",
        "tool_use",
        "tool_result",
        "assistant",
      ]);
    });

    it("excludes thought chunks from transcript", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      const thoughtEntries = transcript.filter((e) => e.type === "system" && (e.content as any).type === "thought");
      expect(thoughtEntries).toHaveLength(0);
    });

    it("maps failed tool calls to error entries", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;
      const errorEntry = transcript.find((e) => e.type === "error");

      expect(errorEntry).toBeDefined();
      expect(errorEntry!.content).toMatchObject({
        error: "Tool failed: Edit",
        tool_id: "tc-edit-001",
        output: "old_string not found in file",
        kind: "edit",
      });
    });

    it("includes cachedReadTokens in token usage", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.tokenUsage).toEqual({
        input: 800,
        output: 220,
        cacheReadInput: 150,
      });
    });

    it("captures totalCostUsd from usage_update cost", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.totalCostUsd).toBe(0.012);
    });

    it("sets result to last assistant message text", async () => {
      const output = await runConfig();
      expect(output.results[0].output.result).toBe("Done. The debug flag is now set to true.");
    });

    it("reports successful run despite tool failures mid-conversation", async () => {
      const output = await runConfig();
      expect(output.summary.completed).toBe(1);
      expect(output.summary.failed).toBe(0);
      expect(output.results[0].output.metadata.exitCode).toBe(0);
      expect(output.results[0].output.metadata.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Error / edge case scenarios
  // -------------------------------------------------------------------------

  describe("stop reason error mapping", () => {
    it("marks run as failed on refusal stop reason", async () => {
      mockPrompt.mockImplementation(async () => {
        await sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I cannot do that." },
        });
        return { stopReason: "refusal" };
      });

      const output = await runConfig();
      expect(output.results[0].output.metadata.error).toBe("Agent refused to continue");
      expect(output.summary.failed).toBe(1);
    });

    it("marks run as failed on max_tokens stop reason", async () => {
      mockPrompt.mockResolvedValue({ stopReason: "max_tokens" });

      const output = await runConfig();
      expect(output.results[0].output.metadata.error).toBe("Agent hit max tokens limit");
      expect(output.summary.failed).toBe(1);
    });

    it("marks run as failed on cancelled stop reason", async () => {
      mockPrompt.mockResolvedValue({ stopReason: "cancelled" });

      const output = await runConfig();
      expect(output.results[0].output.metadata.error).toBe("Agent cancelled");
      expect(output.summary.failed).toBe(1);
    });
  });

  describe("permission handling", () => {
    it("auto-approves permission requests so the agent runs uninterrupted", async () => {
      mockPrompt.mockImplementation(async () => {
        const result = await acpState.capturedClient.requestPermission({
          options: [
            { kind: "reject_always", optionId: "deny", name: "Deny" },
            { kind: "allow_always", optionId: "allow", name: "Allow Always" },
            { kind: "allow_once", optionId: "once", name: "Allow Once" },
          ],
        });
        expect(result.outcome.optionId).toBe("allow");

        await sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission granted, proceeding." },
        });
        return { stopReason: "end_turn" };
      });

      const output = await runConfig();
      expect(output.results[0].output.result).toBe("Permission granted, proceeding.");
    });
  });
});
