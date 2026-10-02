import { vi } from "vitest";
import { EventEmitter, Readable } from "node:stream";

/**
 * A scripted stand-in for `muse serve`.
 *
 * MSP is bidirectional, so unlike the NDJSON adapters a mock cannot just push
 * lines at stdout: it has to read the JSON-RPC requests the adapter writes to
 * stdin and answer them. This mock parses incoming requests, replies with a
 * result, and emits whatever notifications the test scripts for that method.
 *
 * Shapes here mirror real `muse serve` 1.4.2 traffic captured during
 * development, including the `session/started` notification and the
 * `turn/completed` terminal.
 */

export interface MspMockOptions {
  /** Notifications to emit after `turn/start` is answered, in order. */
  turnNotifications?: Array<{ method: string; params: Record<string, unknown> }>;
  /** Override the session id the host reports. */
  sessionId?: string;
  /** Make a specific method reply with a JSON-RPC error. */
  errorOn?: { method: string; code: number; message: string };
  /** Exit the process (code) instead of ever answering `turn/start`. */
  dieOnTurn?: number;
  /** Text written to stderr before anything else. */
  stderr?: string;
  /** Skip the terminal `turn/completed`, to exercise the session/closed path. */
  omitTurnCompleted?: boolean;
  /** Refuse these capabilities even when the client requests them. */
  denyCapabilities?: string[];
}

export const DEFAULT_SESSION_ID = "01a0fd18-36c4-7e62-8162-c06b933ce358";

/** A completed `agentMessage` item notification. */
export function agentMessage(text: string, itemId = "item-agent-1") {
  return {
    method: "item/completed",
    params: {
      sessionId: DEFAULT_SESSION_ID,
      item: { itemId, kind: "agentMessage", status: "completed", text },
    },
  };
}

/** A started `toolCall` item notification, the open half of the pair. */
export function toolCallStarted(tool: string, itemId = `item-tool-${tool}`) {
  return {
    method: "item/started",
    params: {
      sessionId: DEFAULT_SESSION_ID,
      item: { itemId, kind: "toolCall", tool, callId: "call-1", status: "inProgress" },
    },
  };
}

/** A completed `toolCall` item notification. */
export function toolCall(tool: string, opts: { failed?: boolean; args?: unknown } = {}) {
  return {
    method: "item/completed",
    params: {
      sessionId: DEFAULT_SESSION_ID,
      item: {
        itemId: `item-tool-${tool}`,
        kind: "toolCall",
        tool,
        callId: "call-1",
        args: opts.args,
        status: opts.failed ? "failed" : "completed",
        outcome: opts.failed ? "failure" : "success",
      },
    },
  };
}

/** A completed internal sub-run item (reminder child, subagent, workflow). */
export function internalItem(kind: string, itemId = `item-${kind}`) {
  return {
    method: "item/completed",
    params: { sessionId: DEFAULT_SESSION_ID, item: { itemId, kind, status: "completed" } },
  };
}

/** A `session/tokenUsage` notification carrying cumulative counters and cost. */
export function tokenUsage(cumulative: Record<string, unknown>, perCall?: Record<string, unknown>) {
  return {
    method: "session/tokenUsage",
    params: {
      sessionId: DEFAULT_SESSION_ID,
      turnId: "turn-1",
      modelId: "muse-spark",
      ...(perCall ? { usage: perCall } : {}),
      cumulative,
    },
  };
}

/** The terminal `turn/completed` notification. */
export function turnCompleted(terminal = "completed", extra: Record<string, unknown> = {}) {
  return {
    method: "turn/completed",
    params: { sessionId: DEFAULT_SESSION_ID, turnId: "turn-1", terminal, ...extra },
  };
}

/**
 * Create a mock child process that speaks MSP.
 *
 * Returns the process plus the list of requests it received, so tests can
 * assert on what the adapter actually sent (approval mode, MCP config, …).
 */
export function createMspMockProcess(options: MspMockOptions = {}) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null as unknown,
    kill: vi.fn(),
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });

  let closed = false;
  const close = (code: number) => {
    if (closed) return;
    closed = true;
    proc.exitCode = code;
    stdout.push(null);
    stderr.push(null);
    setTimeout(() => proc.emit("close", code), 0);
  };

  const emit = (message: Record<string, unknown>) => {
    if (!closed) stdout.push(JSON.stringify(message) + "\n");
  };

  // The adapter writes newline-delimited JSON-RPC here.
  let buffer = "";
  const stdinStub = {
    write: (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) handleRequest(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
    end: vi.fn(() => close(0)),
    on: vi.fn(),
  };
  proc.stdin = stdinStub;

  function handleRequest(message: Record<string, unknown>): void {
    const method = message.method as string;
    const id = message.id as number | undefined;
    requests.push({ method, params: (message.params ?? {}) as Record<string, unknown> });

    if (id === undefined) return; // a notification, e.g. `initialized`

    if (options.errorOn?.method === method) {
      emit({
        jsonrpc: "2.0",
        id,
        error: { code: options.errorOn.code, message: options.errorOn.message },
      });
      return;
    }

    switch (method) {
      case "initialize": {
        // The real host echoes back the subset of requested capabilities it
        // grants; `session/start` rejects session MCP config without them.
        const requested = ((message.params as Record<string, unknown>)?.capabilities as Record<string, unknown>)
          ?.requestedCapabilities;
        const granted = Array.isArray(requested)
          ? (requested as string[]).filter((c) => !options.denyCapabilities?.includes(c))
          : [];
        emit({
          jsonrpc: "2.0",
          id,
          result: { serverInfo: { name: "muse", version: "1.4.2" }, grantedCapabilities: granted },
        });
        return;
      }

      case "session/start":
        emit({
          jsonrpc: "2.0",
          id,
          result: { session: { sessionId, status: "idle" }, viewCursor: `v:${sessionId}:1` },
        });
        emit({ jsonrpc: "2.0", method: "session/started", params: { session: { sessionId } } });
        return;

      case "turn/start": {
        if (options.dieOnTurn !== undefined) {
          close(options.dieOnTurn);
          return;
        }
        emit({
          jsonrpc: "2.0",
          id,
          result: {
            commandId: "c1",
            turnId: "turn-1",
            status: "accepted",
            startedNewTurn: true,
            disposition: "started",
          },
        });
        const notifications = options.turnNotifications ?? [agentMessage("Done")];
        for (const n of notifications) emit({ jsonrpc: "2.0", method: n.method, params: n.params });
        if (!options.omitTurnCompleted) emit({ jsonrpc: "2.0", ...turnCompleted() });
        return;
      }

      default:
        emit({ jsonrpc: "2.0", id, result: {} });
    }
  }

  // Pushed synchronously: `dieOnTurn` closes the streams as soon as the turn
  // request lands, and anything queued after that `push(null)` is dropped.
  if (options.stderr) stderr.push(options.stderr);

  return { proc, requests };
}
