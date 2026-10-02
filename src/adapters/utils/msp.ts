import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal client for Muse's Session Protocol (MSP), the JSON-RPC 2.0 dialect
 * `muse serve` speaks over stdio.
 *
 * Framing is newline-delimited JSON (one object per line), NOT the
 * `Content-Length` header framing LSP uses. Verified against muse 1.4.2.
 *
 * Only the slice AXIS needs is modelled: open a connection, start a session,
 * run one turn, and read the notifications that arrive while it runs. The
 * authoritative wire schema ships inside the binary and can be regenerated
 * with `muse schema generate-json-schema` / `generate-ts`.
 */

/** A JSON-RPC notification pushed by the server. */
export interface MspNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Generate a UUIDv7 (time-ordered).
 *
 * MSP rejects anything else for `commandId` with
 * `invalid session/start commandId: expected UUIDv7`, so `crypto.randomUUID`
 * (which is v4) cannot be used. Layout per RFC 9562: 48-bit big-endian
 * millisecond timestamp, 4-bit version `0b0111`, 2-bit variant `0b10`, the
 * rest random.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An MSP error returned by the server, carrying its JSON-RPC code. */
export class MspError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "MspError";
  }
}

/**
 * The connection went away with requests still in flight.
 *
 * Distinct from `MspError` because it is a *symptom*: the child died, and the
 * reason is on its stderr. Callers prefer stderr over this message, while a
 * genuine `MspError` (a server rejection like `invalidParams`) outranks
 * stderr because it is the precise cause.
 */
export class MspConnectionClosedError extends MspError {
  constructor(message: string) {
    super(message, -1);
    this.name = "MspConnectionClosedError";
  }
}

/**
 * A live MSP connection over a child process's stdio.
 *
 * Requests are correlated by JSON-RPC id; notifications are handed to
 * `onNotification` in arrival order.
 */
export class MspConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closeReason = "MSP connection closed";

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onNotification: (notification: MspNotification) => void,
    /** Called for each raw stdout line, so the runner can tee a debug log. */
    private readonly onRawLine?: (line: string) => void,
  ) {
    // readline, like the NDJSON adapters, so a record split across chunk
    // boundaries is reassembled before parsing.
    createInterface({ input: stdout }).on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.onRawLine?.(line);

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // `muse serve` keeps diagnostics on stderr, but a stray non-JSON line
      // must never take the connection down mid-run.
      return;
    }

    const id = message.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      const error = message.error as { message?: string; code?: number } | undefined;
      if (error) {
        pending.reject(new MspError(error.message ?? "MSP request failed", error.code ?? -1));
      } else {
        pending.resolve((message.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    if (typeof message.method === "string") {
      this.onNotification({
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
      });
    }
  }

  /** Send a request and await its result. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new MspConnectionClosedError(this.closeReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification (no reply expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.write(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      // The child's stdin can close under us when it exits mid-turn; the
      // pending request is settled by `rejectAll` from the close handler.
    }
  }

  /**
   * Fail every in-flight request. Called when the child exits, so a turn that
   * was waiting on a reply rejects instead of hanging until the job timeout.
   */
  rejectAll(reason: string): void {
    this.closed = true;
    this.closeReason = reason;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new MspConnectionClosedError(reason));
    }
  }
}
