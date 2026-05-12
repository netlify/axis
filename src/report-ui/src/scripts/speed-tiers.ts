/* Speed scoring tiers — mirrors computeHeuristicSpeed in src/scoring/deep-eval.ts.
   Kept in sync manually; if the thresholds change there, change them here too. */

export interface SpeedTier {
  /** Inclusive upper bound in seconds; null = "anything slower than the previous bound". */
  maxSeconds: number | null;
  /** Score on the 0-100 scale assigned to this tier. */
  score: number;
}

export type SpeedTierKind = "service" | "environment" | "agent";

const TIERS: Record<SpeedTierKind, SpeedTier[]> = {
  service: [
    { maxSeconds: 2, score: 100 },
    { maxSeconds: 5, score: 90 },
    { maxSeconds: 10, score: 80 },
    { maxSeconds: 25, score: 60 },
    { maxSeconds: null, score: 40 },
  ],
  environment: [
    { maxSeconds: 0.5, score: 100 },
    { maxSeconds: 2, score: 90 },
    { maxSeconds: 5, score: 80 },
    { maxSeconds: 10, score: 60 },
    { maxSeconds: null, score: 40 },
  ],
  agent: [
    { maxSeconds: 2, score: 100 },
    { maxSeconds: 5, score: 90 },
    { maxSeconds: 15, score: 80 },
    { maxSeconds: 30, score: 60 },
    { maxSeconds: null, score: 40 },
  ],
};

/** Pick the tier kind for an interaction. Mirrors the precedence in computeHeuristicSpeed:
    service first, then environment, then agent. */
export function getSpeedTierKind(categories: readonly string[]): SpeedTierKind {
  if (categories.includes("service")) return "service";
  if (categories.includes("environment")) return "environment";
  return "agent";
}

export function getSpeedTiers(kind: SpeedTierKind): SpeedTier[] {
  return TIERS[kind];
}

/** Index of the tier this duration landed in. Returns null if duration is missing. */
export function getLandedTierIndex(durationMs: number | null, kind: SpeedTierKind): number | null {
  if (durationMs === null || durationMs <= 0) return 0; // matches "no timing → 1.0" path
  const seconds = durationMs / 1000;
  const tiers = TIERS[kind];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.maxSeconds === null || seconds <= t.maxSeconds) return i;
  }
  return tiers.length - 1;
}

function fmtSeconds(s: number): string {
  if (s < 1) return `${s * 1000}ms`;
  if (Number.isInteger(s)) return `${s}s`;
  return `${s.toFixed(1)}s`;
}

/** Human label for a tier row, e.g. "≤2s" or "> 25s". */
export function tierLabel(tier: SpeedTier, prev: SpeedTier | undefined): string {
  if (tier.maxSeconds === null) {
    const prevMax = prev?.maxSeconds;
    return prevMax !== undefined && prevMax !== null ? `> ${fmtSeconds(prevMax)}` : "any";
  }
  return `≤ ${fmtSeconds(tier.maxSeconds)}`;
}

const KIND_LABEL: Record<SpeedTierKind, string> = {
  service: "Service",
  environment: "Environment",
  agent: "Agent",
};

export function tierKindLabel(kind: SpeedTierKind): string {
  return KIND_LABEL[kind];
}
