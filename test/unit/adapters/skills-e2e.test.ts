import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { EventEmitter, Readable } from "node:stream";
import { silentLogger } from "../../../src/types/output.js";

// Mock spawn, lifecycle, and resolve
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
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

const GEMINI_EVENTS = [
  JSON.stringify({ type: "message", role: "assistant", content: "Done", delta: true }),
  JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 5 } }),
];

// ─── Claude Code ───────────────────────────────────────────────────────────────

describe("Skills e2e — Claude Code", () => {
  const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/skills-claude");
  const origKey = process.env.ANTHROPIC_API_KEY;
  let capturedSkillMd: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    capturedSkillMd = null;

    mockSpawn.mockImplementation(((_cmd: string, _args: string[], opts: any) => {
      const skillPath = path.join(opts.cwd, ".claude", "skills", "test-skill", "SKILL.md");
      if (fs.existsSync(skillPath)) {
        capturedSkillMd = fs.readFileSync(skillPath, "utf-8");
      }
      return createMockProcess(CLAUDE_EVENTS);
    }) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("writes SKILL.md to .claude/skills/ before spawning agent", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(capturedSkillMd).not.toBeNull();
    expect(capturedSkillMd).toContain("AXIS Calculation Skill");
    expect(capturedSkillMd).toContain("magic constant");
    expect(capturedSkillMd).toContain("42");
  });

  it("produces correct results with skills configured", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].output.result).toBe("Done");
    expect(output.summary.completed).toBe(1);
  });
});

// ─── Codex ─────────────────────────────────────────────────────────────────────

describe("Skills e2e — Codex", () => {
  const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/skills-codex");
  const origKey = process.env.CODEX_API_KEY;
  let capturedSkillMd: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEX_API_KEY = "test-key";
    capturedSkillMd = null;

    mockSpawn.mockImplementation(((_cmd: string, _args: string[], opts: any) => {
      const skillPath = path.join(opts.cwd, ".agents", "skills", "test-skill", "SKILL.md");
      if (fs.existsSync(skillPath)) {
        capturedSkillMd = fs.readFileSync(skillPath, "utf-8");
      }
      return createMockProcess(CODEX_EVENTS);
    }) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.CODEX_API_KEY = origKey;
    else delete process.env.CODEX_API_KEY;
  });

  it("writes SKILL.md to .agents/skills/ before spawning agent", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(capturedSkillMd).not.toBeNull();
    expect(capturedSkillMd).toContain("AXIS Calculation Skill");
    expect(capturedSkillMd).toContain("magic constant");
    expect(capturedSkillMd).toContain("42");
  });

  it("produces correct results with skills configured", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].output.result).toBe("Done");
    expect(output.summary.completed).toBe(1);
  });
});

// ─── Gemini ────────────────────────────────────────────────────────────────────

describe("Skills e2e — Gemini", () => {
  const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/skills-gemini");
  const origKey = process.env.GEMINI_API_KEY;
  let capturedSkillMd: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
    capturedSkillMd = null;

    mockSpawn.mockImplementation(((_cmd: string, _args: string[], opts: any) => {
      const geminiHome = opts.env?.GEMINI_CLI_HOME;
      if (geminiHome) {
        const skillPath = path.join(geminiHome, "skills", "test-skill", "SKILL.md");
        if (fs.existsSync(skillPath)) {
          capturedSkillMd = fs.readFileSync(skillPath, "utf-8");
        }
      }
      return createMockProcess(GEMINI_EVENTS);
    }) as any);
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("writes SKILL.md to {GEMINI_CLI_HOME}/skills/ before spawning agent", async () => {
    await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(capturedSkillMd).not.toBeNull();
    expect(capturedSkillMd).toContain("AXIS Calculation Skill");
    expect(capturedSkillMd).toContain("magic constant");
    expect(capturedSkillMd).toContain("42");
  });

  it("produces correct results with skills configured", async () => {
    const output = await run({ configPath: path.join(E2E_DIR, "axis.config.json"), logger: silentLogger });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].output.result).toBe("Done");
    expect(output.summary.completed).toBe(1);
  });
});
