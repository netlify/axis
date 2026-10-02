import type { ChildProcess } from "node:child_process";

/** Grace period between SIGTERM and SIGKILL for non-responsive processes. */
export const SIGTERM_TO_SIGKILL_MS = 5_000;

/** Maximum bytes of stderr to buffer before truncating. */
export const MAX_STDERR_BYTES = 100_000;

/**
 * Signal a child and every process it spawned.
 *
 * The child must be spawned `detached`, so on POSIX its pid doubles as its
 * process-group id and `process.kill(-pid, …)` reaches every descendant,
 * reaping subprocesses (e.g. `node --test`) the agent shelled out to. Without
 * this, killing only the CLI can leave grandchildren running, which both leak
 * resources and can hold the child's stdio pipes open so its `close` event
 * never fires. The group kill is best-effort (the group may already be gone);
 * the direct `child.kill` is the fallback and the belt-and-suspenders path.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone, or the child was never a group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}
