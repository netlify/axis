import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createClaudeCodeAdapter } from "../../../src/adapters/claude-code.js";
import type { AgentAdapter } from "../../../src/types/agent.js";
import type { AgentInput } from "../../../src/types/agent.js";
import type * as ChildProcess from "node:child_process";
import { EventEmitter, Readable } from "node:stream";

// Mock child_process.spawn while preserving other exports (execFile, etc.
// used by sibling utility modules like local-session)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

// Mock resolve so adapters skip the real CLI check
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "claude", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

function createMockProcess(lines: string[], exitCode = 0) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { end: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin });

  // Push lines async so readline can consume them
  setTimeout(() => {
    for (const line of lines) {
      stdout.push(line + "\n");
    }
    stdout.push(null); // EOF
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

function makeInput(prompt = "test prompt"): AgentInput {
  return {
    prompt,
    config: { agent: "claude-code" },
    scenario: {
      key: "test",
      name: "Test",
      prompt,
      judge: [{ check: "test", weight: 1.0 }],
    },
    workingDirectory: "/tmp",
  };
}

describe("ClaudeCodeAdapter", () => {
  let adapter: AgentAdapter;

  beforeEach(() => {
    adapter = createClaudeCodeAdapter();
    vi.clearAllMocks();

    mockSpawn.mockImplementation((() => {
      return createMockProcess([]);
    }) as any);
  });

  it("has name 'claude-code'", () => {
    expect(adapter.name).toBe("claude-code");
  });

  it("requires ANTHROPIC_API_KEY environment variable", () => {
    expect(adapter.requiredEnv!()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("exposes hasLocalSession for `claude login` fallback", () => {
    expect(typeof adapter.hasLocalSession).toBe("function");
  });

  it("parses assistant messages from NDJSON stream", async () => {
    const messages = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({
        type: "result",
        result: "Done",
        duration_ms: 1000,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(messages)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(1);
    expect(output.transcript[0].type).toBe("assistant");
    expect(output.result).toBe("Done");
    expect(output.metadata.totalCostUsd).toBe(0.01);
    expect(output.metadata.tokenUsage?.input).toBe(100);
    expect(output.metadata.tokenUsage?.output).toBe(50);
    expect(output.metadata.durationMs).toBe(1000);
  });

  it("skips stream_event and tool_progress messages", async () => {
    const messages = [
      JSON.stringify({ type: "stream_event", data: "partial" }),
      JSON.stringify({ type: "tool_progress", progress: 50 }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }),
      JSON.stringify({ type: "result", result: "Done" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(messages)) as any);

    const output = await adapter.run(makeInput());

    expect(output.transcript).toHaveLength(1);
    expect(output.transcript[0].type).toBe("assistant");
  });

  it("handles non-zero exit with no result message", async () => {
    mockSpawn.mockImplementation((() => createMockProcess([], 1)) as any);

    const output = await adapter.run(makeInput());

    expect(output.metadata.exitCode).toBe(1);
    expect(output.result).toBeNull();
  });

  it("passes --model flag when config specifies model", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([JSON.stringify({ type: "result", result: "ok" })]);
    }) as any);

    const input = makeInput();
    input.config.model = "sonnet";
    await adapter.run(input);

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("sonnet");
  });

  it("includes --dangerously-skip-permissions by default", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([JSON.stringify({ type: "result", result: "ok" })]);
    }) as any);

    await adapter.run(makeInput());

    expect(capturedArgs).toContain("--dangerously-skip-permissions");
  });

  it("omits --dangerously-skip-permissions when explicitly set to false", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([JSON.stringify({ type: "result", result: "ok" })]);
    }) as any);

    const input = makeInput();
    input.config.flags = { "dangerously-skip-permissions": false };
    await adapter.run(input);

    expect(capturedArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("passes through additional flags from config", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([JSON.stringify({ type: "result", result: "ok" })]);
    }) as any);

    const input = makeInput();
    input.config.flags = {
      "max-turns": "10",
      verbose: true,
      "no-cache": false,
    };
    await adapter.run(input);

    expect(capturedArgs).toContain("--max-turns");
    expect(capturedArgs).toContain("10");
    expect(capturedArgs).toContain("--verbose");
    expect(capturedArgs).not.toContain("--no-cache");
  });

  it("captures raw output when captureRawOutput is true", async () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: "hello" }),
      JSON.stringify({ type: "result", result: "done" }),
    ];

    mockSpawn.mockImplementation((() => createMockProcess(lines)) as any);

    const input = makeInput();
    input.captureRawOutput = true;
    const output = await adapter.run(input);

    expect(output.rawOutput).toEqual(lines);
  });

  it("does not capture raw output by default", async () => {
    mockSpawn.mockImplementation((() =>
      createMockProcess([JSON.stringify({ type: "result", result: "done" })])) as any);

    const output = await adapter.run(makeInput());

    expect(output.rawOutput).toBeUndefined();
  });

  it("passes --strict-mcp-config so only AXIS-declared MCP servers are used", async () => {
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args as string[];
      return createMockProcess([JSON.stringify({ type: "result", result: "ok" })]);
    }) as any);

    await adapter.run(makeInput());

    expect(capturedArgs).toContain("--strict-mcp-config");
    // No scenario-declared servers → no --mcp-config path
    expect(capturedArgs).not.toContain("--mcp-config");
  });

  // Tool-isolation: when propagating the operator's local OAuth session (no
  // ANTHROPIC_API_KEY), prepare() must strip the operator's personal MCP
  // config out of the copied `.claude.json` so it doesn't leak into the run.
  describe("prepare() OAuth session propagation", () => {
    let fakeHome: string;
    let configDir: string;
    let originalHome: string | undefined;
    let originalUserprofile: string | undefined;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "axis-claude-prepare-"));
      configDir = path.join(fakeHome, "isolated", ".claude");
      originalHome = process.env.HOME;
      originalUserprofile = process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      // A logged-in `.claude.json`: OAuth anchor + operator's personal MCP config.
      fs.writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({
          oauthAccount: { emailAddress: "op@example.com", accountUuid: "uuid-123" },
          mcpServers: {
            notion: { type: "http", url: "https://notion.example" },
            bluesky: { command: "bsky" },
          },
          projects: {
            "/work/repo": { mcpServers: { "internal-apps": { command: "internal" } }, allowedTools: ["Read"] },
          },
        }),
      );
      // Pre-create `.credentials.json` so prepare copies it and skips the
      // macOS Keychain extraction path (no real `security` call in tests).
      fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), '{"token":"x"}');
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserprofile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserprofile;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    it("stages a `.claude.json` that keeps oauthAccount but has no MCP config", async () => {
      const input = makeInput();
      // No ANTHROPIC_API_KEY in env → OAuth propagation path runs.
      input.env = { CLAUDE_CONFIG_DIR: configDir };
      input.homeDirectory = path.join(fakeHome, "isolated-home");

      await adapter.run(input);

      const staged = JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8"));
      expect(staged.oauthAccount).toEqual({ emailAddress: "op@example.com", accountUuid: "uuid-123" });
      expect(staged.mcpServers).toBeUndefined();
      expect(staged.projects["/work/repo"].mcpServers).toBeUndefined();
      // Non-MCP project data survives.
      expect(staged.projects["/work/repo"].allowedTools).toEqual(["Read"]);
    });
  });
});
