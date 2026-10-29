import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as ChildProcess from "node:child_process";
import { EventEmitter, Readable } from "node:stream";
import { createAgyAdapter, agyCostUsd, baseModel } from "../../../src/adapters/agy.js";
import type { AgentAdapter, AgentInput } from "../../../src/types/agent.js";
import { normalizeTranscript } from "../../../src/transcript/normalize.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "agy", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

const CONVERSATION_ID = "e32c0a56-6889-4d09-855f-21dcbedce5fa";

function createMockProcess(lines: string[], { exitCode = 0, stderr = "" } = {}) {
  const stdout = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdin = { end: vi.fn(), on: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr: stderrStream, stdin, kill: vi.fn() });

  setTimeout(() => {
    if (stderr) stderrStream.push(stderr);
    stderrStream.push(null);
    for (const line of lines) stdout.push(line + "\n");
    stdout.push(null);
    setTimeout(() => proc.emit("close", exitCode), 5);
  }, 10);

  return proc;
}

const init = (model = "gemini-3.8-flash") =>
  JSON.stringify({ event: "init", conversation_id: CONVERSATION_ID, init: { model, cwd: "/tmp/work", tools: [] } });

const step = (s: Record<string, unknown>) =>
  JSON.stringify({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, ...s } });

const result = (r: Record<string, unknown>) =>
  JSON.stringify({ event: "result", result: { conversation_id: CONVERSATION_ID, ...r } });

const usage = (input: number, output: number, cache = 0) => ({
  input_tokens: input,
  output_tokens: output,
  thinking_tokens: 0,
  cache_read_tokens: cache,
  total_tokens: input + output,
});

let tmpRoot: string;

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    prompt: "test prompt",
    config: { agent: "agy" },
    scenario: { key: "test", name: "Test", prompt: "test prompt", judge: [{ check: "test", weight: 1.0 }] },
    workingDirectory: tmpRoot,
    homeDirectory: home,
    ...overrides,
  };
}

function mockRun(lines: string[], opts?: { exitCode?: number; stderr?: string }) {
  mockSpawn.mockImplementation((() => createMockProcess(lines, opts)) as never);
}

describe("agy adapter", () => {
  let adapter: AgentAdapter;

  beforeEach(() => {
    adapter = createAgyAdapter();
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
    mockRun([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("requires GEMINI_API_KEY and disables auto-update with the exact value agy accepts", () => {
    expect(adapter.requiredEnv!()).toEqual(["GEMINI_API_KEY"]);
    expect(adapter.isolationEnv!({ workspace: "/w", home: "/h" })).toEqual({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  });

  it("runs headless with the prompt on stdin", async () => {
    await adapter.run(makeInput({ config: { agent: "agy", model: "gemini-3.1-pro", flags: { effort: "high" } } }));

    const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "24h",
      "--model",
      "gemini-3.1-pro",
      "--effort",
      "high",
    ]);
    expect(args).not.toContain("test prompt");
    const proc = mockSpawn.mock.results[0].value as { stdin: { end: ReturnType<typeof vi.fn> } };
    expect(proc.stdin.end).toHaveBeenCalledWith("test prompt");
  });

  it("drops --dangerously-skip-permissions when the flag is false", async () => {
    await adapter.run(makeInput({ config: { agent: "agy", flags: { "dangerously-skip-permissions": false } } }));

    const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("lets a flag replace the default of the same name, except the output format", async () => {
    await adapter.run(
      makeInput({
        config: {
          agent: "agy",
          model: "gemini-3.8-flash",
          flags: { model: "gemini-3.1-pro-low", "print-timeout": "1h", "output-format": "json" },
        },
      }),
    );

    const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    const valuesOf = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(valuesOf("--model")).toEqual(["gemini-3.1-pro-low"]);
    expect(valuesOf("--print-timeout")).toEqual(["1h"]);
    expect(valuesOf("--output-format")).toEqual(["stream-json"]);
  });

  it("keeps a default when its flag is false instead of dropping the option", async () => {
    await adapter.run(makeInput({ config: { agent: "agy", flags: { "print-timeout": false, verbose: false } } }));

    const [, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain("24h");
    expect(args).not.toContain("--verbose");
  });

  it("writes the gemini modelProvider setting under the isolated HOME", async () => {
    const input = makeInput();
    await adapter.run(input);

    const settings = JSON.parse(
      fs.readFileSync(path.join(input.homeDirectory, ".gemini", "antigravity-cli", "settings.json"), "utf-8"),
    );
    expect(settings).toEqual({ modelProvider: "gemini" });
  });

  it("writes MCP servers to ~/.gemini/config/mcp_config.json", async () => {
    const input = makeInput({
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["server.js"] },
        remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    await adapter.run(input);

    const config = JSON.parse(
      fs.readFileSync(path.join(input.homeDirectory, ".gemini", "config", "mcp_config.json"), "utf-8"),
    );
    expect(config.mcpServers).toEqual({
      local: { command: "node", args: ["server.js"], env: {} },
      remote: { serverUrl: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
    });
  });

  it("installs skills under ~/.gemini/config/skills", async () => {
    const skillSrc = path.join(tmpRoot, "skill-src");
    fs.mkdirSync(skillSrc);
    fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "# greeter\n");
    const input = makeInput({ resolvedSkills: [{ name: "greeter", path: skillSrc }] });
    await adapter.run(input);

    expect(fs.existsSync(path.join(input.homeDirectory, ".gemini", "config", "skills", "greeter", "SKILL.md"))).toBe(
      true,
    );
  });

  it("assembles streamed text, tool pairs, usage and the result", async () => {
    mockRun([
      init(),
      step({ step_index: 0, state: "DONE", step_type: "user_input" }),
      step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: usage(12149, 99) }),
      step({
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
      }),
      step({
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, output: "README.md\n" },
      }),
      step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " }),
      step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "world", usage: usage(12500, 40) }),
      result({ status: "SUCCESS", response: "Hello world\n", duration_seconds: 7.5, usage: usage(24649, 139) }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.result).toBe("Hello world");
    expect(output.metadata.error).toBeUndefined();
    expect(output.metadata.sessionId).toBe(CONVERSATION_ID);
    expect(output.metadata.durationMs).toBe(7500);
    expect(output.metadata.tokenUsage).toEqual({ input: 24649, output: 139, cacheReadInput: 0 });
    expect(output.transcript.map((e) => e.type)).toEqual(["tool_use", "tool_result", "assistant"]);
    expect(output.transcript[0].content).toMatchObject({
      tool_name: "run_command",
      kind: "execute",
      parameters: { CommandLine: "ls" },
    });
    expect(output.transcript[1].content).toMatchObject({ tool_name: "run_command", output: "README.md\n" });
    expect(output.transcript[2].content.text).toBe("Hello world");
  });

  it("sums usage per step rather than trusting the cumulative result.usage", async () => {
    mockRun([
      init(),
      step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: usage(19235, 122) }),
      step({
        step_index: 3,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "ok",
        // Real cached step: cache reads exceed input_tokens.
        usage: usage(2331, 1566, 17177),
      }),
      result({ status: "SUCCESS", response: "ok", usage: usage(99999, 999, 0) }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.metadata.tokenUsage).toEqual({ input: 21566, output: 1688, cacheReadInput: 17177 });
  });

  it("prices the run from per-step usage and the model init reports", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-16T00:00:00Z") });
    mockRun([
      init("gemini-3.8-flash-low"),
      step({
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "ok",
        usage: usage(600_000, 100_000, 400_000),
      }),
      result({ status: "SUCCESS", response: "ok" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.metadata.totalCostUsd).toBeCloseTo(0.45 + 0.03 + 0.375);
  });

  it("prices the run at the date it ran, so the 2027 Flash rates apply from then", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2027-01-01T00:00:00Z") });
    mockRun([
      init("gemini-3.8-flash"),
      step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ok", usage: usage(1_000_000, 0) }),
      result({ status: "SUCCESS", response: "ok" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.metadata.totalCostUsd).toBeCloseTo(1.5);
  });

  it("fails the run on a non-SUCCESS result even though agy exits 0", async () => {
    mockRun([
      init(),
      step({ step_index: 1, state: "DONE", step_type: "error_message" }),
      result({ status: "ERROR", response: "", error: "API error (attempt 4): request failed (code 500)" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.metadata.exitCode).toBe(0);
    expect(output.result).toBeNull();
    expect(output.metadata.error).toBe("API error (attempt 4): request failed (code 500)");
    expect(output.transcript.at(-1)?.type).toBe("error");
  });

  it("names the status when a non-SUCCESS result carries no error", async () => {
    mockRun([init(), result({ status: "TIMEOUT", response: "" })]);

    const output = await adapter.run(makeInput());

    expect(output.result).toBeNull();
    expect(output.metadata.error).toBe("agy finished with status TIMEOUT");
  });

  it("falls back to stderr when neither a result nor an AGY_ERROR line arrives", async () => {
    mockRun([init()], { stderr: "panic: something agy did not report\n" });

    const output = await adapter.run(makeInput());

    expect(output.result).toBeNull();
    expect(output.metadata.error).toBe("panic: something agy did not report");
  });

  it("names the missing result when agy exits silently", async () => {
    mockRun([init()]);

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("agy exited without a result");
  });

  it("reports agy's AGY_ERROR line when no result event arrives", async () => {
    mockRun([init()], {
      stderr: 'AGY_ERROR: {"short_error":"Invalid Accept header value","status":"INVALID_ARGUMENT","error_code":400}\n',
    });

    const output = await adapter.run(makeInput());

    expect(output.metadata.error).toBe("Invalid Accept header value");
  });

  it("records a tool step that ends in ERROR as an error scoring can count", async () => {
    mockRun([
      init(),
      step({
        step_index: 2,
        state: "ERROR",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { parameters: { TargetFile: "/tmp/work/a.txt" }, error: { message: "permission check failed" } },
      }),
      result({ status: "SUCCESS", response: "done" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.transcript.map((e) => e.type)).toEqual(["tool_use", "error"]);
    expect(output.transcript[1].content).toMatchObject({
      tool_name: "write_to_file",
      tool_id: "2",
      error: "Tool failed: write_to_file: permission check failed",
    });
    expect(normalizeTranscript(output.transcript).entries.filter((e) => e.isError)).toHaveLength(1);
  });

  it("pairs interleaved tool steps by step index", async () => {
    const tool = (index: number, state: string, output?: string) =>
      step({
        step_index: index,
        state,
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: `cmd ${index}` }, ...(output ? { output } : {}) },
      });
    mockRun([
      init(),
      tool(2, "ACTIVE"),
      tool(3, "ACTIVE"),
      tool(2, "DONE", "out 2"),
      tool(3, "DONE", "out 3"),
      // A repeated DONE must not open a second interaction.
      tool(3, "DONE", "out 3"),
      result({ status: "SUCCESS", response: "done" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.transcript.map((e) => `${e.type}:${String(e.content.tool_id)}`)).toEqual([
      "tool_use:2",
      "tool_use:3",
      "tool_result:2",
      "tool_result:3",
    ]);
    const entries = normalizeTranscript(output.transcript).entries;
    expect(entries[0].pairedIndex).toBe(2);
    expect(entries[1].pairedIndex).toBe(3);
  });

  it("names MCP calls mcp__<server>__<tool> with their own arguments", async () => {
    mockRun([
      init(),
      step({
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "call_mcp_tool",
        tool_info: { parameters: { ServerName: "echo", ToolName: "say", Arguments: '{"text":"hi"}' } },
      }),
      step({
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "call_mcp_tool",
        tool_info: { parameters: { ServerName: "echo", ToolName: "say", Arguments: { text: "yo" } } },
      }),
      result({ status: "SUCCESS", response: "done" }),
    ]);

    const output = await adapter.run(makeInput());

    expect(output.transcript[0].content).toMatchObject({ tool_name: "mcp__echo__say", parameters: { text: "hi" } });
    expect(output.transcript[2].content).toMatchObject({ tool_name: "mcp__echo__say", parameters: { text: "yo" } });
  });
});

describe("agy pricing", () => {
  it("strips the effort suffix agy accepts on model names", () => {
    expect(baseModel("gemini-3.8-flash-medium")).toBe("gemini-3.8-flash");
    expect(baseModel("gemini-3.1-pro")).toBe("gemini-3.1-pro");
  });

  it("uses the >200k prompt tier for Gemini 3.1 Pro per model call", () => {
    const at = new Date("2026-10-16");
    expect(agyCostUsd("gemini-3.1-pro-high", [usage(100_000, 0)], at)).toBeCloseTo(0.2);
    expect(agyCostUsd("gemini-3.1-pro-high", [usage(300_000, 0)], at)).toBeCloseTo(1.2);
    // The tier follows the whole prompt, cache reads included.
    expect(agyCostUsd("gemini-3.1-pro-high", [usage(100_000, 0, 150_000)], at)).toBeCloseTo(0.4 + 0.06);
  });

  it("applies the 2027 Flash price rise", () => {
    expect(agyCostUsd("gemini-3.6-flash", [usage(1_000_000, 0)], new Date("2027-01-02"))).toBeCloseTo(1.5);
  });

  it("reports no cost for an unpriced model rather than zero", () => {
    expect(agyCostUsd("gemini-3.7-flash", [usage(1000, 10)], new Date("2026-10-16"))).toBeUndefined();
  });
});
