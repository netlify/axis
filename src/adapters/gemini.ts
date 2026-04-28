import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, TokenUsage } from "../types/agent.js";
import { createAgentAdapter, type StreamContext } from "./base/agent-adapter.js";
import { writeGeminiSettings } from "./utils/mcp.js";
import { writeGeminiSkills } from "./utils/skills.js";

interface GeminiState {
  lastAssistantMessage: string | null;
  tokenUsage?: TokenUsage;
  sessionId?: string;
  resultError: string | null;
  pendingDelta: string;
  pendingDeltaTimestamp: string | null;
}

export function createGeminiAdapter(): AgentAdapter {
  return createAgentAdapter<GeminiState>({
    name: "gemini",
    cliCommand: "gemini",

    requiredEnv: () => ["GEMINI_API_KEY"],

    isolationEnv: (workspace) => ({
      GEMINI_CLI_HOME: path.join(workspace, ".gemini"),
      GEMINI_TELEMETRY_ENABLED: "false",
    }),

    prepare: (ctx) => {
      const geminiHome = ctx.env?.GEMINI_CLI_HOME;
      if (!geminiHome) return;
      fs.mkdirSync(geminiHome, { recursive: true });

      // Always write settings.json — disables context discovery so Gemini
      // doesn't scan the ephemeral workspace on startup. MCP servers are
      // merged in when configured.
      const mcpServers =
        ctx.input.mcpServers && Object.keys(ctx.input.mcpServers).length > 0 ? ctx.input.mcpServers : undefined;
      writeGeminiSettings(geminiHome, mcpServers);

      if (ctx.input.resolvedSkills?.length) {
        writeGeminiSkills(geminiHome, ctx.input.resolvedSkills);
      }
    },

    buildArgs: (input) => {
      const flags = input.config.flags ?? {};
      const yolo = flags["yolo"] ?? true;

      const args = ["-p", input.prompt, "--output-format", "stream-json"];

      if (yolo) args.push("--yolo");
      if (input.config.model) args.push("--model", input.config.model);

      for (const [key, value] of Object.entries(flags)) {
        if (key === "yolo") continue;
        if (value === true) {
          args.push(`--${key}`);
        } else if (value !== false) {
          args.push(`--${key}`, String(value));
        }
      }
      return args;
    },

    initialState: () => ({
      lastAssistantMessage: null,
      resultError: null,
      pendingDelta: "",
      pendingDeltaTimestamp: null,
    }),

    streamConfig: {
      mode: "lines",
      onLine: (line, ctx) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        // Accumulate assistant deltas instead of creating individual entries.
        // Gemini streams assistant messages as chunks with { delta: true }.
        if (event.type === "message" && event.role === "assistant" && event.delta === true) {
          if (!ctx.state.pendingDeltaTimestamp) {
            ctx.state.pendingDeltaTimestamp = (event.timestamp as string) ?? new Date().toISOString();
          }
          const chunk = (event.content as string) ?? "";
          ctx.state.pendingDelta += chunk;
          ctx.feedAssistantText(chunk);
          return;
        }

        // Non-delta event — flush any accumulated assistant text first
        flushPendingDelta(ctx);
        processEvent(event, ctx);
      },
      onEnd: (ctx) => {
        // Flush any remaining delta content at end of stream (including timeout)
        flushPendingDelta(ctx);
      },
    },

    getResult: (ctx) => {
      const { lastAssistantMessage, tokenUsage, sessionId, resultError } = ctx.state;
      return {
        result: resultError ? null : lastAssistantMessage,
        metadata: {
          tokenUsage,
          sessionId,
          ...(resultError ? { error: resultError } : {}),
        },
      };
    },
  });
}

function flushPendingDelta(ctx: StreamContext<GeminiState>): void {
  const { pendingDelta, pendingDeltaTimestamp } = ctx.state;
  if (!pendingDelta) return;
  ctx.state.lastAssistantMessage = pendingDelta;
  ctx.transcript.push({
    type: "assistant",
    timestamp: pendingDeltaTimestamp ?? new Date().toISOString(),
    content: {
      type: "message",
      role: "assistant",
      content: pendingDelta,
    },
  });
  ctx.state.pendingDelta = "";
  ctx.state.pendingDeltaTimestamp = null;
}

/**
 * Feed any textual content from an event to the token estimator so the live
 * counter keeps moving during tool execution (not just assistant messages).
 */
function feedEventText(event: Record<string, unknown>, ctx: StreamContext<GeminiState>): void {
  const content = event.content as string | undefined;
  if (content) {
    ctx.feedAssistantText(content);
    return;
  }
  const output = event.output as string | undefined;
  if (output) {
    ctx.feedAssistantText(output);
    return;
  }
  const params = event.parameters as Record<string, unknown> | undefined;
  if (params) {
    ctx.feedAssistantText(JSON.stringify(params));
  }
}

/**
 * Process a single NDJSON event from the Gemini CLI stream-json output.
 *
 * Event types:
 * - init — session metadata (session_id, model)
 * - message — user/assistant messages (role, content, delta?)
 * - tool_use — tool invocation (tool_name, tool_id, parameters)
 * - tool_result — tool output (tool_id, status, output?, error?)
 * - error — non-fatal errors (severity, message)
 * - result — final outcome with stats
 */
function processEvent(event: Record<string, unknown>, ctx: StreamContext<GeminiState>): void {
  const eventType = event.type as string;

  if (eventType === "init") {
    const id = event.session_id as string | undefined;
    if (id) ctx.state.sessionId = id;
    return;
  }

  if (eventType === "result") {
    const stats = event.stats as Record<string, number> | undefined;
    if (stats) {
      ctx.state.tokenUsage = {
        input: stats.input_tokens ?? 0,
        output: stats.output_tokens ?? 0,
      };
    }
    if (event.status === "error") {
      const errObj = event.error as Record<string, unknown> | undefined;
      const errMsg = (errObj?.message as string) ?? "Unknown error";
      ctx.state.resultError = errMsg;
      ctx.transcript.push({
        type: "error",
        timestamp: (event.timestamp as string) ?? new Date().toISOString(),
        content: event,
      });
    }
    return;
  }

  if (eventType === "error") {
    ctx.transcript.push({
      type: "error",
      timestamp: (event.timestamp as string) ?? new Date().toISOString(),
      content: event,
    });
    return;
  }

  if (eventType === "message") {
    const role = event.role as string;
    const content = event.content as string;

    if (role === "assistant" && content) {
      ctx.state.lastAssistantMessage = content;
      ctx.feedAssistantText(content);
      ctx.transcript.push({
        type: "assistant",
        timestamp: (event.timestamp as string) ?? new Date().toISOString(),
        content: event,
      });
    } else if (role === "user") {
      feedEventText(event, ctx);
      ctx.transcript.push({
        type: "tool_result",
        timestamp: (event.timestamp as string) ?? new Date().toISOString(),
        content: event,
      });
    }
    return;
  }

  if (eventType === "tool_use") {
    feedEventText(event, ctx);
    ctx.transcript.push({
      type: "tool_use",
      timestamp: (event.timestamp as string) ?? new Date().toISOString(),
      content: event,
    });
    return;
  }

  if (eventType === "tool_result") {
    feedEventText(event, ctx);
    ctx.transcript.push({
      type: "tool_result",
      timestamp: (event.timestamp as string) ?? new Date().toISOString(),
      content: event,
    });
  }
}
