import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:stream";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { resolveCommand, isCommandAvailable } from "../../../../src/adapters/utils/resolve.js";

const mockSpawn = vi.mocked(spawn);

function mockCommandResult(exitCode: number, error = false) {
  const proc = Object.assign(new EventEmitter(), {});
  setTimeout(() => {
    if (error) {
      proc.emit("error", new Error("ENOENT"));
    } else {
      proc.emit("close", exitCode);
    }
  }, 5);
  return proc;
}

describe("isCommandAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when command exits with code 0", async () => {
    mockSpawn.mockReturnValue(mockCommandResult(0) as any);

    const result = await isCommandAvailable("claude");

    expect(result).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith("claude", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  });

  it("returns false when command exits with non-zero code", async () => {
    mockSpawn.mockReturnValue(mockCommandResult(1) as any);

    const result = await isCommandAvailable("claude");

    expect(result).toBe(false);
  });

  it("returns false when command spawn errors (ENOENT)", async () => {
    mockSpawn.mockReturnValue(mockCommandResult(0, true) as any);

    const result = await isCommandAvailable("nonexistent");

    expect(result).toBe(false);
  });
});

describe("resolveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns direct command when binary is available", async () => {
    mockSpawn.mockReturnValue(mockCommandResult(0) as any);

    const result = await resolveCommand("claude-code", "claude");

    expect(result).toEqual({ command: "claude", prefixArgs: [] });
  });

  it("returns npx fallback when binary is not found but npx is available", async () => {
    let callCount = 0;
    mockSpawn.mockImplementation(((_cmd: string) => {
      callCount++;
      if (callCount === 1) {
        // First call: "claude --version" fails
        return mockCommandResult(0, true);
      }
      // Second call: "npx --version" succeeds
      return mockCommandResult(0);
    }) as any);

    const result = await resolveCommand("claude-code", "claude");

    expect(result).toEqual({
      command: "npx",
      prefixArgs: ["--yes", "@anthropic-ai/claude-code"],
    });
  });

  it("uses correct package name for codex", async () => {
    let callCount = 0;
    mockSpawn.mockImplementation((() => {
      callCount++;
      if (callCount === 1) return mockCommandResult(0, true);
      return mockCommandResult(0);
    }) as any);

    const result = await resolveCommand("codex", "codex");

    expect(result.prefixArgs).toEqual(["--yes", "@openai/codex"]);
  });

  it("uses correct package name for gemini", async () => {
    let callCount = 0;
    mockSpawn.mockImplementation((() => {
      callCount++;
      if (callCount === 1) return mockCommandResult(0, true);
      return mockCommandResult(0);
    }) as any);

    const result = await resolveCommand("gemini", "gemini");

    expect(result.prefixArgs).toEqual(["--yes", "@google/gemini-cli"]);
  });

  it("throws when binary not found and no npx package mapped", async () => {
    mockSpawn.mockReturnValue(mockCommandResult(0, true) as any);

    await expect(resolveCommand("unknown-adapter", "unknown-cli")).rejects.toThrow('"unknown-cli" not found on PATH');
  });

  it("throws when binary not found and npx is not available", async () => {
    // Both "claude" and "npx" fail — need fresh emitter per call
    mockSpawn.mockImplementation((() => mockCommandResult(0, true)) as any);

    await expect(resolveCommand("claude-code", "claude")).rejects.toThrow(
      '"claude" not found and npx is not available',
    );
  });
});
