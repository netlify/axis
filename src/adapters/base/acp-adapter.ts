import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type PromptResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
  type ToolCallContent,
  type McpServer,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import type {
  AgentAdapter,
  AgentInput,
  AgentMetadata,
  AgentOutput,
  IsolationPaths,
  TokenUsage,
  TranscriptEntry,
} from "../../types/agent.js";
import type { McpServerConfig } from "../../types/config.js";
import { resolveCommand, type ResolvedCommand } from "../utils/resolve.js";
import { createTokenEstimator } from "../utils/token-estimator.js";
import type { SetupContext } from "./agent-adapter.js";

// Re-export SetupContext so ACP adapter specs can reference it
export type { SetupContext } from "./agent-adapter.js";

/** Default timeout for agent execution (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum bytes of stderr to buffer before truncating. */
const MAX_STDERR_BYTES = 100_000;

/** Grace period between SIGTERM and SIGKILL for non-responsive processes. */
const SIGTERM_TO_SIGKILL_MS = 5_000;

// ---------------------------------------------------------------------------
// Spec — the declarative description for an ACP-based adapter
// ---------------------------------------------------------------------------

/**
 * A declarative spec for an ACP-based agent adapter. Pass to
 * `createAcpBasedAdapter` to get back an `AgentAdapter` that speaks the
 * Agent Client Protocol over stdio.
 *
 * Much simpler than `AgentAdapterSpec` because ACP handles the protocol —
 * no `streamConfig`, `getResult`, or `initialState`.
 */
export interface AcpAdapterSpec {
  /** Adapter name. Used in logs, error messages, and `AgentAdapter.name`. */
  name: string;

  /**
   * CLI binary resolved via `resolveCommand` + npx fallback. Omit if the
   * adapter gets its command from `input.config.command` at runtime.
   */
  cliCommand?: string;

  /** Build CLI arguments for launching the agent in ACP mode. */
  buildArgs?: (input: AgentInput) => string[];

  /** Execution timeout. Defaults to 10 minutes. */
  timeoutMs?: number;

  /** Env vars the adapter requires (validated by runner pre-flight). */
  requiredEnv?: () => string[];

  /** Workspace isolation env vars (merged into child env by runner). */
  isolationEnv?: (paths: IsolationPaths) => Record<string, string>;

  /**
   * Pre-spawn side effects: mkdir, config writers, etc.
   * Runs after env is finalized and before the process is spawned.
   */
  prepare?: (ctx: SetupContext) => void | Promise<void>;

  /**
   * Extract token usage from a vendor-specific `PromptResponse._meta` payload.
   * The standard `PromptResponse.usage` field is already consumed; this hook
   * runs only when `usage` is absent. Return `undefined` if no usage can be
   * derived.
   */
  extractUsage?: (promptResult: PromptResponse) => TokenUsage | undefined;
}

// ---------------------------------------------------------------------------
// Internal state accumulated during an ACP session
// ---------------------------------------------------------------------------

interface AcpState {
  lastAssistantMessage: string | null;
  pendingChunks: string;
  pendingTimestamp: string | null;
  tokenUsage?: TokenUsage;
  sessionId?: string;
  resultError: string | null;
  /** Track active tool calls for pairing tool_use → tool_result */
  activeToolCalls: Map<string, { title: string; kind?: string }>;
  /** Cumulative session cost from usage_update events. */
  totalCostUsd?: number;
  /** Duration of the prompt() call only (excludes ACP handshake and process lifecycle). */
  promptDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an `AgentAdapter` from an ACP-based spec. The returned adapter:
 * - Spawns the agent binary with bidirectional stdio
 * - Runs the ACP lifecycle: initialize → session/new → session/prompt
 * - Maps `session/update` notifications to AXIS `TranscriptEntry[]`
 * - Auto-approves permission requests
 * - Provides filesystem access to the agent workspace
 * - Manages timeout, cleanup, token estimation
 */
export function createAcpBasedAdapter(spec: AcpAdapterSpec): AgentAdapter {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Cached resolved command from ensureInstalled
  let resolved: ResolvedCommand | null = null;

  async function doResolve(): Promise<void> {
    if (!spec.cliCommand) return;
    resolved = await resolveCommand(spec.name, spec.cliCommand);
  }

  return {
    name: spec.name,
    requiredEnv: spec.requiredEnv,
    isolationEnv: spec.isolationEnv,

    async ensureInstalled(_logger) {
      await doResolve();
    },

    async run(input: AgentInput): Promise<AgentOutput> {
      // 1. Resolve command
      if (spec.cliCommand && !resolved) {
        await doResolve();
      }

      const command = resolved?.command ?? input.config.command;
      if (!command) {
        throw new Error(`The "${spec.name}" adapter has no command to spawn.`);
      }
      const prefixArgs = resolved?.prefixArgs ?? [];

      // 2. Pre-spawn side effects
      await spec.prepare?.({
        input,
        workingDirectory: input.workingDirectory,
        homeDirectory: input.homeDirectory,
        env: input.env,
      });

      // 3. Build args
      const args = spec.buildArgs?.(input) ?? [];

      const startTime = new Date();
      const estimator = createTokenEstimator(input.onTokenProgress);
      const rawOutput: string[] | undefined = input.captureRawOutput ? [] : undefined;
      const transcript: TranscriptEntry[] = [];

      const state: AcpState = {
        lastAssistantMessage: null,
        pendingChunks: "",
        pendingTimestamp: null,
        resultError: null,
        activeToolCalls: new Map(),
      };

      // 4. Spawn the ACP agent process — keep stdin OPEN for bidirectional JSON-RPC
      const child: ChildProcess = spawn(command, [...prefixArgs, ...args], {
        cwd: input.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: input.env ?? { ...process.env },
      });

      // 5. Cleanup handler for Ctrl-C
      input.registerCleanup?.(() => {
        child.kill("SIGTERM");
      });

      // 6. Register close listener BEFORE reading (ordering matters)
      const exitPromise = new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
      });

      // 7. Buffer stderr with a size cap (and mirror to debug callback if any)
      let stderr = "";
      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
      });

      // 8. Timeout → SIGTERM → SIGKILL
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const outerTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_TO_SIGKILL_MS);
      }, timeoutMs);
      child.on("close", () => {
        if (killTimer) clearTimeout(killTimer);
      });

      // The ACP SDK calls `console.error` directly whenever a request handler
      // returns an error (e.g. agent asks to read a file that doesn't exist).
      // Outside of debug mode these are noise — the failure is already
      // communicated to the agent via the JSON-RPC error response.
      const restoreConsoleError = input.debug ? null : suppressAcpSdkNoise();

      try {
        // 9. Wire ACP SDK — convert Node streams to Web Streams for ndJsonStream
        const stdinWeb = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
        const stdoutWeb = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
        const stream = ndJsonStream(stdinWeb, stdoutWeb);

        // 10. Create ACP client handler
        const client = buildClient(input, state, transcript, estimator, rawOutput);
        const connection = new ClientSideConnection((_agent) => client, stream);

        // 11. Initialize — negotiate protocol version and capabilities
        const initResult = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
          clientInfo: {
            name: "axis",
            version: "0.1.0",
          },
        });
        {
          const line = JSON.stringify({ type: "initialize_result", ...initResult });
          rawOutput?.push(line);
          input.onRawLine?.(line);
        }

        // 12. Create session
        const mcpServers = convertMcpServers(input.mcpServers);
        const sessionResult = await connection.newSession({
          cwd: input.workingDirectory,
          mcpServers,
        });
        state.sessionId = sessionResult.sessionId;
        {
          const line = JSON.stringify({ type: "session_result", ...sessionResult });
          rawOutput?.push(line);
          input.onRawLine?.(line);
        }

        // 13. Add the initial prompt to the transcript and raw output
        transcript.push({
          type: "user",
          timestamp: new Date().toISOString(),
          content: { content: input.prompt },
        });
        {
          const line = JSON.stringify({
            type: "prompt",
            sessionId: sessionResult.sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          });
          rawOutput?.push(line);
          input.onRawLine?.(line);
        }

        // 14. Send prompt and wait for completion — time just the agent work
        const promptStart = Date.now();
        const promptResult = await connection.prompt({
          sessionId: sessionResult.sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        });
        state.promptDurationMs = Date.now() - promptStart;
        {
          const line = JSON.stringify({ type: "prompt_result", ...promptResult });
          rawOutput?.push(line);
          input.onRawLine?.(line);
        }

        // 15. Extract token usage from PromptResponse if available
        if (promptResult.usage) {
          state.tokenUsage = {
            input: promptResult.usage.inputTokens,
            output: promptResult.usage.outputTokens,
            ...(promptResult.usage.cachedReadTokens != null
              ? { cacheReadInput: promptResult.usage.cachedReadTokens }
              : {}),
          };
        } else if (spec.extractUsage) {
          const usage = spec.extractUsage(promptResult);
          if (usage) state.tokenUsage = usage;
        }

        // 16. Map stop reason to potential error
        if (promptResult.stopReason === "cancelled") {
          state.resultError = "Agent cancelled";
        } else if (promptResult.stopReason === "max_tokens") {
          state.resultError = "Agent hit max tokens limit";
        } else if (promptResult.stopReason === "refusal") {
          state.resultError = "Agent refused to continue";
        } else if (promptResult.stopReason === "max_turn_requests") {
          state.resultError = "Agent exceeded max turn requests";
        }
      } catch (err) {
        if (!timedOut) {
          state.resultError = err instanceof Error ? err.message : String(err);
        }
      } finally {
        clearTimeout(outerTimer);
        // Flush any pending message chunks
        flushPendingChunks(state, transcript);
        // Gracefully signal EOF so the agent can exit on its own. ACP agents
        // (e.g. gemini --acp) keep the JSON-RPC channel alive after prompt_result
        // waiting for more prompts; closing stdin tells them no more are coming.
        try {
          child.stdin?.end();
        } catch {
          // already closed
        }
        // SIGTERM with SIGKILL fallback — some agents catch SIGTERM and never exit.
        // Without the fallback, `await exitPromise` would hang until outerTimer.
        if (!timedOut && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM");
          } catch {
            // already dead
          }
          const cleanupKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, SIGTERM_TO_SIGKILL_MS);
          child.on("close", () => clearTimeout(cleanupKillTimer));
        }
        restoreConsoleError?.();
      }

      // 17. Wait for process exit
      const exitCode = await exitPromise;
      const endTime = new Date();

      // 18. Timeout path
      if (timedOut) {
        return {
          transcript,
          result: null,
          rawOutput,
          metadata: {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            durationMs: endTime.getTime() - startTime.getTime(),
            exitCode,
            error: `Agent timed out after ${timeoutMs / 1000}s`,
          },
        };
      }

      // 19. Build result
      let error = state.resultError ?? undefined;
      if (!error && exitCode !== 0 && !state.lastAssistantMessage) {
        error = stderr || "Agent process exited with non-zero code";
      }

      const metadata: AgentMetadata = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMs: state.promptDurationMs ?? endTime.getTime() - startTime.getTime(),
        exitCode,
        tokenUsage: state.tokenUsage,
        totalCostUsd: state.totalCostUsd,
        sessionId: state.sessionId,
        ...(error ? { error } : {}),
      };

      return {
        transcript,
        result: state.lastAssistantMessage,
        rawOutput,
        metadata,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ACP Client implementation
// ---------------------------------------------------------------------------

function buildClient(
  input: AgentInput,
  state: AcpState,
  transcript: TranscriptEntry[],
  estimator: ReturnType<typeof createTokenEstimator>,
  rawOutput: string[] | undefined,
): Client {
  return {
    // Auto-approve all permission requests for headless AXIS execution
    async requestPermission(params) {
      // Prefer allow_always, fall back to the first option
      const allowAlways = params.options.find((o: PermissionOption) => o.kind === "allow_always");
      const selected = allowAlways ?? params.options[0];
      return {
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      };
    },

    // Handle streaming session updates — the core event mapper
    async sessionUpdate(params: SessionNotification) {
      const update = params.update;
      const line = JSON.stringify(update);
      rawOutput?.push(line);
      input.onRawLine?.(line);

      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          handleAgentMessageChunk(update, state, transcript, estimator);
          break;

        case "agent_thought_chunk":
          // Feed to token estimator only — no transcript entry
          feedContentBlock(update.content, estimator);
          break;

        case "tool_call":
          // Flush pending message chunks before tool call
          flushPendingChunks(state, transcript);
          handleToolCall(update, state, transcript, estimator);
          break;

        case "tool_call_update":
          handleToolCallUpdate(update, state, transcript, estimator);
          break;

        case "plan":
          flushPendingChunks(state, transcript);
          handlePlan(update, transcript);
          break;

        case "usage_update":
          handleUsageUpdate(update, state);
          break;

        default:
          // available_commands_update, current_mode_update, etc.
          break;
      }
    },

    // Filesystem access within the workspace
    async readTextFile(params) {
      const content = fs.readFileSync(params.path, "utf-8");
      return { content };
    },

    async writeTextFile(params) {
      // Ensure parent directory exists
      const dir = params.path.substring(0, params.path.lastIndexOf("/"));
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(params.path, params.content, "utf-8");
      return {};
    },
  };
}

/**
 * Patch `console.error` to drop ACP SDK request/notification error logs.
 * The SDK logs every JSON-RPC error response with `console.error("Error handling request", ...)`
 * — useful in debug, but noisy in normal runs (every missed file read shows up).
 * Returns a restore function to call when the connection scope ends.
 */
function suppressAcpSdkNoise(): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && (first === "Error handling request" || first === "Error handling notification")) {
      return;
    }
    original(...args);
  };
  return () => {
    console.error = original;
  };
}

// ---------------------------------------------------------------------------
// Event handlers — map ACP events to TranscriptEntry[]
// ---------------------------------------------------------------------------

/**
 * Accumulate agent message chunks. Following Gemini's delta pattern,
 * we buffer chunks and flush as a single assistant entry when a
 * non-message event arrives or the stream ends.
 */
function handleAgentMessageChunk(
  update: SessionUpdate & { sessionUpdate: "agent_message_chunk" },
  state: AcpState,
  _transcript: TranscriptEntry[],
  estimator: ReturnType<typeof createTokenEstimator>,
): void {
  const text = extractTextFromContentBlock(update.content);
  if (!text) return;

  if (!state.pendingTimestamp) {
    state.pendingTimestamp = new Date().toISOString();
  }
  state.pendingChunks += text;
  estimator.addText(text);
}

/** Flush accumulated message chunks into a single assistant transcript entry. */
function flushPendingChunks(state: AcpState, transcript: TranscriptEntry[]): void {
  if (!state.pendingChunks) return;

  state.lastAssistantMessage = state.pendingChunks;
  transcript.push({
    type: "assistant",
    timestamp: state.pendingTimestamp ?? new Date().toISOString(),
    content: {
      content: state.pendingChunks,
      text: state.pendingChunks,
    },
  });

  state.pendingChunks = "";
  state.pendingTimestamp = null;
}

/** Handle a new tool call — push tool_use entry. */
function handleToolCall(
  update: ToolCall & { sessionUpdate: "tool_call" },
  state: AcpState,
  transcript: TranscriptEntry[],
  estimator: ReturnType<typeof createTokenEstimator>,
): void {
  state.activeToolCalls.set(update.toolCallId, {
    title: update.title,
    kind: update.kind,
  });

  // Feed text to estimator
  estimator.addText(update.title);
  if (update.rawInput != null) {
    const inputText = typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput);
    estimator.addText(inputText);
  }

  // Build parameters object for extractToolInput compatibility
  const parameters =
    update.rawInput != null
      ? typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
        ? (update.rawInput as Record<string, unknown>)
        : { value: update.rawInput }
      : undefined;

  transcript.push({
    type: "tool_use",
    timestamp: new Date().toISOString(),
    content: {
      // extractToolName → content.tool_name (Gemini path)
      tool_name: update.title,
      // extractToolId → content.tool_id
      tool_id: update.toolCallId,
      // extractToolInput → content.parameters (Gemini path)
      parameters,
      // ACP-specific enrichment
      kind: update.kind,
      status: update.status,
      locations: update.locations,
    },
  });
}

/** Handle a tool call update — push tool_result or error entry on completion/failure. */
function handleToolCallUpdate(
  update: ToolCallUpdate & { sessionUpdate: "tool_call_update" },
  state: AcpState,
  transcript: TranscriptEntry[],
  estimator: ReturnType<typeof createTokenEstimator>,
): void {
  // Feed output to estimator
  if (update.rawOutput != null) {
    const outputText = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
    estimator.addText(outputText);
  }
  feedToolCallContent(update.content, estimator);

  // ACP bridges send rawInput in intermediate updates (not on the initial tool_call
  // which arrives with rawInput: {}). Backfill the matching tool_use entry's parameters.
  backfillToolUseParameters(update, state, transcript, estimator);

  const status = update.status;
  if (status !== "completed" && status !== "failed") return;

  const active = state.activeToolCalls.get(update.toolCallId);
  const title = update.title ?? active?.title ?? update.toolCallId;
  const kind = update.kind ?? active?.kind;
  const resultText = extractToolResultText(update.content, update.rawOutput);

  if (status === "failed") {
    transcript.push({
      type: "error",
      timestamp: new Date().toISOString(),
      content: {
        error: `Tool failed: ${title}`,
        tool_id: update.toolCallId,
        output: resultText,
        kind,
      },
    });
  } else {
    transcript.push({
      type: "tool_result",
      timestamp: new Date().toISOString(),
      content: {
        // extractToolId → content.tool_id
        tool_id: update.toolCallId,
        // extractToolResultText → content.output (Gemini/Codex path)
        output: resultText,
        // extractToolName → content.name (for pairing display)
        name: title,
        kind,
        locations: update.locations,
      },
    });
  }

  state.activeToolCalls.delete(update.toolCallId);
}

/** Handle a plan update — push system entry. */
function handlePlan(update: SessionUpdate & { sessionUpdate: "plan" }, transcript: TranscriptEntry[]): void {
  transcript.push({
    type: "system",
    timestamp: new Date().toISOString(),
    content: {
      type: "plan",
      entries: update.entries,
    },
  });
}

/** Handle a usage update — capture token/cost data. */
function handleUsageUpdate(update: SessionUpdate & { sessionUpdate: "usage_update" }, state: AcpState): void {
  // UsageUpdate has `size` (context window) and `used` (tokens in context)
  // We capture `used` as input tokens since it's the best approximation
  if (!state.tokenUsage) {
    state.tokenUsage = { input: update.used, output: 0 };
  } else {
    state.tokenUsage.input = update.used;
  }

  // Capture cumulative session cost (last value wins — ACP cost is cumulative)
  if (update.cost != null) {
    state.totalCostUsd = update.cost.amount;
  }
}

/**
 * Backfill tool_use parameters from intermediate tool_call_update events.
 * ACP bridges send the initial tool_call with rawInput: {} (pending),
 * then a follow-up tool_call_update with the actual rawInput populated.
 */
function backfillToolUseParameters(
  update: ToolCallUpdate & { sessionUpdate: "tool_call_update" },
  state: AcpState,
  transcript: TranscriptEntry[],
  estimator: ReturnType<typeof createTokenEstimator>,
): void {
  // Only process updates that carry actual rawInput data
  if (update.rawInput == null) return;
  const rawInput = update.rawInput;
  if (typeof rawInput === "object" && !Array.isArray(rawInput) && Object.keys(rawInput as object).length === 0) return;

  const parameters =
    typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : { value: rawInput };

  // Feed the actual input to the token estimator
  estimator.addText(JSON.stringify(parameters));

  // Find the matching tool_use entry and update its parameters
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry.type === "tool_use" && (entry.content as Record<string, unknown>).tool_id === update.toolCallId) {
      (entry.content as Record<string, unknown>).parameters = parameters;
      break;
    }
  }

  // Update activeToolCalls with the more descriptive title if present
  if (update.title) {
    const active = state.activeToolCalls.get(update.toolCallId);
    if (active) {
      active.title = update.title;
    }
  }
  if (update.kind) {
    const active = state.activeToolCalls.get(update.toolCallId);
    if (active) {
      active.kind = update.kind;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from a ContentBlock. */
function extractTextFromContentBlock(block: ContentBlock): string | null {
  if (block.type === "text") {
    return block.text;
  }
  return null;
}

/** Feed a ContentBlock to the token estimator. */
function feedContentBlock(block: ContentBlock, estimator: ReturnType<typeof createTokenEstimator>): void {
  const text = extractTextFromContentBlock(block);
  if (text) {
    estimator.addText(text);
  }
}

/** Feed tool call content to the token estimator. */
function feedToolCallContent(
  content: Array<ToolCallContent> | null | undefined,
  estimator: ReturnType<typeof createTokenEstimator>,
): void {
  if (!content) return;
  for (const block of content) {
    if (block.type === "content") {
      feedContentBlock(block.content, estimator);
    }
  }
}

/** Extract human-readable result text from tool call content and rawOutput. */
function extractToolResultText(content: Array<ToolCallContent> | null | undefined, rawOutput: unknown): string | null {
  if (content) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "content") {
        if (block.content.type === "text") {
          parts.push(block.content.text);
        }
      } else if (block.type === "diff") {
        const diff = block as unknown as Record<string, unknown>;
        parts.push(`[diff: ${diff.path ?? "unknown"}]`);
      } else if (block.type === "terminal") {
        const terminal = block as unknown as Record<string, unknown>;
        parts.push(`[terminal: ${terminal.terminalId ?? "unknown"}]`);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (rawOutput != null) {
    return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
  }
  return null;
}

/**
 * Convert AXIS MCP server configs to ACP McpServer format.
 * AXIS stores them as Record<name, config>; ACP expects an array with name on each.
 */
function convertMcpServers(servers?: Record<string, McpServerConfig>): McpServer[] {
  if (!servers) return [];
  return Object.entries(servers).map(([name, config]) => {
    if (config.type === "http") {
      return {
        type: "http" as const,
        name,
        url: config.url,
        headers: config.headers ? Object.entries(config.headers).map(([k, v]) => ({ name: k, value: v })) : [],
      };
    }
    // stdio
    return {
      name,
      command: config.command,
      args: config.args ?? [],
      env: config.env ? Object.entries(config.env).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  });
}
