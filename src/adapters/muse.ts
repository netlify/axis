import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentAdapter,
  AgentInput,
  AgentMetadata,
  AgentOutput,
  IsolationPaths,
  TokenUsage,
  TranscriptEntry,
} from "../types/agent.js";
import type { McpServerConfig } from "../types/config.js";
import { resolveCommand } from "./utils/resolve.js";
import { createTokenEstimator } from "./utils/token-estimator.js";
import { killProcessTree, MAX_STDERR_BYTES, SIGTERM_TO_SIGKILL_MS } from "./utils/process.js";
import { MspConnection, MspConnectionClosedError, MspError, uuidv7, type MspNotification } from "./utils/msp.js";
import { writeMuseSkills } from "./utils/skills.js";

/**
 * Adapter for Meta's Muse Code CLI (`muse`).
 *
 * Muse has **no native ACP mode** (checked against 1.4.2), so this is not an
 * `createAcpBasedAdapter` adapter. It drives Muse's own protocol instead:
 * `muse serve` hosts a session over stdio speaking MSP (Muse Session
 * Protocol), newline-delimited JSON-RPC 2.0.
 *
 * MSP rather than the simpler `muse exec --json`, because **`exec` reports no
 * token usage and no cost** (verified against a successful billed run: 40
 * records, zero usage fields, and no flag to request them). MSP publishes both
 * on its stable surface: `session/tokenUsage` carries per-call counters plus a
 * session `cumulative` block that includes a server-computed USD `cost`. MSP
 * also describes tool calls as first-class `item`s, so tool names come off the
 * wire instead of being inferred from internal task kinds.
 *
 * Flow: `initialize` → `initialized` → `session/start` → `turn/start`, then
 * consume notifications until `turn/completed`.
 */

/** Approval mode requested on the wire; `muse serve` has no approval flag. */
const APPROVAL_ALLOW_ALL = "allowAll";

/** Grantable capability gating per-session MCP config (`CapabilityName` in the MSP schema). */
const CAPABILITY_SESSION_MCP = "sessionMcp";

/**
 * Item kinds that are Muse running its own sub-agents: reminder children,
 * delegated subagents, workflows, and context compaction.
 */
const INTERNAL_TASK_KINDS = new Set(["reminderChild", "subagent", "workflow", "compaction"]);

/**
 * Tool name reported for those sub-runs. `task` is in `AGENT_TOOL_NAMES`
 * (src/transcript/categorize.ts), so they score against the agent dimension,
 * where an agent's own orchestration belongs, rather than falling through to
 * `service` as an unrecognized tool would. The original `kind` stays on the
 * entry's content for anything reading the detail.
 */
const INTERNAL_TASK_TOOL = "task";

/** Default timeout for agent execution (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface MuseRunState {
  sessionId: string | null;
  modelId: string | null;
  /** Text of the most recent `agentMessage` item, the final answer. */
  lastAssistantMessage: string | null;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  turnError: string | null;
  turnTerminal: string | null;
  /** `turn/completed.durationMs`: the turn's own wall time, excluding host startup. */
  turnDurationMs?: number;
  /** itemId to tool name, learned from `item/started` so the pair agrees. */
  openTools: Map<string, string>;
  /** Accumulates `item/delta` text per item so a streamed message is complete. */
  deltaText: Map<string, string>;
  /** Resolves the turn-completion waiter; set by `runTurn`. */
  onTurnComplete?: () => void;
}

export function createMuseAdapter(): AgentAdapter {
  return {
    name: "muse",

    requiredEnv: () => ["META_API_KEY"],

    hasLocalSession: () => hasPortableMuseSession(),

    isolationEnv: ({ home }: IsolationPaths) => ({
      // Muse is XDG-based: config (auth.json, settings.json, skills/) under
      // XDG_CONFIG_HOME, session logs and plugins under XDG_DATA_HOME. Both
      // are set explicitly rather than leaning on the HOME fallback so a
      // stray host XDG_CONFIG_HOME can never pull the operator's real config
      // into a scenario run.
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      // The `muse` on PATH is a launcher that checks for a newer build
      // roughly hourly and installs it in the background. In a suite that
      // means one job can silently swap the binary out from under the jobs
      // still running (observed live: 1.3.0 to 1.4.2 mid-session), and N
      // parallel jobs can race the same download. Pin it off: every job in a
      // run must grade the same build.
      MUSE_NO_AUTO_UPDATE: "1",
      // Never let the launcher fall into its interactive device-code login.
      MUSE_LOGIN: "0",
    }),

    async ensureInstalled(): Promise<void> {
      // No npm package exists, so there is no npx fallback: `muse` has to be
      // on PATH already (`curl https://dev.meta.ai/install.sh | bash`).
      await resolveCommand("muse", "muse");
    },

    run: (input) => runMuse(input),
  };
}

async function runMuse(input: AgentInput): Promise<AgentOutput> {
  const startTime = new Date();
  const transcript: TranscriptEntry[] = [];
  const rawOutput: string[] = [];
  const state: MuseRunState = {
    sessionId: null,
    modelId: null,
    lastAssistantMessage: null,
    turnError: null,
    turnTerminal: null,
    deltaText: new Map(),
    openTools: new Map(),
  };

  await prepareMuseHome(input);

  const resolved = await resolveCommand("muse", input.config.command ?? "muse");
  const { command, prefixArgs } = resolved;

  let child: ChildProcess;
  try {
    child = spawn(command, [...prefixArgs, ...buildServeArgs(input)], {
      cwd: input.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env ?? { ...process.env },
      // Own process group so teardown reaps anything Muse shelled out to.
      detached: true,
    });
  } catch (error) {
    return failedOutput(startTime, error instanceof Error ? error.message : String(error));
  }

  input.registerCleanup?.(() => killProcessTree(child, "SIGTERM"));

  // Register the close listener before wiring stdout, so a process that dies
  // immediately can't resolve before anyone is listening.
  const exitPromise = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    input.onStderr?.(chunk);
  });

  let spawnError: string | null = null;
  child.on("error", (error) => {
    spawnError ??= error.message;
  });

  const estimator = createTokenEstimator(input.onTokenProgress);
  const connection = new MspConnection(
    child.stdin!,
    child.stdout!,
    (notification) => handleNotification(notification, state, transcript, (t) => estimator.addText(t)),
    (line) => {
      if (input.captureRawOutput) rawOutput.push(line);
      input.onRawLine?.(line);
    },
  );
  child.on("close", () => connection.rejectAll("muse serve exited before the turn completed"));

  // Timeout and external abort both tear the tree down; the turn promise then
  // rejects via `rejectAll` rather than hanging.
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, "SIGTERM");
    killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), SIGTERM_TO_SIGKILL_MS);
  }, timeoutMs);

  let abortReason: string | null = null;
  let abortKillTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    abortReason = String(input.signal?.reason || "Job aborted");
    killProcessTree(child, "SIGTERM");
    abortKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), SIGTERM_TO_SIGKILL_MS);
  };
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  let protocolError: string | null = null;
  let protocolErrorIsCause = false;
  try {
    await runTurn(connection, input, state);
  } catch (error) {
    protocolError = error instanceof Error ? error.message : String(error);
    // A server rejection names the precise cause and outranks stderr. A
    // closed connection is only a symptom: the child died and its stderr
    // says why, so that is left to lose against stderr below.
    protocolErrorIsCause = error instanceof MspError && !(error instanceof MspConnectionClosedError);
  } finally {
    clearTimeout(timeoutTimer);
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
  }

  // Close stdin so the host can shut down on its own, then insist.
  try {
    child.stdin?.end();
  } catch {
    // already closed
  }
  if (child.exitCode === null && child.signalCode === null) {
    killProcessTree(child, "SIGTERM");
    killTimer ??= setTimeout(() => killProcessTree(child, "SIGKILL"), SIGTERM_TO_SIGKILL_MS);
  }

  const exitCode = await exitPromise;
  if (killTimer) clearTimeout(killTimer);
  if (abortKillTimer) clearTimeout(abortKillTimer);

  const endTime = new Date();
  const metadata: AgentMetadata = {
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    // Prefer the turn's own duration over wall clock, the same way the
    // claude-code adapter prefers the CLI's `duration_ms`. Wall clock here
    // also covers `muse serve` cold start (~1.8s) and the teardown AXIS
    // itself triggers, neither of which is work the agent did; charging
    // them to the agent would skew the speed dimension and the `durationMs`
    // baseline metric.
    durationMs: state.turnDurationMs ?? endTime.getTime() - startTime.getTime(),
    // The host is torn down deliberately once the turn ends, so its exit code
    // reflects our SIGTERM rather than the agent's success. The turn's own
    // terminal state is the real verdict.
    exitCode: state.turnTerminal === "completed" ? 0 : exitCode === 0 ? 1 : exitCode,
    sessionId: state.sessionId ?? undefined,
    tokenUsage: state.tokenUsage,
    totalCostUsd: state.totalCostUsd,
  };

  const error = resolveError({
    timedOut,
    abortReason,
    state,
    stderr,
    spawnError,
    protocolError,
    protocolErrorIsCause,
    timeoutMs,
  });
  if (error) metadata.error = error;
  else if (state.turnTerminal === "completed") metadata.exitCode = 0;

  return {
    transcript,
    result: state.lastAssistantMessage,
    rawOutput: input.captureRawOutput ? rawOutput : undefined,
    metadata,
  };
}

/** Open the connection, start a session, and run the single turn to terminal. */
async function runTurn(connection: MspConnection, input: AgentInput, state: MuseRunState): Promise<void> {
  // MCP servers ride the session config rather than settings.json, the same
  // way the Gemini adapter passes them through ACP `session/new`. The host
  // rejects that config outright unless the `sessionMcp` capability was
  // granted at handshake time, so it is requested only when a scenario
  // actually declares servers, keeping the handshake minimal otherwise.
  const mcpServers = toMspMcpServers(input.mcpServers);
  const capabilities = mcpServers ? { requestedCapabilities: [CAPABILITY_SESSION_MCP] } : {};

  const initialized = await connection.request("initialize", {
    clientInfo: { name: "axis", version: "1.0.0" },
    capabilities,
  });
  connection.notify("initialized");

  if (mcpServers) {
    const granted = initialized.grantedCapabilities;
    if (!Array.isArray(granted) || !granted.includes(CAPABILITY_SESSION_MCP)) {
      // Better to say this plainly than to let `session/start` fail with
      // "session MCP configuration requires the sessionMcp capability".
      throw new MspError(
        `muse did not grant the ${CAPABILITY_SESSION_MCP} capability, so this scenario's MCP servers cannot be configured`,
        -1,
      );
    }
  }

  const sessionParams: Record<string, unknown> = {
    commandId: uuidv7(),
    workspaceRoot: input.workingDirectory,
    // `muse serve` deliberately has no approval flag: approval mode is
    // selected on the wire. `allowAll` is the parity move with
    // `claude-code --dangerously-skip-permissions`.
    approvalMode: APPROVAL_ALLOW_ALL,
  };
  if (input.config.model) sessionParams.modelId = input.config.model;

  if (mcpServers) sessionParams.config = { mcpServers };

  const started = await connection.request("session/start", sessionParams);
  const session = started.session as Record<string, unknown> | undefined;
  const sessionId = (session?.sessionId ?? session?.id) as string | undefined;
  if (!sessionId) throw new MspError("muse did not return a session id", -1);
  state.sessionId = sessionId;

  // The handshake and session bootstrap are done; real work starts now.
  input.onAgentReady?.();

  const turnDone = new Promise<void>((resolve) => {
    state.onTurnComplete = resolve;
  });

  await connection.request("turn/start", {
    commandId: uuidv7(),
    sessionId,
    input: [{ type: "text", text: input.prompt }],
  });

  await turnDone;
}

// ---------------------------------------------------------------------------
// Notification handling
// ---------------------------------------------------------------------------

/**
 * Fold one MSP notification into transcript + state.
 *
 * Only notifications that carry meaning for scoring become transcript
 * entries. MSP's view-bookkeeping (`session/statusChanged`, `view/gap`,
 * cursor churn) is dropped: AXIS's agent dimension audits *every* interaction,
 * so admitting bookkeeping would bury the agent's real decisions. The full
 * stream is still captured in `raw.ndjson` when `--debug` is on.
 */
function handleNotification(
  { method, params }: MspNotification,
  state: MuseRunState,
  transcript: TranscriptEntry[],
  feedText: (text: string) => void,
): void {
  switch (method) {
    case "item/delta": {
      // Streaming append to an open item's field. Accumulate so the live
      // token counter moves during long replies.
      const itemId = params.itemId as string | undefined;
      const delta = params.delta;
      if (typeof delta !== "string" || !itemId) return;
      if (params.field === "text") {
        state.deltaText.set(itemId, (state.deltaText.get(itemId) ?? "") + delta);
      }
      feedText(delta);
      return;
    }

    case "item/started": {
      // Only tool-ish items open an entry. The scoring sparse index measures
      // an interaction's duration from the `tool_use` to `tool_result`
      // timestamp gap (src/scoring/sparse-index.ts), so emitting only the
      // completion would leave every Muse tool call with no measurable
      // duration and starve the speed sub-score.
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) return;
      const toolName = toolNameOf(item);
      if (!toolName) return;
      const itemId = item.itemId as string | undefined;
      if (itemId) state.openTools.set(itemId, toolName);
      transcript.push(entry("tool_use", { ...item, tool_name: toolName }));
      return;
    }

    case "item/completed": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) recordItem(item, state, transcript, feedText);
      return;
    }

    case "session/tokenUsage": {
      absorbTokenUsage(params, state);
      return;
    }

    case "session/modelChanged": {
      const modelId = params.modelId;
      if (typeof modelId === "string") state.modelId = modelId;
      return;
    }

    case "turn/completed": {
      state.turnTerminal = (params.terminal as string | undefined) ?? "completed";
      const error = params.error as { message?: string } | undefined;
      const reason = params.reason as string | undefined;
      if (state.turnTerminal !== "completed") {
        state.turnError = error?.message ?? reason ?? `Muse turn ${state.turnTerminal}`;
      }
      const turnDuration = num(params.durationMs);
      if (turnDuration !== undefined) state.turnDurationMs = turnDuration;
      // `turn/completed` carries a final `usage` block too; prefer whatever
      // reports the larger total (see `absorbTokenUsage`).
      absorbTokenUsage(params, state);
      state.onTurnComplete?.();
      return;
    }

    case "session/closed": {
      // The host can drop a session without ever completing the turn (e.g. it
      // crashed). Release the waiter so the run fails fast instead of sitting
      // until the job timeout.
      if (state.turnTerminal === null) {
        state.turnTerminal = "failed";
        state.turnError ??= `Muse closed the session (${String(params.reason ?? "unknown reason")})`;
        state.onTurnComplete?.();
      }
      return;
    }
  }
}

/** Turn one completed MSP item into the right transcript entry. */
function recordItem(
  item: Record<string, unknown>,
  state: MuseRunState,
  transcript: TranscriptEntry[],
  feedText: (text: string) => void,
): void {
  const kind = item.kind as string | undefined;
  const itemId = item.itemId as string | undefined;
  // A streamed item's final record may omit the text that arrived as deltas.
  const streamed = itemId ? state.deltaText.get(itemId) : undefined;
  const text = (item.text as string | undefined) ?? streamed;

  switch (kind) {
    case "agentMessage": {
      if (!text) return;
      state.lastAssistantMessage = text;
      if (!streamed) feedText(text);
      transcript.push(entry("assistant", { ...item, text }));
      return;
    }

    case "reasoning": {
      if (text && !streamed) feedText(text);
      transcript.push(entry("assistant", item));
      return;
    }

    case "userMessage":
      // The prompt echoed back. Other adapters don't put it in the transcript.
      return;

    case "toolCall":
    case "userShell": {
      // Prefer the name learned at `item/started`: a completion can omit
      // `tool` and the pair must agree for the sparse index to match them.
      const toolName = (itemId ? state.openTools.get(itemId) : undefined) ?? toolNameOf(item);
      const content: Record<string, unknown> = toolName ? { ...item, tool_name: toolName } : { ...item };
      if (itemId) state.openTools.delete(itemId);
      const failed = item.status === "failed" || item.outcome === "failure";
      transcript.push(entry(failed ? "error" : "tool_result", content));
      return;
    }

    // Muse's own sub-runs. These are NOT free housekeeping to drop: a trivial
    // greeting turn spent 18.7s of its 27s running three `reminderChild`
    // children AFTER the visible answer. Dropping them left the last
    // transcript entry at 7.9s, so `sparse-index.ts` charged the remaining
    // 19.2s to `shutdownMs` and the report drew an "agent shutdown" bar wider
    // than the whole chart. Anything that occupies wall time has to appear in
    // the transcript or the timeline lies about where the time went.
    case "reminderChild":
    case "subagent":
    case "workflow":
    case "compaction": {
      transcript.push(entry("tool_result", { ...item, tool_name: INTERNAL_TASK_TOOL }));
      return;
    }

    default:
      return;
  }
}

/**
 * Absorb token usage and cost from a `session/tokenUsage` or `turn/completed`
 * notification.
 *
 * The session `cumulative` block is preferred because it is the running total
 * and carries the server-computed USD cost. Where only a per-call `usage`
 * block exists, that is used instead. Keeps the larger total rather than the
 * latest, so a subagent leg reporting its own small usage cannot clobber the
 * parent's figure.
 *
 * **Cache convention matters here.** Muse counts prompt tokens *once*,
 * cache-reads included: `totalTokens = promptTokens + outputTokens`. AXIS
 * uses Anthropic's convention, where `input` excludes cache reads and
 * `totalTokens()` (src/baselines/metrics.ts) sums
 * `input + output + cacheReadInput`. Passing Muse's `promptTokens` through as
 * `input` while also reporting `cacheReadInput` would count the cached tokens
 * twice: a real 26,607-token turn was reported as 41,184. So the cache read
 * is subtracted back out, which keeps the split visible AND makes AXIS's sum
 * equal Muse's own `totalTokens`.
 */
function absorbTokenUsage(params: Record<string, unknown>, state: MuseRunState): void {
  const cumulative = params.cumulative as Record<string, unknown> | undefined;
  const perCall = params.usage as Record<string, unknown> | undefined;

  const next = cumulative
    ? {
        prompt: num(cumulative.promptTokens) ?? 0,
        output: num(cumulative.outputTokens) ?? 0,
        cacheRead: num(cumulative.cacheReadTokens),
      }
    : perCall
      ? {
          prompt: num(perCall.inputTokens) ?? 0,
          output: num(perCall.outputTokens) ?? 0,
          cacheRead: num(perCall.cacheReadTokens) ?? num(perCall.cachedTokens),
        }
      : null;

  if (next) {
    const cacheRead = next.cacheRead;
    const usage: TokenUsage = {
      // `Math.max(0, …)` guards a provider that ever reports a cache read
      // larger than the prompt; the total must never go negative.
      input: cacheRead !== undefined ? Math.max(0, next.prompt - cacheRead) : next.prompt,
      output: next.output,
      ...(cacheRead !== undefined ? { cacheReadInput: cacheRead } : {}),
    };
    const current = state.tokenUsage;
    const total = (u: TokenUsage) => u.input + u.output + (u.cacheReadInput ?? 0);
    if (!current || total(current) <= total(usage)) {
      state.tokenUsage = usage;
    }
  }

  // `cost` is absent entirely when no leg was priced, which is the signal to
  // report no cost at all rather than $0.
  const cost = cumulative?.cost as { usd?: unknown; partial?: unknown } | undefined;
  const usd = num(cost?.usd);
  // `cost.partial` (some legs unpriced) is not reported separately: AgentMetadata
  // has no way to express it, and the figure is still the best estimate available.
  if (usd !== undefined) state.totalCostUsd = usd;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The stable tool identifier for an item, or null if it isn't a tool call.
 *
 * Hoisted to `content.tool_name` by the callers, which is the first key
 * `extractToolName` (src/transcript/extract.ts) checks, so scoring
 * categorizes Muse tool calls with no special-casing on its side.
 */
function toolNameOf(item: Record<string, unknown>): string | null {
  const kind = item.kind as string | undefined;
  if (kind === "userShell") return (item.tool as string | undefined) ?? "shell";
  if (kind && INTERNAL_TASK_KINDS.has(kind)) return INTERNAL_TASK_TOOL;
  if (kind !== "toolCall") return null;
  return (item.tool as string | undefined) ?? "unknown";
}

function entry(type: TranscriptEntry["type"], content: Record<string, unknown>): TranscriptEntry {
  return { type, timestamp: new Date().toISOString(), content };
}

// ---------------------------------------------------------------------------
// Process setup
// ---------------------------------------------------------------------------

function buildServeArgs(input: AgentInput): string[] {
  const flags = input.config.flags ?? {};
  // Muse ships with an OS sandbox on and treats an unfamiliar workspace as
  // untrusted (which also suppresses its skills and rules). Both are fixed
  // for the host's lifetime, so they must be set here. AXIS's isolation is
  // the throwaway workspace plus remapped HOME, not the agent's own sandbox,
  // and leaving the sandbox on would block the writes and network access
  // scenarios are written to exercise. Opt out with `flags: { yolo: false }`.
  const yolo = flags.yolo ?? true;

  const args = ["serve"];
  if (yolo) args.push("--disable-sandbox", "--trust-workspace");
  if (input.config.model) args.push("--model", input.config.model);

  for (const [key, value] of Object.entries(flags)) {
    if (key === "yolo") continue;
    if (value === true) args.push(`--${key}`);
    else if (value !== false) args.push(`--${key}`, String(value));
  }
  return args;
}

/**
 * Translate AXIS MCP config into the shape `session/start` expects.
 *
 * MSP's `SessionMcpServerConfig` is NOT the Claude/`mcpServers` shape. It is
 * discriminated on a required `transport` field (`"stdio"` | `"streamableHttp"`)
 * rather than `type`, and the HTTP branch has no `type` key at all. Sending
 * the Claude shape is rejected outright with
 * `invalid session/start config: mcpServers does not match the supported shape`.
 * Field list verified against `muse schema generate-json-schema`.
 */
function toMspMcpServers(servers: Record<string, McpServerConfig> | undefined): Record<string, unknown> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;

  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "stdio") {
      const entry: Record<string, unknown> = { transport: "stdio", command: server.command };
      if (server.args?.length) entry.args = server.args;
      if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
      result[name] = entry;
    } else {
      const entry: Record<string, unknown> = { transport: "streamableHttp", url: server.url };
      if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
      result[name] = entry;
    }
  }
  return result;
}

async function prepareMuseHome(input: AgentInput): Promise<void> {
  const configDir = path.join(input.homeDirectory, ".config", "muse");
  fs.mkdirSync(configDir, { recursive: true });

  // With no API key, propagate the operator's `muse login` session. Only
  // sufficient for file-backed credentials; `hasLocalSession` already refuses
  // the keychain-backed case.
  if (!input.env?.META_API_KEY) copyHostAuth(configDir);

  // User-scoped skills live under the CONFIG dir for Muse (verified via
  // `muse skills install --scope user`, which reports `$CONFIG_DIR/skills/<id>`),
  // not the data dir, so they land under HOME and stay out of the workspace.
  if (input.resolvedSkills?.length) writeMuseSkills(configDir, input.resolvedSkills);
}

/** Pick the most useful error for a failed run, most specific first. */
function resolveError(ctx: {
  timedOut: boolean;
  abortReason: string | null;
  state: MuseRunState;
  stderr: string;
  spawnError: string | null;
  protocolError: string | null;
  /** True when the protocol error is a server rejection, not a dead connection. */
  protocolErrorIsCause: boolean;
  timeoutMs: number;
}): string | undefined {
  if (ctx.abortReason) return ctx.abortReason;
  if (ctx.timedOut) return `Agent timed out after ${Math.round(ctx.timeoutMs / 1000)}s`;
  if (ctx.state.turnError) return ctx.state.turnError;
  if (ctx.spawnError) return ctx.spawnError;
  if (ctx.state.turnTerminal === "completed") return undefined;
  // A server rejection outranks stderr. AXIS always SIGTERMs the host during
  // teardown and Muse answers with "received SIGTERM; flushed session logs",
  // so the stderr tail is nearly always that line. Letting it win buried a
  // precise, actionable rejection ("invalid session/start config: mcpServers
  // does not match the supported shape") behind teardown noise.
  if (ctx.protocolErrorIsCause && ctx.protocolError) return ctx.protocolError;
  // Otherwise Muse's own stderr wording is the most useful thing available:
  // credential and billing failures land there before the protocol gets
  // going, and all we would have is "exited before the turn completed".
  const stderrTail = meaningfulStderr(ctx.stderr);
  if (stderrTail) return stderrTail;
  if (ctx.protocolError) return ctx.protocolError;
  return "Muse run did not complete";
}

/**
 * Last stderr line that says something, skipping Muse's teardown
 * acknowledgement. AXIS always terminates the host itself, so that line is
 * noise on every single run and never explains a failure.
 */
function meaningfulStderr(stderr: string): string | undefined {
  const lines = stderr
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/received SIGTERM/i.test(line));
  return lines.pop();
}

function failedOutput(startTime: Date, message: string): AgentOutput {
  const endTime = new Date();
  return {
    transcript: [],
    result: null,
    metadata: {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - startTime.getTime(),
      exitCode: 1,
      error: message,
    },
  };
}

// ---------------------------------------------------------------------------
// Local session detection
// ---------------------------------------------------------------------------

/** Muse's config dir on the operator's real machine. */
function hostMuseConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "muse") : path.join(os.homedir(), ".config", "muse");
}

/**
 * Is there a `muse login` session we can actually carry into an isolated run?
 *
 * `auth.json` records *where* each provider's credential is kept. On macOS
 * `muse login` reports `storage: "keychain"` and the file holds no secret, so
 * copying it into an isolated config dir authenticates nothing. Verified: the
 * run dies with "missing meta credentials: run `muse login` or set
 * META_API_KEY…". Returning true there would turn a clean pre-flight failure
 * into a confusing mid-run one, so keychain-backed entries deliberately read
 * as "no local session" and the user is told to set `META_API_KEY`.
 *
 * File-backed credentials (the CI/Linux shape, and the one Muse's own error
 * message points at) copy fine, so those do count.
 */
function hasPortableMuseSession(): boolean {
  try {
    const raw = fs.readFileSync(path.join(hostMuseConfigDir(), "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null) return false;
    return Object.values(providers as Record<string, unknown>).some(
      (p) => typeof p === "object" && p !== null && (p as { storage?: unknown }).storage !== "keychain",
    );
  } catch {
    return false;
  }
}

/** Copy the operator's `auth.json` into an isolated config dir, if present. */
function copyHostAuth(destDir: string): void {
  const src = path.join(hostMuseConfigDir(), "auth.json");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, "auth.json"));
}
