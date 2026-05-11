import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Qwen Code (QwenLM/qwen-code) via ACP — `qwen --experimental-acp`. Qwen Code
 * is BYOK and reads OPENAI_API_KEY, DASHSCOPE_API_KEY, ANTHROPIC_API_KEY, or
 * GEMINI_API_KEY depending on the configured provider, plus optional
 * OPENAI_BASE_URL / OPENAI_MODEL overrides for OpenAI-compatible endpoints.
 *
 * No env var is enforced — Qwen Code picks whichever provider matches the
 * configured model.
 *
 * Note: the flag is `--experimental-acp` today. Qwen issue #1350 proposes
 * graduating it to `--acp`; revisit when that lands.
 */
export function createQwenCodeAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "qwen-code",
    cliCommand: "qwen",

    isolationEnv: (workspace) => ({
      QWEN_CODE_HOME: path.join(workspace, ".qwen"),
      QWEN_TELEMETRY_ENABLED: "false",
    }),

    buildArgs: (input) => {
      const args = ["--experimental-acp"];
      if (input.config.model) args.push("--model", input.config.model);
      const flags = input.config.flags ?? {};
      for (const [key, value] of Object.entries(flags)) {
        if (value === true) args.push(`--${key}`);
        else if (value !== false) args.push(`--${key}`, String(value));
      }
      return args;
    },

    prepare: (ctx) => {
      const qwenHome = ctx.env?.QWEN_CODE_HOME;
      if (!qwenHome) return;
      fs.mkdirSync(qwenHome, { recursive: true });
      // Disable context discovery — AXIS workspaces are ephemeral temp dirs
      const settings = {
        context: {
          discoveryMaxDirs: 0,
          memoryBoundaryMarkers: [],
        },
      };
      fs.writeFileSync(path.join(qwenHome, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
    },
  });
}
