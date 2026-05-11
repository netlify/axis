import { spawn } from "node:child_process";

export interface ResolvedCommand {
  /** The binary to pass to spawn() — either the CLI name or "npx". */
  command: string;
  /** Args to prepend before the adapter's own args — empty for direct, ["--yes", "<pkg>"] for npx. */
  prefixArgs: string[];
}

/** Map of adapter names to their npm package names for npx fallback. */
const NPX_PACKAGES: Record<string, string> = {
  "claude-sdk": "@agentclientprotocol/claude-agent-acp",
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  "codex-sdk": "@zed-industries/codex-acp",
  gemini: "@google/gemini-cli",
  opencode: "opencode-ai",
  "qwen-code": "@qwen-code/qwen-code",
  auggie: "@augmentcode/auggie",
  cline: "cline",
  "factory-droid": "@yaonyan/droid-acp",
  copilot: "@github/copilot",
};

/**
 * Check if a CLI command is available on PATH.
 * Returns true if `<cmd> --version` exits with code 0, false otherwise.
 */
export function isCommandAvailable(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Resolve how to invoke a CLI adapter.
 *
 * 1. Try the bare command (fast path, zero overhead).
 * 2. If not found, fall back to npx with the adapter's npm package.
 * 3. If npx is also not available, throw with install instructions.
 */
export async function resolveCommand(adapterName: string, cliCommand: string): Promise<ResolvedCommand> {
  // Fast path: binary exists on PATH
  if (await isCommandAvailable(cliCommand)) {
    return { command: cliCommand, prefixArgs: [] };
  }

  // Fallback: npx
  const pkg = NPX_PACKAGES[adapterName];
  if (!pkg) {
    throw new Error(`"${cliCommand}" not found on PATH. Install it globally or add it to your PATH.`);
  }

  if (!(await isCommandAvailable("npx"))) {
    throw new Error(`"${cliCommand}" not found and npx is not available. Install it with: npm install -g ${pkg}`);
  }

  return {
    command: "npx",
    prefixArgs: ["--yes", pkg],
  };
}
