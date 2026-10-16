import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter, Readable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/agy");

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "agy", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
import { run } from "../../../src/runner/runner.js";

const mockSpawn = vi.mocked(spawn);
const CONVERSATION_ID = "36ee5ed1-f410-43ec-961b-fcde2f0c6dcb";

const ev = (event: Record<string, unknown>) => JSON.stringify(event);
const step = (s: Record<string, unknown>) =>
  ev({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, ...s } });

const SUCCESS = [
  ev({ event: "init", conversation_id: CONVERSATION_ID, init: { model: "gemini-3.8-flash", tools: [] } }),
  step({ step_index: 0, state: "DONE", step_type: "user_input" }),
  step({
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    usage: { input_tokens: 12227, output_tokens: 112, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12339 },
  }),
  step({
    step_index: 2,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "view_file",
    tool_info: { parameters: { AbsolutePath: "/tmp/README.md" } },
  }),
  step({
    step_index: 2,
    state: "DONE",
    step_type: "tool",
    tool_name: "view_file",
    tool_info: { parameters: { AbsolutePath: "/tmp/README.md" }, output: "3 lines, 40 bytes" },
  }),
  step({
    step_index: 3,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "Hello from AXIS agy adapter\n",
    usage: { input_tokens: 12493, output_tokens: 6, thinking_tokens: 0, cache_read_tokens: 3633, total_tokens: 12499 },
  }),
  ev({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status: "SUCCESS",
      response: "Hello from AXIS agy adapter\n",
      duration_seconds: 7.628081,
    },
  }),
];

interface SpawnCapture {
  args: string[];
  opts: Record<string, unknown>;
  stdin: string;
  settings: unknown;
}

let lastSpawn: SpawnCapture;

function mockAgy(lines: string[]) {
  mockSpawn.mockImplementation(((_cmd: string, args: string[], opts: Record<string, unknown>) => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const env = opts.env as Record<string, string>;
    lastSpawn = {
      args,
      opts,
      stdin: "",
      settings: JSON.parse(
        fs.readFileSync(path.join(env.HOME, ".gemini", "antigravity-cli", "settings.json"), "utf-8"),
      ),
    };
    const stdin = {
      on: vi.fn(),
      end: vi.fn((data?: string) => {
        lastSpawn.stdin = data ?? "";
      }),
    };
    const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn(), pid: 1 });
    setTimeout(() => {
      for (const line of lines) stdout.push(line + "\n");
      stdout.push(null);
      stderr.push(null);
      setTimeout(() => proc.emit("close", 0), 5);
    }, 10);
    return proc;
  }) as never);
}

describe("agy adapter e2e", () => {
  const origKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
    mockAgy(SUCCESS);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("runs a scenario end to end", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.summary).toMatchObject({ total: 1, completed: 1, failed: 0 });
    const result = output.results[0];
    expect(result.agentConfig.agent).toBe("agy");
    expect(result.output.result).toBe("Hello from AXIS agy adapter");
    expect(result.output.metadata.sessionId).toBe(CONVERSATION_ID);
    expect(result.output.metadata.durationMs).toBe(7628);
    expect(result.output.transcript.map((e) => e.type)).toEqual(["tool_use", "tool_result", "assistant"]);
  });

  it("reports tokens and a cost computed from them", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    const meta = output.results[0].output.metadata;
    expect(meta.tokenUsage).toEqual({ input: 24720, output: 118, cacheReadInput: 3633 });
    expect(meta.totalCostUsd).toBeCloseTo((24720 * 0.75 + 3633 * 0.075 + 118 * 3.75) / 1_000_000);
  });

  it("isolates agy's state under HOME, signs in with the API key and pins auto-update off", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    const env = lastSpawn.opts.env as Record<string, string>;
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(env.GEMINI_API_KEY).toBe("test-key");
    expect(env.HOME.startsWith(lastSpawn.opts.cwd as string)).toBe(false);
    expect(lastSpawn.settings).toEqual({ modelProvider: "gemini" });
    expect(lastSpawn.stdin).toBe("Hello from AXIS agy adapter");
    expect(lastSpawn.args).not.toContain("Hello from AXIS agy adapter");
  });

  it("marks an ERROR result as a failed run despite exit code 0", async () => {
    mockAgy([
      ev({ event: "init", conversation_id: CONVERSATION_ID, init: { model: "gemini-3.8-flash" } }),
      ev({ event: "result", result: { status: "ERROR", response: "", error: "interrupted" } }),
    ]);

    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.summary.failed).toBe(1);
    expect(output.results[0].output.metadata.error).toBe("interrupted");
  });
});
