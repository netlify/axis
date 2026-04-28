import * as path from "node:path";
import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";
import { writeClaudeSkills } from "./utils/skills.js";

/**
 * SDK-based Claude adapter. Uses `claude-agent-acp` — an ACP bridge built
 * on the official Claude Agent SDK — to communicate with Claude via the
 * Agent Client Protocol over stdio.
 *
 * MCP servers are passed through the ACP `session/new` call rather than
 * written to .mcp.json in the workspace.
 */
export function createClaudeSdkAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "claude-sdk",
    cliCommand: "claude-agent-acp",

    requiredEnv: () => ["ANTHROPIC_API_KEY"],

    isolationEnv: (workspace) => ({
      CLAUDE_CONFIG_DIR: path.join(workspace, ".claude"),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    }),

    buildArgs: (input) => {
      const args: string[] = [];
      if (input.config.model) args.push("--model", input.config.model);

      const flags = input.config.flags ?? {};
      for (const [key, value] of Object.entries(flags)) {
        if (value === true) {
          args.push(`--${key}`);
        } else if (value !== false) {
          args.push(`--${key}`, String(value));
        }
      }
      return args;
    },

    prepare: (ctx) => {
      // Skills are file-based — write them so the agent SDK discovers them
      if (ctx.input.resolvedSkills?.length) {
        writeClaudeSkills(ctx.workingDirectory, ctx.input.resolvedSkills);
      }
    },
  });
}
