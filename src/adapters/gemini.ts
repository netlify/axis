import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";
import { writeGeminiSkills } from "./utils/skills.js";

/**
 * Gemini adapter. Uses `gemini --acp` to launch Gemini CLI in Agent Client
 * Protocol mode over stdio, giving us structured tool calls, plans, and
 * permissions instead of ad-hoc NDJSON.
 *
 * MCP servers are passed through the ACP `session/new` call rather than
 * written to settings.json.
 */
export function createGeminiAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "gemini",
    cliCommand: "gemini",

    requiredEnv: () => ["GEMINI_API_KEY"],

    isolationEnv: (workspace) => ({
      GEMINI_CLI_HOME: path.join(workspace, ".gemini"),
      GEMINI_TELEMETRY_ENABLED: "false",
      // Unset GOOGLE_CLOUD_PROJECT to prevent interactive auth prompts in ACP mode
      GOOGLE_CLOUD_PROJECT: "",
    }),

    buildArgs: (input) => {
      const args = ["--acp"];
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
      const geminiHome = ctx.env?.GEMINI_CLI_HOME;
      if (!geminiHome) return;
      fs.mkdirSync(geminiHome, { recursive: true });

      // Write settings.json to disable context discovery — AXIS workspaces are
      // ephemeral temp dirs with no meaningful project structure. MCP servers
      // are NOT written here; they go through ACP's session/new instead.
      const settings = {
        context: {
          discoveryMaxDirs: 0,
          memoryBoundaryMarkers: [],
        },
      };
      fs.writeFileSync(path.join(geminiHome, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

      if (ctx.input.resolvedSkills?.length) {
        writeGeminiSkills(geminiHome, ctx.input.resolvedSkills);
      }
    },
  });
}
