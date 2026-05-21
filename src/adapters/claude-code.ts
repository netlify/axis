import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, TranscriptEntry } from "../types/agent.js";
import { createAgentAdapter } from "./base/agent-adapter.js";
import {
  copyHomeFile,
  extractKeychainSecretToFile,
  hasHomeFile,
  homeJsonHasValue,
} from "./utils/local-session.js";
import { writeClaudeMcpConfig } from "./utils/mcp.js";
import { writeClaudeSkills } from "./utils/skills.js";

interface ClaudeState {
  resultMessage: Record<string, unknown> | null;
}

export function createClaudeCodeAdapter(): AgentAdapter {
  return createAgentAdapter<ClaudeState>({
    name: "claude-code",
    cliCommand: "claude",

    requiredEnv: () => ["ANTHROPIC_API_KEY"],

    // `claude login` stores OAuth credentials in:
    //   - macOS: Keychain (service `"Claude Code-credentials"`) — keyed by OS user, accessible regardless of CLAUDE_CONFIG_DIR
    //   - Linux/Windows: `~/.claude/.credentials.json`
    // AND writes an `oauthAccount` block to `~/.claude.json` (at $HOME root,
    // sibling to `.claude/`). The agent reads `oauthAccount` to know which
    // Keychain entry / API server to use — without it, even a valid Keychain
    // token won't authenticate. Detection requires both: the JSON anchor and
    // the actual creds (Keychain on Darwin, file elsewhere).
    hasLocalSession: () =>
      homeJsonHasValue(".claude.json", ["oauthAccount.emailAddress", "oauthAccount.accountUuid"]) ||
      hasHomeFile(path.join(".claude", ".credentials.json")),

    isolationEnv: ({ home }) => ({
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    }),

    prepare: async (ctx) => {
      const configDir = ctx.env?.CLAUDE_CONFIG_DIR;
      // When no API key is set, propagate the user's local OAuth session into
      // the isolated CLAUDE_CONFIG_DIR. Setting CLAUDE_CONFIG_DIR to a non-
      // default path tells claude to treat that dir as a self-contained home
      // — it bypasses both `$HOME/.claude.json` AND the macOS Keychain. So we
      // must materialize both pieces inside CLAUDE_CONFIG_DIR:
      //   - `.claude.json` — `oauthAccount` block (the account anchor)
      //   - `.credentials.json` — the actual OAuth token blob (Linux/Windows
      //     have it as a file already; macOS keeps it in Keychain — we
      //     extract via `security find-generic-password -w`)
      if (configDir && !ctx.env?.ANTHROPIC_API_KEY) {
        fs.mkdirSync(configDir, { recursive: true });
        copyHomeFile(".claude.json", configDir);
        const credsDest = path.join(configDir, ".credentials.json");
        copyHomeFile(path.join(".claude", ".credentials.json"), configDir);
        if (!fs.existsSync(credsDest)) {
          await extractKeychainSecretToFile("Claude Code-credentials", credsDest);
        }
      }
      // MCP config goes into HOME (and is wired via --mcp-config below) so the
      // workspace never contains a `.mcp.json` the agent could scan.
      if (configDir && ctx.input.mcpServers && Object.keys(ctx.input.mcpServers).length > 0) {
        writeClaudeMcpConfig(path.join(configDir, "mcp.json"), ctx.input.mcpServers);
      }
      // Skills go to CLAUDE_CONFIG_DIR/skills/ (user-scoped), which is under HOME.
      if (configDir && ctx.input.resolvedSkills?.length) {
        writeClaudeSkills(configDir, ctx.input.resolvedSkills);
      }
    },

    buildArgs: (input) => {
      const flags = input.config.flags ?? {};
      // Default dangerously-skip-permissions to true — AXIS runs agents headlessly
      const skipPermissions = flags["dangerously-skip-permissions"] ?? true;

      const args = ["-p", input.prompt, "--output-format", "stream-json", "--verbose"];

      if (skipPermissions) args.push("--dangerously-skip-permissions");
      if (input.config.model) args.push("--model", input.config.model);

      // Point Claude Code at the MCP config we wrote into HOME (if any). The
      // file is only created when the scenario configured MCP servers.
      if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
        args.push("--mcp-config", path.join(input.homeDirectory, ".claude", "mcp.json"));
      }

      for (const [key, value] of Object.entries(flags)) {
        if (key === "dangerously-skip-permissions") continue;
        if (value === true) {
          args.push(`--${key}`);
        } else if (value !== false) {
          args.push(`--${key}`, String(value));
        }
      }
      return args;
    },

    initialState: () => ({ resultMessage: null }),

    streamConfig: {
      mode: "lines",
      onLine: (line, ctx) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "result") {
          ctx.state.resultMessage = msg;
          return;
        }

        feedStreamText(msg, ctx.feedAssistantText);
        const entry = mapToTranscriptEntry(msg);
        if (entry) ctx.transcript.push(entry);
      },
    },

    getResult: (ctx) => {
      const r = ctx.state.resultMessage;
      const usage = r?.usage as Record<string, number> | undefined;

      return {
        result: (r?.result as string) ?? null,
        metadata: {
          // Claude emits its own duration_ms in the result message; prefer it over wall clock
          durationMs: (r?.duration_ms as number) ?? ctx.endTime.getTime() - ctx.startTime.getTime(),
          totalCostUsd: r?.total_cost_usd as number | undefined,
          sessionId: r?.session_id as string | undefined,
          tokenUsage: usage
            ? {
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
                cacheReadInput: usage.cache_read_input_tokens,
              }
            : undefined,
        },
      };
    },
  });
}

/**
 * Feed textual content from stream events to the token estimator so the live
 * counter keeps moving during tool execution, not just assistant messages.
 *
 * Claude Code events:
 * - `assistant` → `message.content[].text` blocks (assistant reasoning/responses)
 * - `user` → `message.content[].text` blocks (tool results fed back to the model)
 */
function feedStreamText(msg: Record<string, unknown>, addText: (t: string) => void): void {
  if (msg.type !== "assistant" && msg.type !== "user") return;
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        addText(b.text);
      }
    }
  }
}

function mapToTranscriptEntry(msg: Record<string, unknown>): TranscriptEntry | null {
  const type = msg.type as string;

  // Skip streaming/progress events — not meaningful for transcript
  if (type === "stream_event" || type === "tool_progress") {
    return null;
  }

  return {
    type: mapMessageType(type),
    timestamp: new Date().toISOString(),
    content: msg,
  };
}

function mapMessageType(claudeType: string): TranscriptEntry["type"] {
  switch (claudeType) {
    case "assistant":
      return "assistant";
    case "user":
      return "tool_result";
    case "system":
      return "system";
    default:
      return "system";
  }
}
