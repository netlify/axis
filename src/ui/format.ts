import type { RunOutput, RunResult, RunSummary } from "../types/output.js";
import { isScoredResult } from "../types/output.js";
import type { CategoryScore, InteractionAudit, ScoreResult, ScoredOutput, ScoredRunResult } from "../types/scoring.js";
import type { ReportManifest } from "../types/report.js";
import type { Baseline, BaselineComparison } from "../types/baseline.js";

// --- Layout constants ---
const COL_SCENARIO = 22;
const COL_SCENARIO_SCORED = 22;
const COL_AGENT = 25;
const COL_STATUS = 10;
const COL_DURATION = 10;
const COL_SCORE = 7;
const SEP_SUMMARY = 72;
const SEP_SCORED = 102;
const SEP_REPORT = 100;
const SEP_DETAIL = 50;
const RESULT_TRUNCATE_SHORT = 200;
const RESULT_TRUNCATE_LONG = 500;

// --- Variant display helpers ---

/** Strip @variant suffix to get the base scenario key. */
export function getBaseKey(scenarioKey: string): string {
  const idx = scenarioKey.indexOf("@");
  return idx === -1 ? scenarioKey : scenarioKey.slice(0, idx);
}

/** Extract variant name from a scenarioKey, or null if none. */
export function getVariantName(scenarioKey: string): string | null {
  const idx = scenarioKey.indexOf("@");
  return idx === -1 ? null : scenarioKey.slice(idx + 1);
}

/** Build display agent name: "claude-code @variant" or plain "claude-code". */
function displayAgent(scenarioKey: string, agentName: string): string {
  const variant = getVariantName(scenarioKey);
  return variant ? `${agentName} @${variant}` : agentName;
}

/** Threshold for high/medium criterion scores (out of 10). */
const CRITERION_HIGH = 8;
const CRITERION_MEDIUM = 4;

export const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  setup: "◌",
  starting: "◔",
  running: "●",
  teardown: "◌",
  done: "✓",
  failed: "✗",
  scoring: "◐",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "pending",
  setup: "setup",
  starting: "starting",
  running: "running",
  teardown: "teardown",
  done: "done",
  failed: "failed",
  scoring: "scoring",
};

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Build a conditional summary footer: "X completed, Y failed, Z skipped (N total)" */
export function formatSummaryFooter(summary: RunSummary): string {
  const parts = [`${summary.completed} completed`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  return `${parts.join(", ")} (${summary.total} total)`;
}

/** Common error patterns mapped to friendly one-line messages. */
const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /quota.{0,30}exceed|exhausted.{0,20}quota|free.tier.request/i,
    message: "API quota exceeded — wait or upgrade your plan",
  },
  { pattern: /rate.limit|too many requests|429/i, message: "Rate limited — wait and retry" },
  {
    pattern: /invalid.{0,10}(api.?key|token)|unauthorized|401|authentication.fail/i,
    message: "Authentication failed — check your API key",
  },
  { pattern: /permission.denied|forbidden|403/i, message: "Permission denied — check API key permissions" },
  { pattern: /timed?\s*out/i, message: "Agent timed out" },
  { pattern: /ECONNREFUSED|ENOTFOUND|network|connection.refused/i, message: "Network error — check your connection" },
  { pattern: /not found on PATH|ENOENT.*spawn/i, message: "CLI tool not found — check installation" },
];

/**
 * Simplify a raw error string into a short, actionable message.
 * Returns the original string (truncated) if no known pattern matches.
 */
export function friendlyError(raw: string, maxLen = 80): string {
  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(raw)) return message;
  }
  // Fallback: return first line, truncated
  const firstLine = raw.split("\n")[0].trim();
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + "…" : firstLine;
}

// --- Score insight helpers ---

/** Threshold below which a category score triggers an insight line. */
const INSIGHT_THRESHOLD = 75;

const DIMENSION_KEYS = ["success", "speed", "weight", "relevance", "necessity"] as const;

/**
 * Build a short insight string identifying the weakest dimension for each
 * category that scored below the threshold. Returns null if all categories are fine.
 */
export function buildScoreInsight(score: ScoreResult): string | null {
  const parts: string[] = [];

  const categories: Array<{ label: string; cat: CategoryScore }> = [
    { label: "Env", cat: score.environment },
    { label: "Svc", cat: score.service },
    { label: "Agent", cat: score.agent },
  ];

  for (const { label, cat } of categories) {
    if (cat.score >= INSIGHT_THRESHOLD) continue;

    let weakestDim: (typeof DIMENSION_KEYS)[number] = DIMENSION_KEYS[0];
    let weakestVal = cat.dimensions[weakestDim];
    for (const dim of DIMENSION_KEYS) {
      if (cat.dimensions[dim] < weakestVal) {
        weakestDim = dim;
        weakestVal = cat.dimensions[dim];
      }
    }

    parts.push(`${label}: ${weakestDim} ${weakestVal}`);
  }

  if (parts.length === 0) return null;
  return parts.join("  |  ");
}

/**
 * Find the non-default audit with the lowest composite score.
 * Returns a truncated rationale string, or null if no non-default audits exist.
 */
function findWeakestAuditRationale(audits: InteractionAudit[]): string | null {
  let weakest: InteractionAudit | null = null;
  let weakestComposite = Infinity;

  for (const audit of audits) {
    if (audit.rationale === "default") continue;
    const composite = (audit.success + audit.speed + audit.weight + audit.contextRelevance) / 4;
    if (composite < weakestComposite) {
      weakestComposite = composite;
      weakest = audit;
    }
  }

  if (!weakest) return null;

  const rationale = weakest.rationale.length > 100 ? weakest.rationale.slice(0, 97) + "..." : weakest.rationale;
  return `#${weakest.id} ${rationale}`;
}

export function renderFinalOutput(output: RunOutput, verbose: boolean, agentCount?: number): string {
  if (output.results.length === 0) {
    return "\n  No scenarios matched.\n\n";
  }

  const agents = agentCount ?? new Set(output.results.map((r) => r.agentName)).size;
  const scenarios = new Set(output.results.map((r) => getBaseKey(r.scenarioKey))).size;

  let out = "\n";
  out += `  AXIS — ${scenarios} scenario${scenarios !== 1 ? "s" : ""} for ${agents} agent${agents !== 1 ? "s" : ""}\n`;

  if (verbose) {
    for (const result of output.results) {
      out += renderResultDetail(result);
    }
  }

  out += renderSummaryTable(output);
  return out;
}

export function renderSummaryTable(output: RunOutput): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_SUMMARY);

  lines.push(`  ${sep}`);
  lines.push(
    `  ${"Scenario".padEnd(COL_SCENARIO)} ${"Agent".padEnd(COL_AGENT)} ${"Status".padEnd(COL_STATUS)} ${"Duration".padEnd(COL_DURATION)} Cost`,
  );
  lines.push(`  ${sep}`);

  let totalCost = 0;
  for (const result of output.results) {
    const meta = result.output.metadata;
    const failed = meta.exitCode !== 0 || !!meta.error;
    const status = failed ? "✗ fail" : "✓ pass";
    const cost = meta.totalCostUsd ?? 0;
    totalCost += cost;

    lines.push(
      `  ${getBaseKey(result.scenarioKey).padEnd(COL_SCENARIO)} ${displayAgent(result.scenarioKey, result.agentName).padEnd(COL_AGENT)} ${status.padEnd(COL_STATUS)} ${formatDuration(meta.durationMs).padEnd(COL_DURATION)} ${cost > 0 ? "$" + cost.toFixed(4) : "—"}`,
    );

    if (meta.error) {
      lines.push(`    ↳ ${friendlyError(meta.error)}`);
    }
  }

  lines.push(`  ${sep}`);
  lines.push(
    `  ${formatSummaryFooter(output.summary)}`.padEnd(56) +
      `${formatDuration(output.durationMs).padEnd(COL_DURATION)} ${totalCost > 0 ? "$" + totalCost.toFixed(4) : ""}`,
  );
  lines.push("");

  return lines.join("\n") + "\n";
}

export function renderResultDetail(result: RunResult): string {
  const meta = result.output.metadata;
  const lines: string[] = [];

  lines.push(`  AXIS Run: ${result.scenarioName} [${result.scenarioKey}]`);
  lines.push(`  Agent: ${result.agentName}`);
  lines.push(`  ${"─".repeat(40)}`);
  const detailFailed = meta.exitCode !== 0 || !!meta.error;
  lines.push(`  Status:     ${detailFailed ? `Failed (exit ${meta.exitCode})` : "Complete"}`);
  if (meta.error) {
    lines.push(`  Error:      ${friendlyError(meta.error)}`);
  }
  lines.push(`  Duration:   ${formatDuration(meta.durationMs)}`);

  if (meta.tokenUsage) {
    lines.push(
      `  Tokens:     ${meta.tokenUsage.input.toLocaleString()} in / ${meta.tokenUsage.output.toLocaleString()} out`,
    );
  }

  if (meta.totalCostUsd !== undefined) {
    lines.push(`  Cost:       $${meta.totalCostUsd.toFixed(4)}`);
  }

  lines.push(`  Steps:      ${result.output.transcript.length} transcript entries`);

  if (result.output.result != null) {
    const text = String(result.output.result);
    const truncated = text.length > RESULT_TRUNCATE_SHORT ? text.slice(0, RESULT_TRUNCATE_SHORT) + "..." : text;
    lines.push(`\n  Result:\n    ${truncated.replace(/\n/g, "\n    ")}`);
  }

  lines.push("");

  return lines.join("\n") + "\n";
}

// --- Scored output rendering ---

export function renderScoredOutput(output: ScoredOutput, verbose: boolean, agentCount?: number): string {
  if (output.results.length === 0) {
    return "\n  No scenarios matched.\n\n";
  }

  const agents = agentCount ?? new Set(output.results.map((r) => r.agentName)).size;
  const scenarios = new Set(output.results.map((r) => getBaseKey(r.scenarioKey))).size;

  let out = "\n";
  out += `  AXIS — ${scenarios} scenario${scenarios !== 1 ? "s" : ""} for ${agents} agent${agents !== 1 ? "s" : ""}\n`;

  for (const result of output.results) {
    out += renderScoredResult(result, verbose);
  }

  out += renderScoredSummaryTable(output);
  return out;
}

function renderScoredResult(result: ScoredRunResult, verbose: boolean): string {
  const { score } = result;
  const sep = "─".repeat(SEP_DETAIL);
  const lines: string[] = [];

  lines.push("");
  lines.push(`  AXIS Report: ${result.scenarioName}`);
  lines.push(`  ${sep}`);
  lines.push("");
  lines.push(`  AXIS Result         ${score.axisScore} / 100`);
  if (score.judging) {
    const judgeLabel = score.judging.model ? `${score.judging.agent}|${score.judging.model}` : score.judging.agent;
    lines.push(`  Agent used for judging:           ${judgeLabel}`);
  }
  lines.push("");

  // Goal Achievement
  lines.push(`  Goal Achievement    ${score.goalAchievement.score} / 100`);
  for (const c of score.goalAchievement.criteria) {
    const icon = c.score >= CRITERION_HIGH ? "\u2714" : c.score >= CRITERION_MEDIUM ? "\u25D0" : "\u2717";
    const label = c.check.length > 38 ? c.check.slice(0, 35) + "..." : c.check;
    lines.push(`    ${icon} ${label.padEnd(40)} (${c.score}/10)`);
  }
  lines.push("");

  // Environment
  lines.push(`  Environment         ${score.environment.score} / 100`);
  lines.push(
    `    ${score.environment.interactionCount} interactions  |  ` + `${score.environment.auditedCount} audited`,
  );
  if (verbose) {
    const d = score.environment.dimensions;
    lines.push(
      `    Success: ${d.success}  |  Speed: ${d.speed}  |  Weight: ${d.weight}  |  ` +
        `Relevance: ${d.relevance}  |  Necessity: ${d.necessity}`,
    );
    const envRationale = findWeakestAuditRationale(score.environment.audits);
    if (envRationale) lines.push(`    ${envRationale}`);
  }
  lines.push("");

  // Service
  lines.push(`  Service             ${score.service.score} / 100`);
  lines.push(`    ${score.service.interactionCount} interactions  |  ` + `${score.service.auditedCount} audited`);
  if (verbose) {
    const d = score.service.dimensions;
    lines.push(
      `    Success: ${d.success}  |  Speed: ${d.speed}  |  Weight: ${d.weight}  |  ` +
        `Relevance: ${d.relevance}  |  Necessity: ${d.necessity}`,
    );
    const svcRationale = findWeakestAuditRationale(score.service.audits);
    if (svcRationale) lines.push(`    ${svcRationale}`);
  }
  lines.push("");

  // Agent
  lines.push(`  Agent               ${score.agent.score} / 100`);
  lines.push(`    ${score.agent.interactionCount} interactions  |  ` + `${score.agent.auditedCount} audited`);
  if (verbose) {
    const d = score.agent.dimensions;
    lines.push(
      `    Success: ${d.success}  |  Speed: ${d.speed}  |  Weight: ${d.weight}  |  ` +
        `Relevance: ${d.relevance}  |  Necessity: ${d.necessity}`,
    );
    const agentRationale = findWeakestAuditRationale(score.agent.audits);
    if (agentRationale) lines.push(`    ${agentRationale}`);
  }
  lines.push("");

  lines.push(`  Agent: ${result.agentName}`);

  // Verbose: show rationale per criterion
  if (verbose) {
    lines.push("");
    for (const c of score.goalAchievement.criteria) {
      lines.push(`    [${c.check}] ${c.rationale}`);
    }
  }

  lines.push("");

  return lines.join("\n") + "\n";
}

export function renderScoredSummaryTable(output: ScoredOutput): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_SCORED);

  lines.push(`  ${sep}`);
  lines.push(
    `  ${"Scenario".padEnd(COL_SCENARIO_SCORED)} ${"Agent".padEnd(COL_AGENT)} ` +
      `${"AXIS".padEnd(COL_SCORE)} ${"Goal".padEnd(COL_SCORE)} ${"Env.".padEnd(COL_SCORE)} ` +
      `${"Svc.".padEnd(COL_SCORE)} ${"Agent".padEnd(COL_SCORE)} ${"Duration".padEnd(COL_DURATION)} Cost`,
  );
  lines.push(`  ${sep}`);

  let totalCost = 0;
  for (const result of output.results) {
    const meta = result.output.metadata;
    const cost = meta.totalCostUsd ?? 0;
    totalCost += cost;

    lines.push(
      `  ${getBaseKey(result.scenarioKey).padEnd(COL_SCENARIO_SCORED)} ${displayAgent(result.scenarioKey, result.agentName).padEnd(COL_AGENT)} ` +
        `${String(result.score.axisScore).padEnd(COL_SCORE)} ` +
        `${String(result.score.goalAchievement.score).padEnd(COL_SCORE)} ` +
        `${String(result.score.environment.score).padEnd(COL_SCORE)} ` +
        `${String(result.score.service.score).padEnd(COL_SCORE)} ` +
        `${String(result.score.agent.score).padEnd(COL_SCORE)} ` +
        `${formatDuration(meta.durationMs).padEnd(COL_DURATION)} ` +
        `${cost > 0 ? "$" + cost.toFixed(4) : "\u2014"}`,
    );

    if (meta.error) {
      lines.push(`    ↳ ${friendlyError(meta.error)}`);
    } else {
      const insight = buildScoreInsight(result.score);
      if (insight) {
        lines.push(`    \u21B3 ${insight}`);
      }
    }
  }

  lines.push(`  ${sep}`);
  lines.push(
    `  Average AXIS Result: ${output.summary.averageAxisScore} / 100`.padEnd(82) +
      `${formatDuration(output.durationMs).padEnd(COL_DURATION)} ` +
      `${totalCost > 0 ? "$" + totalCost.toFixed(4) : ""}`,
  );
  if (output.summary.skipped) {
    lines.push(`  ${output.summary.skipped} marked to be skipped`);
  }
  lines.push("");

  return lines.join("\n") + "\n";
}

// --- Report listing and detail rendering ---

export function renderReportList(reports: ReportManifest[]): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_REPORT);

  lines.push("");
  lines.push(`  AXIS Reports`);
  lines.push(`  ${sep}`);
  lines.push(
    `  ${"Report ID".padEnd(22)} ${"Scenarios".padEnd(12)} ` +
      `${"AXIS".padEnd(COL_SCORE)} ${"Pass".padEnd(COL_SCORE)} ${"Fail".padEnd(COL_SCORE)} ` +
      `${"Duration".padEnd(COL_DURATION)} Cost`,
  );
  lines.push(`  ${sep}`);

  for (const report of reports) {
    const avg =
      "averageAxisScore" in report.summary
        ? String((report.summary as { averageAxisScore: number }).averageAxisScore)
        : "\u2014";
    const totalCost = report.results.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

    lines.push(
      `  ${report.reportId.padEnd(22)} ${String(report.summary.total).padEnd(12)} ` +
        `${avg.padEnd(COL_SCORE)} ${String(report.summary.completed).padEnd(COL_SCORE)} ` +
        `${String(report.summary.failed).padEnd(COL_SCORE)} ` +
        `${formatDuration(report.durationMs).padEnd(COL_DURATION)} ` +
        `${totalCost > 0 ? "$" + totalCost.toFixed(4) : "\u2014"}`,
    );
  }

  lines.push(`  ${sep}`);
  lines.push("");

  return lines.join("\n") + "\n";
}

export function renderReportDetail(report: ReportManifest): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_REPORT);
  const hasScores = report.results.some((r) => r.score !== undefined);

  lines.push("");
  lines.push(`  AXIS Report: ${report.reportId}`);
  lines.push(`  ${sep}`);
  lines.push(`  Timestamp:  ${report.timestamp}`);
  lines.push(`  Duration:   ${formatDuration(report.durationMs)}`);
  lines.push(`  Scenarios:  ${formatSummaryFooter(report.summary)}`);

  if ("averageAxisScore" in report.summary) {
    lines.push(`  AXIS Result: ${(report.summary as { averageAxisScore: number }).averageAxisScore} / 100 (average)`);
  }

  lines.push("");

  if (hasScores) {
    lines.push(
      `  ${"Scenario".padEnd(COL_SCENARIO_SCORED)} ${"Agent".padEnd(COL_AGENT)} ` +
        `${"AXIS".padEnd(COL_SCORE)} ${"Goal".padEnd(COL_SCORE)} ${"Env.".padEnd(COL_SCORE)} ` +
        `${"Svc.".padEnd(COL_SCORE)} ${"Agent".padEnd(COL_SCORE)} ${"Duration".padEnd(COL_DURATION)} Cost`,
    );
    lines.push(`  ${sep}`);

    for (const r of report.results) {
      const s = r.score;
      const cost = r.totalCostUsd ?? 0;
      lines.push(
        `  ${getBaseKey(r.scenarioKey).padEnd(COL_SCENARIO_SCORED)} ${displayAgent(r.scenarioKey, r.agentName).padEnd(COL_AGENT)} ` +
          `${s ? String(s.axisScore).padEnd(COL_SCORE) : "\u2014".padEnd(COL_SCORE)} ` +
          `${s ? String(s.goalAchievement.score).padEnd(COL_SCORE) : "\u2014".padEnd(COL_SCORE)} ` +
          `${s ? String(s.environment.score).padEnd(COL_SCORE) : "\u2014".padEnd(COL_SCORE)} ` +
          `${s ? String(s.service.score).padEnd(COL_SCORE) : "\u2014".padEnd(COL_SCORE)} ` +
          `${s ? String(s.agent.score).padEnd(COL_SCORE) : "\u2014".padEnd(COL_SCORE)} ` +
          `${formatDuration(r.durationMs).padEnd(COL_DURATION)} ` +
          `${cost > 0 ? "$" + cost.toFixed(4) : "\u2014"}`,
      );
      if (r.error) {
        lines.push(`    ↳ ${friendlyError(r.error)}`);
      } else if (s) {
        const insight = buildScoreInsight(s);
        if (insight) {
          lines.push(`    \u21B3 ${insight}`);
        }
      }
    }
  } else {
    lines.push(
      `  ${"Scenario".padEnd(COL_SCENARIO)} ${"Agent".padEnd(COL_AGENT)} ${"Status".padEnd(COL_STATUS)} ${"Duration".padEnd(COL_DURATION)} Cost`,
    );
    lines.push(`  ${sep}`);

    for (const r of report.results) {
      const status = r.exitCode !== 0 || r.error ? "\u2717 fail" : "\u2713 pass";
      const cost = r.totalCostUsd ?? 0;
      lines.push(
        `  ${getBaseKey(r.scenarioKey).padEnd(COL_SCENARIO)} ${displayAgent(r.scenarioKey, r.agentName).padEnd(COL_AGENT)} ` +
          `${status.padEnd(COL_STATUS)} ${formatDuration(r.durationMs).padEnd(COL_DURATION)} ` +
          `${cost > 0 ? "$" + cost.toFixed(4) : "\u2014"}`,
      );
      if (r.error) {
        lines.push(`    ↳ ${friendlyError(r.error)}`);
      }
    }
  }

  lines.push(`  ${sep}`);
  lines.push("");
  lines.push(`  View scenario detail: axis reports ${report.reportId} <scenarioKey>`);
  lines.push("");

  return lines.join("\n") + "\n";
}

export function renderScenarioDetail(result: RunResult | ScoredRunResult): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_DETAIL);

  lines.push("");

  // If scored, render the full scored report
  if (isScoredResult(result)) {
    return renderScoredResult(result, true);
  }

  // Unscored: basic result detail
  lines.push(`  AXIS Result: ${result.scenarioName} [${result.scenarioKey}]`);
  lines.push(`  ${sep}`);
  lines.push(`  Agent:    ${result.agentName}`);
  const scenarioFailed = result.output.metadata.exitCode !== 0 || !!result.output.metadata.error;
  lines.push(`  Status:   ${scenarioFailed ? `Failed (exit ${result.output.metadata.exitCode})` : "Complete"}`);
  if (result.output.metadata.error) {
    lines.push(`  Error:    ${friendlyError(result.output.metadata.error)}`);
  }
  lines.push(`  Duration: ${formatDuration(result.output.metadata.durationMs)}`);
  lines.push(`  Steps:    ${result.output.transcript.length} transcript entries`);

  if (result.output.metadata.tokenUsage) {
    const t = result.output.metadata.tokenUsage;
    lines.push(`  Tokens:   ${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out`);
  }

  if (result.output.result != null) {
    const text = String(result.output.result);
    const truncated = text.length > RESULT_TRUNCATE_LONG ? text.slice(0, RESULT_TRUNCATE_LONG) + "..." : text;
    lines.push("");
    lines.push(`  Result:`);
    lines.push(`    ${truncated.replace(/\n/g, "\n    ")}`);
  }

  lines.push("");

  return lines.join("\n") + "\n";
}

// --- Baseline rendering ---

const SEP_BASELINE = 100;
const COL_BASELINE_SCENARIO = 22;
const COL_BASELINE_AGENT = 25;
const COL_BASELINE_SCORE = 10;

export function renderBaselineList(baselines: Baseline[]): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_BASELINE);

  lines.push("");
  lines.push(`  AXIS Baselines`);
  lines.push(`  ${sep}`);
  lines.push(`  ${"Name".padEnd(20)} ${"Updated".padEnd(22)} ${"Scenarios".padEnd(12)} Agents`);
  lines.push(`  ${sep}`);

  for (const b of baselines) {
    const scenarioCount = Object.keys(b.results).length;
    const agentSet = new Set<string>();
    for (const agents of Object.values(b.results)) {
      for (const _agent of Object.keys(agents)) {
        agentSet.add(_agent);
      }
    }

    lines.push(
      `  ${b.name.padEnd(20)} ${b.updatedAt.slice(0, 19).replace("T", " ").padEnd(22)} ${String(scenarioCount).padEnd(12)} ${agentSet.size}`,
    );
  }

  lines.push(`  ${sep}`);
  lines.push("");

  return lines.join("\n") + "\n";
}

export function renderBaselineShow(baseline: Baseline): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_BASELINE);

  lines.push("");
  lines.push(`  Baseline: ${baseline.name}`);
  lines.push(`  Created:  ${baseline.createdAt}`);
  lines.push(`  Updated:  ${baseline.updatedAt}`);
  lines.push("");
  lines.push(`  ${sep}`);
  lines.push(
    `  ${"Scenario".padEnd(COL_BASELINE_SCENARIO)} ${"Agent".padEnd(COL_BASELINE_AGENT)} ` +
      `${"AXIS".padEnd(COL_SCORE)} ${"Goal".padEnd(COL_SCORE)} ${"Env.".padEnd(COL_SCORE)} ` +
      `${"Svc.".padEnd(COL_SCORE)} ${"Agent".padEnd(COL_SCORE)} ${"Duration".padEnd(COL_DURATION)} Report`,
  );
  lines.push(`  ${sep}`);

  for (const [scenarioKey, agents] of Object.entries(baseline.results)) {
    for (const [agentName, entry] of Object.entries(agents)) {
      lines.push(
        `  ${getBaseKey(scenarioKey).padEnd(COL_BASELINE_SCENARIO)} ${displayAgent(scenarioKey, agentName).padEnd(COL_BASELINE_AGENT)} ` +
          `${String(entry.axisScore).padEnd(COL_SCORE)} ` +
          `${String(entry.goalAchievement).padEnd(COL_SCORE)} ` +
          `${String(entry.environment).padEnd(COL_SCORE)} ` +
          `${String(entry.service).padEnd(COL_SCORE)} ` +
          `${String(entry.agent).padEnd(COL_SCORE)} ` +
          `${formatDuration(entry.durationMs).padEnd(COL_DURATION)} ` +
          entry.fromReportId,
      );
    }
  }

  lines.push(`  ${sep}`);
  lines.push("");

  return lines.join("\n") + "\n";
}

function deltaIndicator(delta: number): string {
  if (Math.abs(delta) <= 1) return `${delta > 0 ? "+" : ""}${delta}`;
  if (delta > 0) return `+${delta} ▲`;
  return `${delta} ▼`;
}

export function renderBaselineComparison(diff: BaselineComparison): string {
  const lines: string[] = [];
  const sep = "─".repeat(SEP_BASELINE);

  lines.push("");
  lines.push(`  Baseline: ${diff.baselineName}`);
  lines.push("");
  lines.push(`  ${sep}`);
  lines.push(
    `  ${"Scenario".padEnd(COL_BASELINE_SCENARIO)} ${"Agent".padEnd(COL_BASELINE_AGENT)} ` +
      `${"Baseline".padEnd(COL_BASELINE_SCORE)} ${"Current".padEnd(COL_BASELINE_SCORE)} Delta`,
  );
  lines.push(`  ${sep}`);

  for (const entry of diff.entries) {
    lines.push(
      `  ${getBaseKey(entry.scenarioKey).padEnd(COL_BASELINE_SCENARIO)} ${displayAgent(entry.scenarioKey, entry.agentName).padEnd(COL_BASELINE_AGENT)} ` +
        `${String(entry.baseline).padEnd(COL_BASELINE_SCORE)} ` +
        `${String(entry.current).padEnd(COL_BASELINE_SCORE)} ` +
        deltaIndicator(entry.delta),
    );
  }

  lines.push(`  ${sep}`);
  lines.push(
    `  ${diff.summary.improved} improved, ${diff.summary.regressed} regressed, ${diff.summary.unchanged} unchanged`,
  );

  if (diff.summary.newScenarios > 0) {
    lines.push(`  New (not in baseline): ${diff.summary.newScenarios}`);
  }

  lines.push("");

  return lines.join("\n") + "\n";
}
