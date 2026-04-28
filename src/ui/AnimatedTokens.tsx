import { useEffect, useState } from "react";
import { Text } from "ink";

/** Interval between animation ticks (ms). ~20 Hz. */
const TICK_MS = 50;

/** Ease-out factor: fraction of remaining distance closed per tick. */
const EASE_FACTOR = 0.12;

/**
 * Pure interpolation step: given the currently displayed value and the target,
 * returns the next displayed value. Always increases by at least 1 when behind,
 * never overshoots, and never decreases.
 */
export function nextDisplayed(current: number, target: number): number {
  if (current >= target) return current;
  const remaining = target - current;
  const step = Math.max(1, Math.ceil(remaining * EASE_FACTOR));
  return Math.min(target, current + step);
}

export interface AnimatedTokensProps {
  /** Monotonically-increasing target value to count up toward. */
  target: number;
  /**
   * When true, the component keeps its interval running even after catching up
   * to `target` so it can animate further increases. When false, the interval
   * self-stops once displayed === target.
   */
  active: boolean;
  /**
   * When true, `target` reflects the authoritative total from the adapter's
   * `metadata.tokenUsage` (not the chars/5 estimate). The `~` prefix is
   * dropped once the displayed value catches up to this true target.
   */
  isFinal?: boolean;
}

/**
 * Smoothly counts up a number toward `target`. Never overshoots. Never
 * counts down — if `target` regresses (it shouldn't, by design), the displayed
 * value simply holds until target catches up.
 */
export function AnimatedTokens({ target, active, isFinal }: AnimatedTokensProps) {
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    // Nothing to animate: no target yet.
    if (target <= 0) return;

    const interval = setInterval(() => {
      setDisplayed((current) => {
        if (current >= target) {
          // Caught up. Only stop auto-ticking when the job is no longer active.
          if (!active) {
            clearInterval(interval);
          }
          return current;
        }
        return nextDisplayed(current, target);
      });
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [target, active]);

  if (target <= 0) return null;

  // Drop the `~` prefix once the real total has arrived and the animation
  // has caught up — from that point on the number is authoritative, not an
  // estimate.
  const prefix = isFinal && displayed >= target ? "" : "~";

  return (
    <Text dimColor>
      {prefix}
      {displayed.toLocaleString()} tok
    </Text>
  );
}
