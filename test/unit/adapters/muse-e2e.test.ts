import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/muse");

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "muse", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
import { run } from "../../../src/runner/runner.js";
import {
  createMspMockProcess,
  agentMessage,
  toolCall,
  toolCallStarted,
  tokenUsage,
  turnCompleted,
  DEFAULT_SESSION_ID,
  type MspMockOptions,
} from "../../helpers/msp-mock.js";

const mockSpawn = vi.mocked(spawn);

/** A representative turn: one tool call, an answer, usage with a priced cost. */
const TURN = [
  toolCallStarted("bash"),
  toolCall("bash"),
  agentMessage("Hello from AXIS Muse adapter"),
  // Counters from a real billed turn: Muse counts prompt tokens once, cache
  // reads included, so totalTokens = promptTokens + outputTokens.
  tokenUsage({
    promptTokens: 26374,
    outputTokens: 233,
    cacheReadTokens: 14577,
    totalTokens: 26607,
    cost: { usd: 0.001255454, partial: false },
  }),
  turnCompleted("completed", { durationMs: 24306, timeToFirstTokenMs: 8275 }),
];

interface SpawnCapture {
  args: string[];
  opts: Record<string, unknown>;
  /** Fills in as the adapter talks to the mock host. */
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

let lastSpawn: SpawnCapture;

function mockMuse(options: MspMockOptions = {}) {
  mockSpawn.mockImplementation(((_cmd: string, args: string[], opts: Record<string, unknown>) => {
    const { proc, requests } = createMspMockProcess({ turnNotifications: TURN, omitTurnCompleted: true, ...options });
    lastSpawn = { args, opts, requests };
    return proc;
  }) as never);
}

describe("Muse adapter e2e", () => {
  const origKey = process.env.META_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_API_KEY = "test-key";
    mockMuse();
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.META_API_KEY = origKey;
    else delete process.env.META_API_KEY;
  });

  it("runs a scenario end to end over MSP", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    const result = output.results[0];
    expect(result.agentName).toBe("muse");
    expect(result.scenarioKey).toBe("echo-test");
    expect(result.output.metadata.exitCode).toBe(0);
    expect(result.output.result).toBe("Hello from AXIS Muse adapter");
    expect(result.output.metadata.sessionId).toBe(DEFAULT_SESSION_ID);
  });

  it("reports real token usage and USD cost", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    // The whole reason this adapter speaks MSP instead of `muse exec --json`:
    // exec reports neither of these.
    const meta = output.results[0].output.metadata;
    expect(meta.tokenUsage).toEqual({ input: 11797, output: 233, cacheReadInput: 14577 });
    expect(meta.totalCostUsd).toBeCloseTo(0.001255454);
    // Must equal Muse's own totalTokens, not double count the cache read.
    const u = meta.tokenUsage!;
    expect(u.input + u.output + (u.cacheReadInput ?? 0)).toBe(26607);
  });

  it("reports the turn's duration rather than host wall clock", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results[0].output.metadata.durationMs).toBe(24306);
  });

  it("maps a tool call and drops protocol bookkeeping", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    const transcript = output.results[0].output.transcript;
    // The tool_use/tool_result pair is what lets the sparse index time the
    // interaction; userMessage and reminderChild items never appear.
    expect(transcript.map((e) => e.type)).toEqual(["tool_use", "tool_result", "assistant"]);
    expect(transcript[0].content.tool_name).toBe("bash");
  });

  it("drives the handshake and sends the prompt on the wire, never on argv", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(lastSpawn.args[0]).toBe("serve");
    expect(lastSpawn.args).not.toContain("Hello from AXIS Muse adapter");
    expect(lastSpawn.requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "session/start",
      "turn/start",
    ]);
    const turn = lastSpawn.requests.find((r) => r.method === "turn/start")!.params;
    expect(turn.input).toEqual([{ type: "text", text: "Hello from AXIS Muse adapter" }]);
  });

  it("isolates Muse's XDG dirs under HOME and pins the launcher's auto-update off", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    const env = lastSpawn.opts.env as Record<string, string>;
    const workspace = lastSpawn.opts.cwd as string;
    expect(env.XDG_CONFIG_HOME).toBe(path.join(env.HOME, ".config"));
    expect(env.XDG_DATA_HOME).toBe(path.join(env.HOME, ".local", "share"));
    expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
    expect(env.MUSE_LOGIN).toBe("0");
    // Nothing Muse reads may live in the directory the agent scans.
    expect(env.XDG_CONFIG_HOME.startsWith(workspace)).toBe(false);
    expect(env.XDG_DATA_HOME.startsWith(workspace)).toBe(false);
  });

  it("marks a failed turn as a failed run", async () => {
    mockMuse({
      turnNotifications: [turnCompleted("failed", { error: { message: "API error 402: billing_error" } })],
      omitTurnCompleted: true,
    });

    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.summary.failed).toBe(1);
    expect(output.summary.completed).toBe(0);
    expect(output.results[0].output.metadata.error).toContain("402");
  });

  it("reports Muse's own stderr when the host dies before the turn", async () => {
    // The real shape of an auth failure: the host exits before answering.
    mockMuse({ dieOnTurn: 1, stderr: "missing meta credentials: run `muse login` or set META_API_KEY\n" });

    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.summary.failed).toBe(1);
    expect(output.results[0].output.metadata.error).toContain("missing meta credentials");
  });

  it("runs the full pipeline: config → runner → muse adapter → result", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.version).toBe("0.1.0");
    expect(output.summary.total).toBe(1);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.results[0].agentConfig.agent).toBe("muse");
  });
});
