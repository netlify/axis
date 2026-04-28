import { useEffect, useState } from "react";
import { Text } from "ink";
import { formatDuration } from "./format.js";

/** Update interval for the ticking elapsed timer (ms). */
const TICK_MS = 100;

export interface LiveDurationProps {
  /** Epoch-ms when the job entered `running`. Drives the live elapsed counter. */
  startedAt?: number;
  /** Final duration in ms. Once set, takes precedence over the live elapsed counter. */
  finalMs?: number;
  /**
   * When true, the component keeps ticking. When false, rendering stops
   * updating (static snapshot of whatever `finalMs` / last elapsed value is).
   */
  active: boolean;
  /** Optional ink text color (inherited from the row). */
  color?: string;
}

/**
 * Renders `(12.3s)` — either the final `durationMs` from metadata (if set) or
 * a live-ticking elapsed counter computed from `startedAt`. The timer stays
 * visible in every state so users see how long each agent took / is taking.
 */
export function LiveDuration({ startedAt, finalMs, active, color }: LiveDurationProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // No ticking needed if we already have a final value, or no start time,
    // or the job is no longer active.
    if (finalMs !== undefined) return;
    if (!startedAt) return;
    if (!active) return;

    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, [startedAt, finalMs, active]);

  const ms = finalMs !== undefined ? finalMs : startedAt ? now - startedAt : undefined;
  if (ms === undefined) return null;

  return <Text color={color}>({formatDuration(ms)})</Text>;
}
