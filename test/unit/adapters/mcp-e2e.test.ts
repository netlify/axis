import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { EventEmitter, Readable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

// Mock spawn, lifecycle, and resolve
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "agent", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
import { run } from "../../../src/runner/runner.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess(lines: string[], exitCode = 0) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { end: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  setTimeout(() => {
    for (const line of lines) {
      stdout.push(line + "\n");
    }
    stdout.push(null);
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

// Minimal NDJSON events for each adapter
const CLAUDE_EVENTS = [
  JSON.stringify({ type: "result", result: "Done", duration_ms: 100, usage: { input_tokens: 10, output_tokens: 5 } }),
];

const CODEX_EVENTS = [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
];

// Expected MCP config content (JSON format — used by Claude Code)
const EXPECTED_JSON_MCP = {
  mcpServers: {
    netlify: {
      type: "http",
      url: "https://mcp.netlify.com",
      headers: { Authorization: "Bearer test-token" },
    },
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
};

// ─── Claude Code ───────────────────────────────────────────────────────────────

describe("MCP e2e — Claude Code", () => {
  const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/mcp-claude");
  const origKey = process.env.ANTHROPIC_API_KEY;
  let capturedMcpConfig: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    capturedMcpConfig = null;

    mockSpawn.mockImplementation(((_cmd: string, _args: string[], opts: any) => {
      // At spawn time, .mcp.json should already be written to the workspace
      const mcpPath = path.join(opts.cwd, ".mcp.json");
      if (fs.existsSync(mcpPath)) {
        capturedMcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      }
      return createMockProcess(CLAUDE_EVENTS);
    }) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("writes .mcp.json with correct MCP config before spawning agent", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(capturedMcpConfig).not.toBeNull();
    expect(capturedMcpConfig).toEqual(EXPECTED_JSON_MCP);
  });

  it("produces correct results with MCP servers configured", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].output.result).toBe("Done");
    expect(output.summary.completed).toBe(1);
  });
});

// ─── Codex ─────────────────────────────────────────────────────────────────────

describe("MCP e2e — Codex", () => {
  const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/mcp-codex");
  const origKey = process.env.CODEX_API_KEY;
  let capturedToml: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEX_API_KEY = "test-key";
    capturedToml = null;

    mockSpawn.mockImplementation(((_cmd: string, _args: string[], opts: any) => {
      // At spawn time, config.toml should already be written to CODEX_HOME
      const codexHome = opts.env?.CODEX_HOME;
      if (codexHome) {
        const tomlPath = path.join(codexHome, "config.toml");
        if (fs.existsSync(tomlPath)) {
          capturedToml = fs.readFileSync(tomlPath, "utf-8");
        }
      }
      return createMockProcess(CODEX_EVENTS);
    }) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.CODEX_API_KEY = origKey;
    else delete process.env.CODEX_API_KEY;
  });

  it("writes config.toml with correct MCP config before spawning agent", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(capturedToml).not.toBeNull();

    // Verify TOML contains the expected sections
    expect(capturedToml).toContain("[mcp_servers.netlify]");
    expect(capturedToml).toContain('type = "http"');
    expect(capturedToml).toContain('url = "https://mcp.netlify.com"');
    expect(capturedToml).toContain("[mcp_servers.netlify.headers]");
    expect(capturedToml).toContain('Authorization = "Bearer test-token"');

    expect(capturedToml).toContain("[mcp_servers.filesystem]");
    expect(capturedToml).toContain('command = "npx"');
    expect(capturedToml).toContain('args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]');
  });

  it("produces correct results with MCP servers configured", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].output.result).toBe("Done");
    expect(output.summary.completed).toBe(1);
  });
});

// Note: Gemini's MCP wiring moved to ACP `session/new` — covered by the ACP adapter test.
