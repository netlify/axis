import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { EventEmitter, Readable, Writable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";
import { extractFields } from "../../../src/transcript/extract.js";
import { isNetworkCall } from "../../../src/transcript/classify.js";
import { extractUrls } from "../../../src/transcript/urls.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/gemini-acp");

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockInitialize, mockNewSession, mockPrompt, acpState } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue({}),
  mockNewSession: vi.fn().mockResolvedValue({ sessionId: "sess-gemini-acp-001" }),
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
  resolveCommand: vi.fn().mockResolvedValue({ command: "gemini", prefixArgs: [] }),
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
    pid: 99999,
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
      content: { type: "text", text: "run that." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-bash-001",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "echo hello" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bash-001",
      status: "completed",
      rawOutput: "hello",
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from AXIS " },
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Gemini ACP adapter" },
    });
    return { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 60 } };
  });
}

/**
 * Comprehensive conversation exercising every ACP feature:
 * - Plan event
 * - Thought chunks (should NOT appear in transcript)
 * - Multiple tool calls with different kinds (read, execute, fetch)
 * - Failed tool call → error entry (interaction scoring)
 * - Tool retry after failure (consecutive same-name calls)
 * - Tool result with structured content blocks (content, diff, terminal)
 * - Network tool call with URL in input (service scoring)
 * - Non-text content block in message chunk (silently ignored)
 * - Usage update event
 * - cachedReadTokens in final PromptResponse
 */
function setupComprehensiveConversation() {
  mockPrompt.mockImplementation(async () => {
    // 1. Plan — should produce system entry
    await sendUpdate({
      sessionUpdate: "plan",
      entries: [
        { title: "Read the config file", description: "Check existing settings" },
        { title: "Modify settings", description: "Update the target field" },
        { title: "Verify changes", description: "Run tests to confirm" },
      ],
    });

    // 2. Thought chunk — should feed estimator but NOT produce transcript entry
    await sendUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "I need to read the config first..." },
    });

    // 3. Assistant message chunks
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'll start by reading the config." },
    });

    // 4. Read tool call with locations
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-001",
      title: "ReadFile",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "config.json" },
      locations: [{ uri: "file:///workspace/config.json" }],
    });

    // 5. Read tool result with structured content block
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-read-001",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: '{"setting": "old_value"}' },
        },
      ],
    });

    // 6. Edit tool call — will FAIL (error tracked for interaction scoring)
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me update the config." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit-001",
      title: "EditFile",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "config.json", content: '{"setting": "new_value"}' },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-edit-001",
      status: "failed",
      rawOutput: "Permission denied: config.json is read-only",
    });

    // 7. Retry same tool after failure
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me try with sudo." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit-002",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "chmod 644 config.json && cat config.json" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-edit-002",
      status: "completed",
      rawOutput: "done",
    });

    // 8. Edit tool result with diff content block
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit-003",
      title: "EditFile",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "config.json", content: '{"setting": "new_value"}' },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-edit-003",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "config.json",
          before: '{"setting": "old_value"}',
          after: '{"setting": "new_value"}',
        },
      ],
    });

    // 9. Network call — fetch kind with URL (network scoring)
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me verify online." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-fetch-001",
      title: "fetch",
      kind: "fetch",
      status: "in_progress",
      rawInput: { url: "https://api.example.com/validate" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-fetch-001",
      status: "completed",
      rawOutput: '{"valid": true}',
    });

    // 10. Bash tool with terminal content block in result
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-bash-001",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bash-001",
      status: "completed",
      content: [
        {
          type: "terminal",
          terminalId: "term-1",
          output: "All tests passed",
        },
      ],
    });

    // 11. Non-text message chunk (image) — should be silently ignored
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "base64data", mimeType: "image/png" },
    });

    // 12. Usage update
    await sendUpdate({
      sessionUpdate: "usage_update",
      used: 3500,
      size: 200000,
      cost: { amount: 0.015, currency: "USD" },
    });

    // 13. Final assistant response
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "All done. Config updated and tests pass." },
    });

    return {
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 350, cachedReadTokens: 400 },
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gemini ACP adapter e2e", () => {
  const origKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    acpState.capturedClient = null;
    mockInitialize.mockResolvedValue({});
    mockNewSession.mockResolvedValue({ sessionId: "sess-gemini-acp-001" });
    process.env.GEMINI_API_KEY = "test-key";
    mockSpawn.mockImplementation((() => createMockProcess()) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.GEMINI_API_KEY = origKey;
    } else {
      delete process.env.GEMINI_API_KEY;
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
      expect(result.agentName).toBe("gemini-acp");
      expect(result.scenarioKey).toBe("echo-test");
      expect(result.output.metadata.exitCode).toBe(0);
      expect(result.output.result).toBe("Hello from AXIS Gemini ACP adapter");
    });

    it("captures token usage from PromptResponse", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.tokenUsage).toEqual({ input: 200, output: 60 });
    });

    it("maps tool_call and tool_call_update to transcript entries with consolidated chunks", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      expect(transcript).toHaveLength(5);
      expect(transcript[0].type).toBe("user");
      expect(transcript[1].type).toBe("assistant");
      expect(transcript[1].content).toMatchObject({ content: "Let me run that." });
      expect(transcript[2].type).toBe("tool_use");
      expect(transcript[2].content).toMatchObject({ tool_name: "Bash", tool_id: "tc-bash-001", kind: "execute" });
      expect(transcript[3].type).toBe("tool_result");
      expect(transcript[3].content).toMatchObject({ tool_id: "tc-bash-001", output: "hello" });
      expect(transcript[4].type).toBe("assistant");
      expect(transcript[4].content).toMatchObject({ content: "Hello from AXIS Gemini ACP adapter" });
    });

    it("captures session ID", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.sessionId).toBe("sess-gemini-acp-001");
    });

    it("runs full pipeline: config → runner → gemini-acp adapter → result", async () => {
      const output = await runConfig();
      expect(output.version).toBe("0.1.0");
      expect(output.summary.total).toBe(1);
      expect(output.summary.completed).toBe(1);
      expect(output.summary.failed).toBe(0);
      expect(output.results[0].agentConfig.agent).toBe("gemini-acp");
    });
  });

  // -------------------------------------------------------------------------
  // Comprehensive ACP feature coverage
  // -------------------------------------------------------------------------

  describe("comprehensive ACP features", () => {
    beforeEach(() => setupComprehensiveConversation());

    it("produces the correct transcript structure with all event types", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // Expected sequence:
      //  0: user     (initial prompt)
      //  1: system   (plan)
      //  2: assistant ("I'll start by reading the config.")
      //  3: tool_use  (ReadFile)
      //  4: tool_result (ReadFile completed — content block)
      //  5: assistant ("Let me update the config.")
      //  6: tool_use  (EditFile)
      //  7: error     (EditFile failed)
      //  8: assistant ("Let me try with sudo.")
      //  9: tool_use  (Bash chmod)
      // 10: tool_result (Bash completed)
      // 11: tool_use  (EditFile retry)
      // 12: tool_result (EditFile completed — diff block)
      // 13: assistant ("Let me verify online.")
      // 14: tool_use  (fetch)
      // 15: tool_result (fetch completed)
      // 16: tool_use  (Bash npm test)
      // 17: tool_result (Bash completed — terminal block)
      // 18: assistant ("All done. Config updated and tests pass.")

      expect(transcript).toHaveLength(19);

      // Thought chunk should NOT appear in transcript
      const thoughtEntries = transcript.filter((e) => e.type === "system" && (e.content as any).type === "thought");
      expect(thoughtEntries).toHaveLength(0);
    });

    it("maps plan events to system entries with structured data", async () => {
      const output = await runConfig();
      const plan = output.results[0].output.transcript[1];

      expect(plan.type).toBe("system");
      expect(plan.content).toMatchObject({
        type: "plan",
        entries: [
          { title: "Read the config file", description: "Check existing settings" },
          { title: "Modify settings", description: "Update the target field" },
          { title: "Verify changes", description: "Run tests to confirm" },
        ],
      });
    });

    it("maps failed tool calls to error entries", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;
      const errorEntry = transcript.find((e) => e.type === "error");

      expect(errorEntry).toBeDefined();
      expect(errorEntry!.content).toMatchObject({
        error: "Tool failed: EditFile",
        tool_id: "tc-edit-001",
        output: "Permission denied: config.json is read-only",
        kind: "edit",
      });
    });

    it("preserves tool kind and locations on tool_use entries", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;
      const readToolUse = transcript.find((e) => e.type === "tool_use" && (e.content as any).tool_name === "ReadFile");

      expect(readToolUse).toBeDefined();
      expect(readToolUse!.content).toMatchObject({
        tool_name: "ReadFile",
        tool_id: "tc-read-001",
        kind: "read",
        parameters: { path: "config.json" },
        locations: [{ uri: "file:///workspace/config.json" }],
      });
    });

    it("extracts text from structured content blocks in tool results", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // ReadFile result — content block with text
      const readResult = transcript.find(
        (e) => e.type === "tool_result" && (e.content as any).tool_id === "tc-read-001",
      );
      expect(readResult!.content).toMatchObject({
        output: '{"setting": "old_value"}',
        name: "ReadFile",
        kind: "read",
      });
    });

    it("handles diff content blocks in tool results", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // EditFile result — diff block
      const editResult = transcript.find(
        (e) => e.type === "tool_result" && (e.content as any).tool_id === "tc-edit-003",
      );
      expect(editResult).toBeDefined();
      expect(editResult!.content).toMatchObject({
        output: "[diff: config.json]",
        name: "EditFile",
        kind: "edit",
      });
    });

    it("handles terminal content blocks in tool results", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // Bash npm test result — terminal block
      const bashResult = transcript.find(
        (e) => e.type === "tool_result" && (e.content as any).tool_id === "tc-bash-001",
      );
      expect(bashResult).toBeDefined();
      expect(bashResult!.content).toMatchObject({
        output: "[terminal: term-1]",
        name: "Bash",
        kind: "execute",
      });
    });

    it("produces entries compatible with extractFields()", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // tool_use → extractFields should find toolName, toolInput, toolId
      const toolUse = transcript.find((e) => e.type === "tool_use" && (e.content as any).tool_name === "ReadFile")!;
      const useFields = extractFields(toolUse);
      expect(useFields.toolName).toBe("ReadFile");
      expect(useFields.toolInput).toMatchObject({ path: "config.json" });
      expect(useFields.toolId).toBe("tc-read-001");

      // tool_result → extractFields should find toolResultText, toolId
      const toolResult = transcript.find(
        (e) => e.type === "tool_result" && (e.content as any).tool_id === "tc-read-001",
      )!;
      const resultFields = extractFields(toolResult);
      expect(resultFields.toolResultText).toBe('{"setting": "old_value"}');
      expect(resultFields.toolId).toBe("tc-read-001");

      // assistant → extractFields should find text
      const assistant = transcript.find((e) => e.type === "assistant")!;
      const assistantFields = extractFields(assistant);
      expect(assistantFields.text).toBe("I'll start by reading the config.");

      // error → extractFields should find errorMessage
      const errorEntry = transcript.find((e) => e.type === "error")!;
      const errorFields = extractFields(errorEntry);
      expect(errorFields.errorMessage).toBe("Tool failed: EditFile");
    });

    it("produces entries compatible with network classification", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // fetch tool_use — should be classified as network call by tool name
      const fetchUse = transcript.find((e) => e.type === "tool_use" && (e.content as any).tool_name === "fetch")!;
      const fetchFields = extractFields(fetchUse);
      const fetchInputStr = fetchFields.toolInputSummary ?? "";
      const fetchUrls = extractUrls(fetchInputStr);
      expect(isNetworkCall(fetchFields.toolName, fetchUrls)).toBe(true);

      // Also verify URL is extractable from the serialized input
      expect(fetchUrls.length).toBeGreaterThan(0);
      expect(fetchUrls[0].url).toBe("https://api.example.com/validate");

      // ReadFile tool_use — should NOT be classified as network call
      const readUse = transcript.find((e) => e.type === "tool_use" && (e.content as any).tool_name === "ReadFile")!;
      const readFields = extractFields(readUse);
      const readInputStr = readFields.toolInputSummary ?? "";
      const readUrls = extractUrls(readInputStr);
      expect(isNetworkCall(readFields.toolName, readUrls)).toBe(false);
    });

    it("silently ignores non-text content blocks in message chunks", async () => {
      const output = await runConfig();
      const transcript = output.results[0].output.transcript;

      // The image chunk between the last tool and the final message should be skipped.
      // Final assistant message should only contain text from the text chunk.
      const lastAssistant = transcript[transcript.length - 1];
      expect(lastAssistant.type).toBe("assistant");
      expect(lastAssistant.content).toMatchObject({
        text: "All done. Config updated and tests pass.",
      });
    });

    it("includes cachedReadTokens in token usage", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.tokenUsage).toEqual({
        input: 1200,
        output: 350,
        cacheReadInput: 400,
      });
    });

    it("captures totalCostUsd from usage_update cost", async () => {
      const output = await runConfig();
      expect(output.results[0].output.metadata.totalCostUsd).toBe(0.015);
    });

    it("sets result to last assistant message text", async () => {
      const output = await runConfig();
      expect(output.results[0].output.result).toBe("All done. Config updated and tests pass.");
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
        // Simulate permission request before tool call
        const result = await acpState.capturedClient.requestPermission({
          options: [
            { kind: "reject_always", optionId: "deny", name: "Deny" },
            { kind: "allow_always", optionId: "allow", name: "Allow Always" },
            { kind: "allow_once", optionId: "once", name: "Allow Once" },
          ],
        });
        // Should pick allow_always
        expect(result.outcome.optionId).toBe("allow");

        await sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission granted." },
        });
        return { stopReason: "end_turn" };
      });

      const output = await runConfig();
      expect(output.results[0].output.result).toBe("Permission granted.");
    });
  });
});
