import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, TokenUsage } from "../types/agent.js";
import type { McpServerConfig } from "../types/config.js";
import { createAgentAdapter, type StreamContext } from "./base/agent-adapter.js";
import { writeAgySkills } from "./utils/skills.js";

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface AgyStepUpdate {
  step_index: number;
  state: string;
  step_type: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: {
    parameters?: Record<string, unknown>;
    output?: string;
    error?: { message?: string };
  };
  usage?: AgyUsage;
}

interface AgyResult {
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
}

interface AgyState {
  startTime: Date;
  conversationId?: string;
  model?: string;
  textByStep: Map<number, string>;
  toolSteps: Map<number, "open" | "closed">;
  usageByStep: Map<number, AgyUsage>;
  lastAgentMessage: string | null;
  result?: AgyResult;
}

/** USD per million tokens. */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

const FLASH_PRICE_RISE = new Date("2027-01-01T00:00:00Z");
const flashRates = (_promptTokens: number, at: Date): Rates =>
  at < FLASH_PRICE_RISE
    ? { input: 0.75, output: 3.75, cacheRead: 0.075 }
    : { input: 1.5, output: 7.5, cacheRead: 0.15 };

// https://ai.google.dev/gemini-api/docs/pricing as of 2026-10-16; unlisted models (3.7 Flash) report no cost, not a guess.
const PRICES: Record<string, (promptTokens: number, at: Date) => Rates> = {
  "gemini-3.8-flash": flashRates,
  "gemini-3.6-flash": flashRates,
  "gemini-3.1-pro": (promptTokens) =>
    promptTokens > 200_000 ? { input: 4, output: 18, cacheRead: 0.4 } : { input: 2, output: 12, cacheRead: 0.2 },
};

const TOOL_KINDS: Record<string, string> = {
  view_file: "read",
  list_dir: "read",
  find_by_name: "search",
  grep_search: "search",
  write_to_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  sed_file: "edit",
  notebook_edit: "edit",
  run_command: "execute",
  command_status: "execute",
  send_command_input: "execute",
  notebook_execution: "execute",
  read_url_content: "fetch",
  search_web: "fetch",
  manage_task: "think",
  define_subagent: "think",
  invoke_subagent: "think",
  manage_subagents: "think",
  ask_question: "think",
  ask_permission: "think",
  ask_custom_permission: "think",
  list_permissions: "think",
  finish: "think",
  wait: "think",
  wait_5_seconds: "think",
  schedule: "think",
  send_message: "think",
  manage_inbox: "think",
  delete_knowledge: "think",
  run_workflow: "think",
};

export function baseModel(model: string): string {
  return model.replace(/-(low|medium|high)$/, "");
}

export function agyCostUsd(model: string, usages: AgyUsage[], at: Date): number | undefined {
  const rates = PRICES[baseModel(model)];
  if (!rates) return undefined;
  let usd = 0;
  for (const u of usages) {
    const input = u.input_tokens ?? 0;
    const cached = u.cache_read_tokens ?? 0;
    const r = rates(input + cached, at);
    usd += (input * r.input + cached * r.cacheRead + (u.output_tokens ?? 0) * r.output) / 1_000_000;
  }
  return usd;
}

function writeAgyMcpConfig(configDir: string, servers: Record<string, McpServerConfig>): void {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "stdio") {
      mcpServers[name] = { command: server.command, args: server.args ?? [], env: server.env ?? {} };
    } else {
      mcpServers[name] = { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    }
  }
  fs.writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify({ mcpServers }, null, 2) + "\n");
}

// agy exits 0 on most failures: the outcome is the `result` event's status, never the exit code.
export function createAgyAdapter(): AgentAdapter {
  return createAgentAdapter<AgyState>({
    name: "agy",
    cliCommand: "agy",
    promptVia: "stdin",

    requiredEnv: () => ["GEMINI_API_KEY"],

    isolationEnv: () => ({
      // Must be exactly "true", or agy can self-update under running jobs.
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    }),

    prepare: (ctx) => {
      const geminiDir = path.join(ctx.homeDirectory, ".gemini");
      const agyHome = path.join(geminiDir, "antigravity-cli");
      const configDir = path.join(geminiDir, "config");
      fs.mkdirSync(agyHome, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      // Without this, agy ignores GEMINI_API_KEY and tries an interactive Google sign-in.
      fs.writeFileSync(path.join(agyHome, "settings.json"), JSON.stringify({ modelProvider: "gemini" }) + "\n");

      if (ctx.input.mcpServers && Object.keys(ctx.input.mcpServers).length > 0) {
        writeAgyMcpConfig(configDir, ctx.input.mcpServers);
      }
      if (ctx.input.resolvedSkills?.length) {
        writeAgySkills(configDir, ctx.input.resolvedSkills);
      }
    },

    buildArgs: (input) => {
      // agy's 5m default would cut runs short of AXIS's own timeout.
      const args = ["--output-format", "stream-json", "--print-timeout", "24h"];
      const flags = input.config.flags ?? {};
      if (flags["dangerously-skip-permissions"] ?? true) args.push("--dangerously-skip-permissions");
      if (input.config.model) args.push("--model", input.config.model);

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

    initialState: () => ({
      startTime: new Date(),
      textByStep: new Map(),
      toolSteps: new Map(),
      usageByStep: new Map(),
      lastAgentMessage: null,
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
        processEvent(event, ctx);
      },
    },

    getResult: ({ state, stderr }) => {
      const usages = [...state.usageByStep.values()];
      const tokenUsage = usages.length > 0 ? sumUsage(usages) : undefined;
      const totalCostUsd =
        state.model && usages.length > 0 ? agyCostUsd(state.model, usages, state.startTime) : undefined;
      const metadata = {
        tokenUsage,
        totalCostUsd,
        sessionId: state.conversationId,
        ...(state.result?.duration_seconds ? { durationMs: Math.round(state.result.duration_seconds * 1000) } : {}),
      };

      const { result } = state;
      if (result?.status === "SUCCESS") {
        return { result: result.response?.trim() || state.lastAgentMessage, metadata };
      }
      const error = result
        ? result.error || `agy finished with status ${result.status ?? "unknown"}`
        : (agyErrorFromStderr(stderr) ?? (stderr.trim() || "agy exited without a result"));
      return { result: null, metadata: { ...metadata, error } };
    },
  });
}

function sumUsage(usages: AgyUsage[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cacheReadInput = 0;
  for (const u of usages) {
    input += u.input_tokens ?? 0;
    output += u.output_tokens ?? 0;
    cacheReadInput += u.cache_read_tokens ?? 0;
  }
  return { input, output, cacheReadInput };
}

function agyErrorFromStderr(stderr: string): string | undefined {
  const line = stderr.split("\n").find((l) => l.startsWith("AGY_ERROR:"));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(line.indexOf("{"))) as { short_error?: string };
    return parsed.short_error ?? line;
  } catch {
    return line;
  }
}

function processEvent(event: Record<string, unknown>, ctx: StreamContext<AgyState>): void {
  switch (event.event) {
    case "init": {
      ctx.state.conversationId = event.conversation_id as string | undefined;
      ctx.state.model = (event.init as { model?: string } | undefined)?.model;
      return;
    }
    case "step_update": {
      if (event.step_update) processStep(event.step_update as AgyStepUpdate, ctx);
      return;
    }
    case "result": {
      const result = event.result as AgyResult | undefined;
      if (!result) return;
      ctx.state.result = result;
      if (result.status !== "SUCCESS") {
        ctx.transcript.push({ type: "error", timestamp: new Date().toISOString(), content: { ...result } });
      }
      return;
    }
  }
}

function processStep(update: AgyStepUpdate, ctx: StreamContext<AgyState>): void {
  const { state } = ctx;
  const timestamp = new Date().toISOString();
  // Per call: result.usage is cumulative, and input_tokens already excludes cache reads.
  if (update.usage) state.usageByStep.set(update.step_index, update.usage);

  if (update.step_type === "agent_response") {
    if (update.text_delta) ctx.feedAssistantText(update.text_delta);
    const text = (state.textByStep.get(update.step_index) ?? "") + (update.text_delta ?? "");
    if (update.state !== "DONE") {
      state.textByStep.set(update.step_index, text);
      return;
    }
    state.textByStep.delete(update.step_index);
    if (text.trim()) {
      state.lastAgentMessage = text.trim();
      ctx.transcript.push({ type: "assistant", timestamp, content: { text, step_index: update.step_index } });
    }
    return;
  }

  if (update.step_type !== "tool") return;

  const phase = state.toolSteps.get(update.step_index);
  if (phase === "closed") return;
  const content = toolContent(update);
  if (!phase) {
    state.toolSteps.set(update.step_index, "open");
    ctx.transcript.push({ type: "tool_use", timestamp, content });
  }
  if (update.state !== "DONE" && update.state !== "ERROR") return;

  state.toolSteps.set(update.step_index, "closed");
  const output = update.tool_info?.output;
  if (output) ctx.feedAssistantText(output);
  // Scoring counts errors by entry type, so a failed tool is an `error`, not a `tool_result`.
  if (update.state === "ERROR") {
    const message = update.tool_info?.error?.message;
    ctx.transcript.push({
      type: "error",
      timestamp,
      content: {
        ...content,
        error: `Tool failed: ${String(content.tool_name)}${message ? `: ${message}` : ""}`,
        output,
      },
    });
    return;
  }
  ctx.transcript.push({ type: "tool_result", timestamp, content: { ...content, output } });
}

function toolContent(update: AgyStepUpdate): Record<string, unknown> {
  const toolName = update.tool_name ?? "tool";
  const parameters = update.tool_info?.parameters ?? {};
  if (toolName === "call_mcp_tool") {
    const { ServerName, ToolName, Arguments } = parameters;
    return {
      tool_name: `mcp__${String(ServerName)}__${String(ToolName)}`,
      parameters: parseArguments(Arguments),
      tool_id: String(update.step_index),
    };
  }
  const kind = TOOL_KINDS[toolName];
  return { tool_name: toolName, parameters, ...(kind ? { kind } : {}), tool_id: String(update.step_index) };
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { arguments: args };
    }
  }
  return (args as Record<string, unknown> | undefined) ?? {};
}
