/**
 * Statistical significance for baseline comparisons.
 *
 * The flat noise band (`max(1, 2σ)` in `compare.ts`) answers "did this move
 * further than the baseline's own spread" and nothing more. Two things it
 * cannot do:
 *
 * - It only looks at the baseline's variance. A current run that was unusually
 *   erratic is treated as though it were as tight as the baseline.
 * - It never tightens. Paying for nine runs instead of three buys no extra
 *   sensitivity, because the threshold stays at two standard deviations.
 *
 * A two-sample test fixes both: it consumes both sides' spread and its
 * threshold shrinks as the samples grow. For reference, the difference a test
 * can detect at α=0.05, in pooled standard deviations:
 *
 *   3 runs/side → 2.27σ   (slightly *less* sensitive than the flat band)
 *   5 runs/side → 1.46σ
 *   9 runs/side → 1.00σ
 *  18 runs/side → 0.68σ
 *
 * So at the usual `runs: 3` this agrees with the flat band almost exactly, and
 * the payoff only arrives for suites that sample more heavily. Both verdicts
 * are reported rather than one replacing the other.
 *
 * Welch's variant is used rather than Student's pooled test. The choice turns
 * on whether the two samples have equal *variance*, not on whether they come
 * from the same population: an agent that became more erratic is exactly the
 * change worth catching, and at these sample sizes variance cannot be
 * estimated well enough to justify assuming it away. Welch's is nearly as
 * powerful when variances do match and far more robust when they do not.
 */

import type { EffectMagnitude, SampleStats } from "../types/baseline.js";

export type { EffectMagnitude, SampleStats };

/** Cohen's conventional cutoffs for |d|. */
const EFFECT_THRESHOLDS: Array<{ min: number; magnitude: EffectMagnitude }> = [
  { min: 0.8, magnitude: "large" },
  { min: 0.5, magnitude: "moderate" },
  { min: 0.2, magnitude: "small" },
];

/** Default two-sided significance level. */
export const DEFAULT_ALPHA = 0.05;

/** Outcome of comparing two samples. */
export interface WelchTestResult {
  /** Difference of means, current minus baseline. */
  delta: number;
  /**
   * Welch's t statistic.
   *
   * Omitted when both samples have zero spread, where no finite t exists.
   * Reporting `Infinity` was the obvious alternative and the wrong one: JSON
   * has no representation for it, so `--json` consumers would silently receive
   * `null` and have to guess what it meant.
   */
  t?: number;
  /** Welch-Satterthwaite degrees of freedom. Not generally an integer. */
  df: number;
  /** Two-sided p-value. */
  p: number;
  /**
   * Cohen's d, using the average of the two variances. Omitted when both
   * samples have zero spread, which makes d infinite and meaningless: with no
   * spread at all, a 0.1 point difference is as "certain" as a 40 point one,
   * so sizing the effect would mislead rather than inform.
   */
  effectSize?: number;
  /** Omitted alongside `effectSize`, for the same reason. */
  magnitude?: EffectMagnitude;
  /** True when `p` is below the alpha the test was run at. */
  significant: boolean;
}

/**
 * Welch's two-sample t-test, two-sided.
 *
 * Returns undefined when either sample has fewer than two observations, since
 * a single run has no spread to test against. Callers fall back to the flat
 * band in that case.
 */
export function welchTTest(
  baseline: SampleStats,
  current: SampleStats,
  alpha: number = DEFAULT_ALPHA,
): WelchTestResult | undefined {
  if (baseline.n < 2 || current.n < 2) return undefined;

  const delta = current.mean - baseline.mean;
  const varB = baseline.stdev ** 2;
  const varC = current.stdev ** 2;
  const standardError = Math.sqrt(varB / baseline.n + varC / current.n);

  // Both samples perfectly tight: every run scored the same on each side,
  // which is common for a trivial scenario that always scores 100. Any
  // difference is then certain and no difference is certainly nothing, so
  // short-circuit rather than dividing by zero. `t` and the effect size are
  // left off, since both are infinite and an infinite d would label a 0.1
  // point gap "large".
  if (standardError === 0) {
    const certain = delta !== 0;
    return {
      delta,
      df: baseline.n + current.n - 2,
      p: certain ? 0 : 1,
      significant: certain,
      ...(certain ? {} : { effectSize: 0, magnitude: "negligible" as const }),
    };
  }

  // Cohen's d against the average variance, the usual choice when the two
  // variances are not assumed equal.
  const effectSize = delta / Math.sqrt((varB + varC) / 2);
  const t = delta / standardError;
  const df = welchSatterthwaiteDf(varB, baseline.n, varC, current.n);
  const p = twoSidedPValue(t, df);

  return { delta, t, df, p, effectSize, magnitude: classifyEffect(effectSize), significant: p < alpha };
}

/** Welch-Satterthwaite approximation of the degrees of freedom. */
function welchSatterthwaiteDf(varB: number, nB: number, varC: number, nC: number): number {
  const a = varB / nB;
  const b = varC / nC;
  const denominator = a ** 2 / (nB - 1) + b ** 2 / (nC - 1);
  if (denominator === 0) return nB + nC - 2;
  return (a + b) ** 2 / denominator;
}

/** Bucket |d| using Cohen's conventions. */
export function classifyEffect(effectSize: number): EffectMagnitude {
  const magnitude = Math.abs(effectSize);
  for (const { min, magnitude: label } of EFFECT_THRESHOLDS) {
    if (magnitude >= min) return label;
  }
  return "negligible";
}

/**
 * Two-sided p-value for a t statistic.
 *
 * Derived from the Student's t CDF, which for t > 0 is
 * `1 - ½·I_x(ν/2, ½)` with `x = ν/(ν + t²)`. Doubling the upper tail
 * cancels the half, so the two-sided p-value is the regularized incomplete
 * beta function evaluated directly.
 */
export function twoSidedPValue(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

// ---------------------------------------------------------------------------
// Special functions
//
// Hand-rolled rather than pulled from a dependency: these are the only two
// pieces of numerical machinery AXIS needs, and the alternative is a transitive
// dependency in a CLI that currently ships five.
// ---------------------------------------------------------------------------

/** Lanczos approximation coefficients (g=7, n=9). */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function, via the Lanczos approximation. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection, so the approximation is only ever used above 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) {
    series += LANCZOS[i] / (z + i);
  }
  const t = z + LANCZOS.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Iteration caps for the continued fraction. */
const BETACF_MAX_ITERATIONS = 200;
const BETACF_EPSILON = 3e-12;
/** Guards against underflow to exactly zero mid-recurrence. */
const BETACF_TINY = 1e-30;

/**
 * Continued fraction for the incomplete beta function, by the modified Lentz
 * method. Converges quickly for `x < (a+1)/(a+b+2)`; the caller uses the
 * symmetry relation outside that range.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
  d = 1 / d;
  let result = d;

  for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < BETACF_TINY) c = BETACF_TINY;
    d = 1 / d;
    result *= d * c;

    // Odd step.
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < BETACF_TINY) c = BETACF_TINY;
    d = 1 / d;
    const step = d * c;
    result *= step;

    if (Math.abs(step - 1) < BETACF_EPSILON) break;
  }

  return result;
}

/** Regularized incomplete beta function `I_x(a, b)`. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));

  // The continued fraction only converges well on one side of this pivot, so
  // reflect to the other series when needed.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}
