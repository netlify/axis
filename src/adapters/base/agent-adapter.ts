import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AgentAdapter,
  AgentInput,
  AgentMetadata,
  AgentOutput,
  IsolationPaths,
  TranscriptEntry,
} from "../../types/agent.js";
import { resolveCommand, type ResolvedCommand } from "../utils/resolve.js";
import { createTokenEstimator } from "../utils/token-estimator.js";

/** Default timeout for agent execution (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum bytes of stderr to buffer before truncating. */
export const MAX_STDERR_BYTES = 100_000;

/** Grace period between SIGTERM and SIGKILL for non-responsive processes. */
export const SIGTERM_TO_SIGKILL_MS = 5_000;

// ---------------------------------------------------------------------------
// Context types passed to adapter callbacks
// ---------------------------------------------------------------------------

/** Context handed to `prepare` before the agent process is spawned. */
export interface SetupContext {
  readonly input: AgentInput;
  /** Agent's `cwd` — pristine, only scenario-provided files. */
  readonly workingDirectory: string;
  /** Agent's HOME — adapter config dirs (`.codex`, `.claude`, …) live here. */
  readonly homeDirectory: string;
  /**
   * Authoritative env the child will actually receive. The runner merges
   * `isolationEnv({ workspace, home })` into `input.env` before calling `run`,
   * so this already contains e.g. `CODEX_HOME` / `GEMINI_CLI_HOME` pointing
   * under `homeDirectory`.
   */
  readonly env: Record<string, string> | undefined;
}

/** Context available during stdout streaming (`onLine` / `onChunk` / `onEnd`). */
export interface StreamContext<State> {
  readonly state: State;
  readonly transcript: TranscriptEntry[];
  /**
   * Feed assistant text to the live token estimator. Call with any text the
   * agent produced (assistant messages, reasoning, etc.).
   */
  feedAssistantText(text: string): void;
}

/** Context handed to `getResult` after the agent process exits. */
export interface ResultContext<State> {
  readonly state: State;
  readonly transcript: TranscriptEntry[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly startTime: Date;
  readonly endTime: Date;
}

/** Return shape for `getResult`. Merged on top of base-computed metadata. */
export interface AdapterResult {
  /**
   * The final assistant-visible result. Use `null` for "no result" — do NOT
   * return `""`, as the base uses `null` as the sentinel for missing output.
   */
  result: string | null;
  /**
   * Metadata overrides. Spread on top of base-computed fields (`startTime`,
   * `endTime`, `durationMs`, `exitCode`), so e.g. `{ durationMs: upstream }`
   * replaces the wall-clock duration with a CLI-reported value.
   */
  metadata?: Partial<AgentMetadata>;
}

// ---------------------------------------------------------------------------
// Spec — the single object that fully describes an agent adapter
// ---------------------------------------------------------------------------

/**
 * A declarative spec for an agent adapter. Pass to `createAgentAdapter`
 * to get back an `AgentAdapter`.
 *
 * `streamConfig` defines how the adapter processes the agent's stdout stream.
 * It's a discriminated union: `lines` mode hands you parsed NDJSON-style lines,
 * `aggregate` mode hands you raw stdout chunks. This is encoded at the type
 * level so `mode` and its handler can never be out of sync.
 */
export type AgentAdapterSpec<State> = {
  /** Adapter name. Used in logs, error messages, and `AgentAdapter.name`. */
  name: string;

  /**
   * CLI binary resolved via `resolveCommand` + npx fallback. Omit if the
   * adapter gets its command from `input.config.command` at runtime.
   */
  cliCommand?: string;

  /** Execution timeout. Defaults to `DEFAULT_TIMEOUT_MS` (10 min). */
  timeoutMs?: number;

  /** Stderr buffer cap. Defaults to `MAX_STDERR_BYTES` (100 KB). */
  maxStderrBytes?: number;

  /** Env vars the adapter requires (validated by runner pre-flight). */
  requiredEnv?: () => string[];

  /**
   * Detect a usable local CLI login. Runner calls this only when
   * `requiredEnv` is missing — API keys always take precedence.
   */
  hasLocalSession?: () => boolean | Promise<boolean>;

  /** Workspace isolation env vars (merged into child env by runner). */
  isolationEnv?: (paths: IsolationPaths) => Record<string, string>;

  /**
   * Pre-spawn side effects: mkdir, MCP config writers, skills writers, etc.
   * Runs after env is finalized and before the process is spawned.
   */
  prepare?: (ctx: SetupContext) => void | Promise<void>;

  /**
   * Override how the CLI command is resolved. Default: prefer the CLI resolved
   * from `cliCommand` via npx fallback; otherwise fall back to
   * `input.config.command`; otherwise throw.
   */
  resolveCommand?: (input: AgentInput, resolved: ResolvedCommand | null) => ResolvedCommand;

  /** Build the CLI arguments for the agent process. Prefix args from command resolution are prepended automatically. */
  buildArgs: (input: AgentInput) => string[];

  /** Per-run mutable state. Called once per run to create a fresh state bag for `streamConfig` handlers and `getResult`. */
  initialState: () => State;

  /**
   * How to process the agent's stdout stream. Choose a mode:
   *
   * - **`lines`** — readline-based: each line is delivered to `onLine`. Use for agents that emit NDJSON.
   * - **`aggregate`** — raw chunks: each `data` event is delivered to `onChunk`. Use for agents
   *   that write plain text or when you just need the full output.
   */
  streamConfig:
    | {
        mode: "lines";
        /** Called once per stdout line. Parse JSON inside the callback. */
        onLine: (line: string, ctx: StreamContext<State>) => void;
        /** Called in `finally` after stream ends (success, error, or timeout). */
        onEnd?: (ctx: StreamContext<State>) => void;
      }
    | {
        mode: "aggregate";
        /**
         * Called once per stdout chunk. The base automatically feeds each chunk
         * to the token estimator, so typically just accumulate into state.
         */
        onChunk: (chunk: string, ctx: StreamContext<State>) => void;
        /** Called after data has fully drained (success, error, or timeout). */
        onEnd?: (ctx: StreamContext<State>) => void;
      };

  /** Build the final result + metadata from accumulated state after the process exits. */
  getResult: (ctx: ResultContext<State>) => AdapterResult;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an `AgentAdapter` from a declarative spec. The returned adapter owns:
 * spawn, stdin close, cleanup registration, stderr cap, timeout →
 * SIGTERM → SIGKILL (with proper timer cleanup), exit promise ordering, raw
 * output capture, token estimator wiring, and the three outcome branches
 * (timed-out / non-zero exit with no result / success).
 *
 * Error precedence on failure:
 *   1. `getResult(...).metadata.error` — wins if set
 *   2. `stderr` — if non-empty
 *   3. Generic `"Agent process exited with non-zero code"`
 */
export function createAgentAdapter<State>(spec: AgentAdapterSpec<State>): AgentAdapter {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStderrBytes = spec.maxStderrBytes ?? MAX_STDERR_BYTES;

  // Cached resolved command from ensureInstalled. Null until resolved.
  let resolved: ResolvedCommand | null = null;

  async function doResolve(): Promise<void> {
    if (!spec.cliCommand) return;
    resolved = await resolveCommand(spec.name, spec.cliCommand);
  }

  function defaultResolveCommand(input: AgentInput): ResolvedCommand {
    if (resolved) return resolved;
    if (input.config.command) return { command: input.config.command, prefixArgs: [] };
    throw new Error(`The "${spec.name}" adapter has no command to spawn.`);
  }

  return {
    name: spec.name,
    requiredEnv: spec.requiredEnv,
    hasLocalSession: spec.hasLocalSession,
    isolationEnv: spec.isolationEnv,

    async ensureInstalled(_logger) {
      await doResolve();
    },

    async run(input) {
      // 1. Defensive: resolve if pre-flight was skipped (e.g. direct use)
      if (spec.cliCommand && !resolved) {
        await doResolve();
      }

      // 2. Pre-spawn side effects
      await spec.prepare?.({
        input,
        workingDirectory: input.workingDirectory,
        homeDirectory: input.homeDirectory,
        env: input.env,
      });

      // 3. Resolve the command
      const resolveFn = spec.resolveCommand ?? defaultResolveCommand;
      const { command, prefixArgs } = resolveFn(input, resolved);

      // 4. Build args
      const args = spec.buildArgs(input);

      const startTime = new Date();
      const state = spec.initialState();
      const transcript: TranscriptEntry[] = [];
      const estimator = createTokenEstimator(input.onTokenProgress);
      const rawOutput: string[] | undefined = input.captureRawOutput ? [] : undefined;

      const streamCtx: StreamContext<State> = {
        state,
        transcript,
        feedAssistantText: (text) => estimator.addText(text),
      };

      // 5. Spawn
      const child: ChildProcess = spawn(command, [...prefixArgs, ...args], {
        cwd: input.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: input.env ?? { ...process.env },
      });

      child.stdin?.end();

      // 6. Cleanup handler for Ctrl-C
      input.registerCleanup?.(() => {
        child.kill("SIGTERM");
      });

      // 7. Register close listener BEFORE reading stdout (ordering matters)
      const exitPromise = new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
      });

      // 8. Buffer stderr with a size cap (and mirror to debug callback if any)
      let stderr = "";
      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length < maxStderrBytes) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
      });

      // 9. Timeout → SIGTERM → SIGKILL, with proper timer cleanup
      const effectiveTimeout = input.timeoutMs ?? timeoutMs;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const outerTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_TO_SIGKILL_MS);
      }, effectiveTimeout);

      // 9b. External abort signal (from runner limits)
      let abortedBySignal = false;
      let abortReason = "";
      let signalKillTimer: NodeJS.Timeout | undefined;

      if (input.signal) {
        const onAbort = () => {
          if (abortedBySignal) return;
          abortedBySignal = true;
          abortReason = String(input.signal!.reason || "Job aborted");
          child.kill("SIGTERM");
          signalKillTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_TO_SIGKILL_MS);
        };
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
          child.on("close", () => {
            input.signal!.removeEventListener("abort", onAbort);
          });
        }
      }

      child.on("close", () => {
        if (killTimer) clearTimeout(killTimer);
        if (signalKillTimer) clearTimeout(signalKillTimer);
      });

      // 10. Stream stdout — capture spec locally so TS narrowing survives closures
      const streamSpec = spec.streamConfig;
      try {
        if (streamSpec.mode === "lines") {
          const stdout = child.stdout;
          if (stdout) {
            const rl = createInterface({ input: stdout });
            try {
              for await (const line of rl) {
                if (!line.trim()) continue;
                rawOutput?.push(line);
                input.onRawLine?.(line);
                streamSpec.onLine(line, streamCtx);
              }
            } catch {
              // Stream error — process may have been killed
            }
          }
        } else {
          child.stdout?.on("data", (data: Buffer) => {
            const chunk = data.toString();
            rawOutput?.push(chunk);
            input.onRawLine?.(chunk);
            estimator.addText(chunk);
            streamSpec.onChunk(chunk, streamCtx);
          });
        }
      } finally {
        // Flush on lines mode before awaiting exit; aggregate mode flushes
        // after exit so data has fully drained (see below).
        if (streamSpec.mode === "lines") {
          try {
            streamSpec.onEnd?.(streamCtx);
          } catch {
            // Never let a faulty flush hook mask the primary outcome
          }
        }
        clearTimeout(outerTimer);
      }

      // 11. Wait for process exit
      const exitCode = await exitPromise;
      const endTime = new Date();

      // Aggregate: run onEnd after data has drained (close fires after stdout).
      if (streamSpec.mode === "aggregate") {
        try {
          streamSpec.onEnd?.(streamCtx);
        } catch {
          // Never let a faulty flush hook mask the primary outcome
        }
      }

      // 12. Timeout path — never calls getResult
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
            error: `Agent timed out after ${effectiveTimeout / 1000}s`,
          },
        };
      }

      // 12b. Abort path (external signal from runner limits)
      if (abortedBySignal) {
        return {
          transcript,
          result: null,
          rawOutput,
          metadata: {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            durationMs: endTime.getTime() - startTime.getTime(),
            exitCode,
            error: abortReason,
          },
        };
      }

      // 13. Build result + metadata overrides
      const extracted = spec.getResult({
        state,
        transcript,
        exitCode,
        stderr,
        startTime,
        endTime,
      });

      // 14. Error precedence
      let error = extracted.metadata?.error;
      if (!error && exitCode !== 0 && extracted.result === null) {
        error = stderr || "Agent process exited with non-zero code";
      }

      // 15. Merge metadata
      const metadata: AgentMetadata = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMs: endTime.getTime() - startTime.getTime(),
        exitCode,
        ...extracted.metadata,
        ...(error ? { error } : {}),
      };

      const result: AgentOutput = {
        transcript,
        result: extracted.result,
        rawOutput,
        metadata,
      };
      return result;
    },
  };
}
