import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, TokenUsage, TranscriptEntry } from "../types/agent.js";
import { createAgentAdapter, type StreamContext } from "./base/agent-adapter.js";
import { writeCodexMcpConfig } from "./utils/mcp.js";
import { writeCodexSkills } from "./utils/skills.js";

interface CodexState {
  lastAgentMessage: string | null;
  tokenUsage?: TokenUsage;
}

export function createCodexAdapter(): AgentAdapter {
  return createAgentAdapter<CodexState>({
    name: "codex",
    cliCommand: "codex",

    requiredEnv: () => ["CODEX_API_KEY"],

    isolationEnv: ({ home }) => ({
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_DISABLE_TELEMETRY: "1",
    }),

    prepare: (ctx) => {
      // Codex requires CODEX_HOME to exist before launch
      const codexHome = ctx.env?.CODEX_HOME;
      if (codexHome) {
        fs.mkdirSync(codexHome, { recursive: true });
        if (ctx.input.mcpServers && Object.keys(ctx.input.mcpServers).length > 0) {
          writeCodexMcpConfig(codexHome, ctx.input.mcpServers);
        }
      }
      // Codex only discovers skills under `.agents/skills/` in the working
      // directory, so this is the one piece of adapter config we can't relocate
      // to HOME. Scenarios that opt into skills accept this visibility.
      if (ctx.input.resolvedSkills?.length) {
        writeCodexSkills(ctx.workingDirectory, ctx.input.resolvedSkills);
      }
    },

    buildArgs: (input) => {
      const flags = input.config.flags ?? {};

      // Default --full-auto for headless execution
      const fullAuto = flags["full-auto"] ?? true;
      // AXIS workspaces are fresh temp directories, not git repos
      const skipGitCheck = flags["skip-git-repo-check"] ?? true;

      const args = ["exec", "--json"];

      if (fullAuto) args.push("--full-auto");
      if (skipGitCheck) args.push("--skip-git-repo-check");
      if (input.config.model) args.push("--model", input.config.model);

      for (const [key, value] of Object.entries(flags)) {
        if (key === "full-auto" || key === "skip-git-repo-check") continue;
        if (value === true) {
          args.push(`--${key}`);
        } else if (value !== false) {
          args.push(`--${key}`, String(value));
        }
      }

      // Prompt is the final positional argument
      args.push(input.prompt);
      return args;
    },

    initialState: () => ({ lastAgentMessage: null }),

    streamConfig: {
      mode: "lines",
      onLine: (line, ctx) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        processEvent(event, ctx);
      },
    },

    getResult: (ctx) => ({
      result: ctx.state.lastAgentMessage,
      metadata: { tokenUsage: ctx.state.tokenUsage },
    }),
  });
}

/**
 * Feed any textual content from an item to the token estimator so the live
 * counter keeps moving during tool execution (not just assistant messages).
 */
function feedItemText(item: Record<string, unknown>, ctx: StreamContext<CodexState>): void {
  const text = item.text as string | undefined;
  if (text) {
    ctx.feedAssistantText(text);
    return;
  }
  const command = item.command as string | undefined;
  if (command) {
    ctx.feedAssistantText(command);
  }
  const output = item.output as string | undefined;
  if (output) {
    ctx.feedAssistantText(output);
  }
}

/**
 * Process a single NDJSON event from the Codex CLI.
 *
 * Event types:
 * - thread.started — session init
 * - turn.started / turn.completed / turn.failed — turn lifecycle
 * - item.started / item.completed — individual items (agent_message, command_execution, etc.)
 * - error — error events
 */
function processEvent(event: Record<string, unknown>, ctx: StreamContext<CodexState>): void {
  const eventType = event.type as string;

  if (eventType === "turn.completed") {
    const usage = event.usage as Record<string, number> | undefined;
    if (usage) {
      ctx.state.tokenUsage = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheReadInput: usage.cached_input_tokens,
      };
    }
    return;
  }

  // Skip lifecycle events that don't carry content (except turn.failed → error)
  if (eventType === "thread.started" || eventType === "turn.started" || eventType === "turn.failed") {
    if (eventType === "turn.failed") {
      ctx.transcript.push({
        type: "error",
        timestamp: new Date().toISOString(),
        content: event,
      });
    }
    return;
  }

  if (eventType === "error") {
    ctx.transcript.push({
      type: "error",
      timestamp: new Date().toISOString(),
      content: event,
    });
    return;
  }

  // Item events
  if (eventType === "item.completed" || eventType === "item.started") {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return;

    const itemType = item.type as string;

    if (eventType === "item.completed" && itemType === "agent_message") {
      const text = item.text as string;
      if (text) {
        ctx.state.lastAgentMessage = text;
        ctx.feedAssistantText(text);
        ctx.transcript.push({
          type: "assistant",
          timestamp: new Date().toISOString(),
          content: item,
        });
      }
      return;
    }

    if (itemType === "command_execution") {
      feedItemText(item, ctx);
      ctx.transcript.push({
        type: eventType === "item.started" ? "tool_use" : "tool_result",
        timestamp: new Date().toISOString(),
        content: item,
      });
      return;
    }

    if (itemType === "reasoning") {
      feedItemText(item, ctx);
      ctx.transcript.push({
        type: "assistant",
        timestamp: new Date().toISOString(),
        content: item,
      });
      return;
    }

    // file_changes, mcp_tool_calls, web_search, plan_updates — all tool-like
    feedItemText(item, ctx);
    const entry: TranscriptEntry = {
      type: eventType === "item.completed" ? "tool_result" : "tool_use",
      timestamp: new Date().toISOString(),
      content: item,
    };
    ctx.transcript.push(entry);
  }
}
