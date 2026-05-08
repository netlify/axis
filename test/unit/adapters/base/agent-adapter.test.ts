import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import type { AgentAdapter, AgentInput, AgentMetadata } from "../../../../src/types/agent.js";
import { createAgentAdapter, type SetupContext } from "../../../../src/adapters/base/agent-adapter.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "test-bin", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

function createMockProcess(opts: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  delayMs?: number;
  hang?: boolean;
}) {
  const { stdout: stdoutLines = [], stderr: stderrLines = [], exitCode = 0, delayMs = 0, hang = false } = opts;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { end: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  setTimeout(() => {
    for (const line of stdoutLines) stdout.push(line);
    for (const line of stderrLines) stderr.push(line);
    stdout.push(null);
    stderr.push(null);
    if (!hang) proc.emit("close", exitCode);
  }, delayMs);

  return proc;
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: "hi",
    config: { agent: "test" },
    scenario: {
      key: "t",
      name: "T",
      prompt: "hi",
      rubric: [{ check: "c", weight: 1 }],
    },
    workingDirectory: "/tmp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Adapter factory helpers
// ---------------------------------------------------------------------------

/** Tracking state for the lines-mode test adapter. */
let setupCalls: SetupContext[] = [];
let getResultCalls = 0;
let resultOverride: Partial<AgentMetadata> | null = null;

function createLinesTestAdapter(): AgentAdapter {
  setupCalls = [];
  getResultCalls = 0;
  resultOverride = null;

  return createAgentAdapter<{ lines: string[]; result: string | null }>({
    name: "lines-test",
    cliCommand: "test-bin",

    prepare: (ctx) => {
      setupCalls.push(ctx);
    },

    buildArgs: () => ["--flag"],

    initialState: () => ({ lines: [], result: null }),

    streamConfig: {
      mode: "lines",
      onLine: (line, ctx) => {
        ctx.state.lines.push(line);
        ctx.state.result = line;
        ctx.feedAssistantText(line);
      },
      onEnd: () => {},
    },

    getResult: (ctx) => {
      getResultCalls += 1;
      return {
        result: ctx.state.result,
        metadata: resultOverride ?? {},
      };
    },
  });
}

function createAggregateTestAdapter(): AgentAdapter {
  return createAgentAdapter<{ stdout: string }>({
    name: "agg-test",
    cliCommand: "test-bin",

    buildArgs: () => [],
    initialState: () => ({ stdout: "" }),

    streamConfig: {
      mode: "aggregate",
      onChunk: (chunk, ctx) => {
        ctx.state.stdout += chunk;
      },
    },

    getResult: (ctx) => ({
      result: ctx.state.stdout.trim() || null,
    }),
  });
}

function createNoCliAdapter(): AgentAdapter {
  return createAgentAdapter<{ v: number }>({
    name: "no-cli",
    // no cliCommand
    buildArgs: () => [],
    initialState: () => ({ v: 0 }),
    streamConfig: { mode: "lines", onLine: () => {} },
    getResult: () => ({ result: null }),
  });
}

function createShortTimeoutAdapter(): AgentAdapter {
  return createAgentAdapter<{ lines: string[]; result: string | null }>({
    name: "timeout-test",
    cliCommand: "test-bin",
    timeoutMs: 50,

    buildArgs: () => [],
    initialState: () => ({ lines: [], result: null }),

    streamConfig: {
      mode: "lines",
      onLine: (line, ctx) => {
        ctx.state.result = line;
      },
    },

    getResult: () => {
      getResultCalls += 1;
      return { result: null };
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getResultCalls = 0;
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: ["ok\n"], exitCode: 0 })) as any);
  });

  it("populates metadata startTime/endTime/durationMs/exitCode on success", async () => {
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput());

    expect(out.result).toBe("ok");
    expect(out.metadata.exitCode).toBe(0);
    expect(typeof out.metadata.startTime).toBe("string");
    expect(typeof out.metadata.endTime).toBe("string");
    expect(out.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("merges result metadata overrides on top of base-computed fields", async () => {
    const adapter = createLinesTestAdapter();
    resultOverride = { totalCostUsd: 0.42, sessionId: "s1", durationMs: 99999 };
    const out = await adapter.run(makeInput());

    expect(out.metadata.totalCostUsd).toBe(0.42);
    expect(out.metadata.sessionId).toBe("s1");
    expect(out.metadata.durationMs).toBe(99999);
  });

  it("awaits prepare before spawning", async () => {
    let prepareDone = false;

    const adapter = createAgentAdapter<{ result: string | null }>({
      name: "async-prepare",
      cliCommand: "test-bin",
      prepare: async () => {
        await new Promise((r) => setTimeout(r, 5));
        prepareDone = true;
      },
      buildArgs: () => [],
      initialState: () => ({ result: null }),
      streamConfig: {
        mode: "lines",
        onLine: (line, ctx) => {
          ctx.state.result = line;
        },
      },
      getResult: (ctx) => ({ result: ctx.state.result }),
    });

    let spawnedAfterPrepare = false;
    mockSpawn.mockImplementation((() => {
      spawnedAfterPrepare = prepareDone;
      return createMockProcess({ stdout: ["ok\n"] });
    }) as any);

    await adapter.run(makeInput());
    expect(spawnedAfterPrepare).toBe(true);
  });

  it("passes workingDirectory and env to prepare context", async () => {
    const adapter = createLinesTestAdapter();
    await adapter.run(makeInput({ workingDirectory: "/my/ws", env: { FOO: "bar" } }));

    expect(setupCalls[0].workingDirectory).toBe("/my/ws");
    expect(setupCalls[0].env).toEqual({ FOO: "bar" });
  });

  it("prepends resolved prefixArgs to args output", async () => {
    const { resolveCommand } = await import("../../../../src/adapters/utils/resolve.js");
    vi.mocked(resolveCommand).mockResolvedValueOnce({ command: "npx", prefixArgs: ["--yes", "pkg"] });

    let captured: string[] = [];
    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      captured = args;
      return createMockProcess({ stdout: ["ok\n"] });
    }) as any);

    const adapter = createLinesTestAdapter();
    await adapter.run(makeInput());
    expect(captured).toEqual(["--yes", "pkg", "--flag"]);
  });

  it("uses stderr as error when exitCode non-zero and result null", async () => {
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: [], stderr: ["boom\n"], exitCode: 2 })) as any);
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput());

    expect(out.result).toBeNull();
    expect(out.metadata.exitCode).toBe(2);
    expect(out.metadata.error).toBe("boom\n");
  });

  it("getResult metadata.error wins over stderr on failure", async () => {
    mockSpawn.mockImplementation((() =>
      createMockProcess({ stdout: [], stderr: ["stderr msg\n"], exitCode: 2 })) as any);
    const adapter = createLinesTestAdapter();
    resultOverride = { error: "custom error from getResult" };

    const out = await adapter.run(makeInput());
    expect(out.metadata.error).toBe("custom error from getResult");
  });

  it("uses generic fallback when stderr empty and no getResult error", async () => {
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: [], exitCode: 3 })) as any);
    const adapter = createLinesTestAdapter();

    const out = await adapter.run(makeInput());
    expect(out.metadata.error).toBe("Agent process exited with non-zero code");
  });

  it("does NOT set error when exitCode non-zero but result is non-null", async () => {
    mockSpawn.mockImplementation((() =>
      createMockProcess({ stdout: ["partial\n"], stderr: ["warn\n"], exitCode: 1 })) as any);
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput());

    expect(out.result).toBe("partial");
    expect(out.metadata.error).toBeUndefined();
  });

  it("timeout path: getResult not called, error set", async () => {
    mockSpawn.mockImplementation((() => {
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin: { end: vi.fn() },
        kill: vi.fn(),
      });
      proc.kill = vi.fn(() => {
        setTimeout(() => {
          stdout.push(null);
          stderr.push(null);
          proc.emit("close", 143);
        }, 1);
        return true;
      });
      return proc;
    }) as any);

    getResultCalls = 0;
    const adapter = createShortTimeoutAdapter();
    const out = await adapter.run(makeInput());

    expect(out.metadata.error).toMatch(/timed out/i);
    expect(getResultCalls).toBe(0);
  });

  it("onEnd runs in finally even if stdout errors", async () => {
    let endCalls = 0;
    const adapter = createAgentAdapter<{ r: string | null }>({
      name: "err-stream",
      cliCommand: "test-bin",
      buildArgs: () => [],
      initialState: () => ({ r: null }),
      streamConfig: {
        mode: "lines",
        onLine: () => {},
        onEnd: () => {
          endCalls += 1;
        },
      },
      getResult: () => ({ result: null }),
    });

    mockSpawn.mockImplementation((() => {
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin: { end: vi.fn() },
        kill: vi.fn(),
      });
      setTimeout(() => {
        stdout.destroy(new Error("stream broke"));
        stderr.push(null);
        proc.emit("close", 1);
      }, 5);
      return proc;
    }) as any);

    await adapter.run(makeInput());
    expect(endCalls).toBe(1);
  });

  it("raw output capture in lines mode = one entry per line", async () => {
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: ["one\n", "two\n", "three\n"] })) as any);
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput({ captureRawOutput: true }));

    expect(out.rawOutput).toEqual(["one", "two", "three"]);
  });

  it("raw output capture in aggregate mode = chunks preserved", async () => {
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: ["chunk-1", "chunk-2"] })) as any);
    const adapter = createAggregateTestAdapter();
    const out = await adapter.run(makeInput({ captureRawOutput: true }));

    expect(out.rawOutput?.join("")).toBe("chunk-1chunk-2");
  });

  it("rawOutput is undefined when captureRawOutput is not set", async () => {
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput());
    expect(out.rawOutput).toBeUndefined();
  });

  it("default resolveCommand: prefers resolved, else config.command, else throws", async () => {
    const adapter = createNoCliAdapter();
    // No command + no cliCommand → throws
    await expect(adapter.run(makeInput())).rejects.toThrow(/no command to spawn/);

    // With config.command → spawns it
    let usedCmd = "";
    mockSpawn.mockImplementation(((cmd: string) => {
      usedCmd = cmd;
      return createMockProcess({ stdout: [] });
    }) as any);

    const input = makeInput();
    input.config.command = "my-agent";
    await adapter.run(input);
    expect(usedCmd).toBe("my-agent");
  });

  it("calls registerCleanup with a SIGTERM kill callback", async () => {
    const cleanupFns: Array<() => void> = [];
    const fakeChild = createMockProcess({ stdout: ["ok\n"] });
    mockSpawn.mockImplementation((() => fakeChild) as any);

    const adapter = createLinesTestAdapter();
    await adapter.run(
      makeInput({
        registerCleanup: (fn) => cleanupFns.push(fn),
      }),
    );

    expect(cleanupFns).toHaveLength(1);
    cleanupFns[0]();
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("caps stderr at maxStderrBytes to avoid unbounded growth", async () => {
    const oversize = "X".repeat(150_000);
    mockSpawn.mockImplementation((() => createMockProcess({ stdout: [], stderr: [oversize], exitCode: 1 })) as any);
    const adapter = createLinesTestAdapter();
    const out = await adapter.run(makeInput());

    expect(out.metadata.error?.length).toBeLessThan(200_000);
  });

  it("custom resolveCommand overrides default resolution", async () => {
    let usedCmd = "";
    mockSpawn.mockImplementation(((cmd: string) => {
      usedCmd = cmd;
      return createMockProcess({ stdout: [] });
    }) as any);

    const adapter = createAgentAdapter<{ r: null }>({
      name: "custom-resolve",
      resolveCommand: () => ({ command: "my-custom-bin", prefixArgs: ["x"] }),
      buildArgs: () => ["y"],
      initialState: () => ({ r: null }),
      streamConfig: { mode: "lines", onLine: () => {} },
      getResult: () => ({ result: null }),
    });

    await adapter.run(makeInput());
    expect(usedCmd).toBe("my-custom-bin");
  });
});
