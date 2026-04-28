import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { EventEmitter, Readable, Writable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/goose");

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockInitialize, mockNewSession, mockPrompt, acpState } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue({}),
  mockNewSession: vi.fn().mockResolvedValue({ sessionId: "sess-goose-001" }),
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
  resolveCommand: vi.fn().mockResolvedValue({ command: "goose", prefixArgs: [] }),
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
    pid: 88888,
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

function setupAcpConversation() {
  mockPrompt.mockImplementation(async () => {
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me help." },
    });
    await sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "ReadFile",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "README.md" },
    });
    await sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      rawOutput: "# Project",
    });
    await sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from AXIS Goose adapter" },
    });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 40 },
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Goose adapter e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acpState.capturedClient = null;
    mockInitialize.mockResolvedValue({});
    mockNewSession.mockResolvedValue({ sessionId: "sess-goose-001" });
    mockSpawn.mockImplementation((() => createMockProcess()) as any);
    setupAcpConversation();
  });

  it("runs scenario through ACP pipeline", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);

    const result = output.results[0];
    expect(result.agentName).toBe("goose");
    expect(result.scenarioKey).toBe("echo-test");
    expect(result.output.metadata.exitCode).toBe(0);
    expect(result.output.result).toBe("Hello from AXIS Goose adapter");
  });

  it("captures token usage from PromptResponse", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results[0].output.metadata.tokenUsage).toEqual({
      input: 150,
      output: 40,
    });
  });

  it("maps ACP events to correct transcript structure", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    const transcript = output.results[0].output.transcript;

    expect(transcript).toHaveLength(5);
    expect(transcript[0].type).toBe("user");
    expect(transcript[1].type).toBe("assistant");
    expect(transcript[1].content).toMatchObject({ content: "Let me help." });
    expect(transcript[2].type).toBe("tool_use");
    expect(transcript[2].content).toMatchObject({ tool_name: "ReadFile", kind: "read" });
    expect(transcript[3].type).toBe("tool_result");
    expect(transcript[3].content).toMatchObject({ tool_id: "tc-1", output: "# Project" });
    expect(transcript[4].type).toBe("assistant");
    expect(transcript[4].content).toMatchObject({ content: "Hello from AXIS Goose adapter" });
  });

  it("runs full pipeline: config → runner → goose adapter → result", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.version).toBe("0.1.0");
    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.results[0].agentConfig.adapter).toBe("goose");
  });
});
