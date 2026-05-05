import type {
  ReportData,
  ResultEntry,
  ScoreResult,
  CategoryScore,
  GoalAchievementScore,
  CriterionGrade,
  InteractionAudit,
  SparseIndex,
  Interaction,
  RubricCriterion,
} from "./types";
import { isScoredSummary } from "./types";

// --- Utilities ---

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined || usd <= 0) return "\u2014";
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(usage: { input: number; output: number; cacheReadInput?: number } | undefined): string {
  if (!usage) return "\u2014";
  const total = usage.input + usage.output + (usage.cacheReadInput ?? 0);
  if (total === 0) return "\u2014";
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return total.toLocaleString();
}

function fmtTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function scoreColorClass(score: number): string {
  if (score >= 90) return "score-green";
  if (score >= 80) return "score-yellow";
  if (score >= 70) return "score-orange";
  return "score-red";
}

function fillColorClass(score: number): string {
  if (score >= 90) return "fill-green";
  if (score >= 80) return "fill-yellow";
  if (score >= 70) return "fill-orange";
  return "fill-red";
}

// --- Variant helpers ---

function getBaseKey(scenarioKey: string): string {
  const idx = scenarioKey.indexOf("@");
  return idx === -1 ? scenarioKey : scenarioKey.slice(0, idx);
}

function getVariantName(scenarioKey: string): string | null {
  const idx = scenarioKey.indexOf("@");
  return idx === -1 ? null : scenarioKey.slice(idx + 1);
}

function getBaseScenarioName(scenarioName: string): string {
  return scenarioName.replace(/ \[[^\]]+\]$/, "");
}

function displayAgentName(entry: ResultEntry): string {
  const variant = getVariantName(entry.scenarioKey);
  return variant ? `${entry.agentName} @${variant}` : entry.agentName;
}

// --- Scenario Grouping ---

interface ScenarioGroup {
  scenarioKey: string;
  scenarioName: string;
  entries: ResultEntry[];
  prompt?: string;
  rubric?: string | RubricCriterion[];
}

function groupByScenario(results: ResultEntry[]): ScenarioGroup[] {
  const map = new Map<string, ScenarioGroup>();
  for (const entry of results) {
    const baseKey = getBaseKey(entry.scenarioKey);
    let group = map.get(baseKey);
    if (!group) {
      group = {
        scenarioKey: baseKey,
        scenarioName: getBaseScenarioName(entry.scenarioName),
        entries: [],
        prompt: entry.prompt,
        rubric: entry.rubric,
      };
      map.set(baseKey, group);
    }
    group.entries.push(entry);
  }
  // Stable ordering for predictable diffs across reports:
  // scenarios alphabetical by base key; entries by agent name then variant name.
  const groups = Array.from(map.values());
  for (const group of groups) {
    group.entries.sort((a, b) => {
      const agentCmp = a.agentName.localeCompare(b.agentName);
      if (agentCmp !== 0) return agentCmp;
      const va = getVariantName(a.scenarioKey) ?? "";
      const vb = getVariantName(b.scenarioKey) ?? "";
      return va.localeCompare(vb);
    });
  }
  groups.sort((a, b) => a.scenarioKey.localeCompare(b.scenarioKey));
  return groups;
}

// --- Components ---

function scoreBadge(score: number | undefined, large = false): string {
  if (score === undefined) {
    return `<span class="score-badge score-na${large ? " score-badge-lg" : ""}">\u2014</span>`;
  }
  const cls = scoreColorClass(score);
  return `<span class="score-badge ${cls}${large ? " score-badge-lg" : ""}">${score}</span>`;
}

function progressBar(value: number, max = 100): string {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const cls = fillColorClass(pct);
  return `<div class="progress-bar"><div class="fill ${cls}" style="width: ${pct}%"></div></div>`;
}

function dimensionItem(label: string, value: number): string {
  return `
    <div class="dimension-item">
      <span class="dimension-label">${escapeHtml(label)}</span>
      ${progressBar(value)}
      <span class="dimension-value">${value}</span>
    </div>`;
}

// --- Main Render ---

export function renderReport(report: ReportData): string {
  return `
    <div class="container">
      ${renderHeader(report)}
      ${renderResultsSection(report)}
    </div>
    ${renderModals(report.results)}`;
}

// --- Header ---

function renderHeader(report: ReportData): string {
  const scored = isScoredSummary(report.summary);
  const totalCost = report.results.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

  return `
    <header class="report-header">
      <div class="header-left">
        <div class="report-branding">
          <span class="site-logo-mark"><span class="logo-ax">AX</span><span class="logo-i">I</span>S</span>
          <span class="report-badge">Report</span>
        </div>
        <div class="report-meta">
          ${report.name ? `<div class="report-meta-row"><span class="report-meta-label">Report name:</span> <span class="report-meta-value">${escapeHtml(report.name)}</span></div>` : ""}
          <div class="report-meta-row"><span class="report-meta-label">Generated on:</span> <span class="report-meta-value">${fmtTimestamp(report.timestamp)}</span></div>
          <div class="report-meta-row"><span class="report-meta-label">Total duration:</span> <span class="report-meta-value">${fmtDuration(report.durationMs)}</span></div>
          <div class="report-meta-row"><span class="report-meta-label">Report ID:</span> <span class="report-meta-value report-meta-id">${escapeHtml(report.reportId)}</span></div>
        </div>
      </div>
      <div class="summary-card">
        ${
          scored
            ? `
        <div class="summary-hero">
          <div class="hero-score">${report.summary.averageAxisScore}</div>
          <div class="hero-label">AXIS Result</div>
        </div>
        <div class="summary-divider"></div>`
            : ""
        }
        <div class="summary-stats">
          <div class="summary-stat">
            <div class="stat-value">${report.summary.total}</div>
            <div class="stat-label">Scenarios</div>
          </div>
          <div class="summary-stat stat-passed">
            <div class="stat-value">${report.summary.completed}</div>
            <div class="stat-label">Passed</div>
          </div>
          ${
            report.summary.failed > 0
              ? `<div class="summary-stat stat-failed">
            <div class="stat-value">${report.summary.failed}</div>
            <div class="stat-label">Failed</div>
          </div>`
              : ""
          }
          ${
            report.summary.skipped
              ? `<div class="summary-stat stat-skipped">
            <div class="stat-value">${report.summary.skipped}</div>
            <div class="stat-label">Skipped</div>
          </div>`
              : ""
          }
          ${
            totalCost > 0
              ? `
          <div class="summary-stat">
            <div class="stat-value">${fmtCost(totalCost)}</div>
            <div class="stat-label">Cost</div>
          </div>`
              : ""
          }
        </div>
      </div>
    </header>`;
}

// --- Results Table ---

function renderResultsSection(report: ReportData): string {
  if (report.results.length === 0) {
    return `<div class="empty-state">No results in this report.</div>`;
  }

  const hasScores = report.results.some((r) => r.score !== undefined);
  const groups = groupByScenario(report.results);

  let globalIndex = 0;
  const groupRows = groups
    .map((group) => {
      const startIndex = globalIndex;
      globalIndex += group.entries.length;
      return renderScenarioGroup(group, startIndex, hasScores);
    })
    .join("");

  return `
    <section class="results-section">
      <table class="results-table">
        <thead>
          <tr>
            <th></th>
            <th>Scenario / Agent</th>
            ${
              hasScores
                ? `
            <th class="col-score">AXIS</th>
            <th class="col-score hide-mobile">Goal</th>
            <th class="col-score hide-mobile">Env</th>
            <th class="col-score hide-mobile">Svc</th>
            <th class="col-score hide-mobile">Agent</th>`
                : `
            <th class="col-score">Status</th>`
            }
            <th class="col-right hide-mobile">Tokens</th>
            <th class="col-right hide-mobile">Duration</th>
            <th class="col-right hide-mobile">Cost</th>
          </tr>
        </thead>
        <tbody>${groupRows}</tbody>
      </table>
    </section>`;
}

function renderScenarioGroup(group: ScenarioGroup, startIndex: number, hasScores: boolean): string {
  const header = renderScenarioHeaderRow(group, startIndex, hasScores);
  const agentRows = group.entries
    .map((entry, i) => {
      const globalIndex = startIndex + i;
      return renderAgentRow(entry, globalIndex, hasScores, group.scenarioKey) +
        renderDetailRow(entry, globalIndex, group.scenarioKey);
    })
    .join("");
  return header + agentRows;
}

function renderScenarioHeaderRow(group: ScenarioGroup, startIndex: number, hasScores: boolean): string {
  const infoBtn = group.prompt
    ? `<button class="info-btn" data-modal-index="${startIndex}" title="View scenario settings">\u2139</button>`
    : "";

  if (hasScores) {
    return `
      <tr class="scenario-header-row expanded" data-scenario="${escapeHtml(group.scenarioKey)}">
        <td><span class="expand-icon">\u25B6</span></td>
        <td class="col-scenario-header">${escapeHtml(group.scenarioName)}${infoBtn}</td>
        <td class="col-score"></td>
        <td class="col-score hide-mobile"></td>
        <td class="col-score hide-mobile"></td>
        <td class="col-score hide-mobile"></td>
        <td class="col-score hide-mobile"></td>
        <td class="col-right hide-mobile"></td>
        <td class="col-right hide-mobile"></td>
        <td class="col-right hide-mobile"></td>
      </tr>`;
  }

  return `
    <tr class="scenario-header-row expanded" data-scenario="${escapeHtml(group.scenarioKey)}">
      <td><span class="expand-icon">\u25B6</span></td>
      <td class="col-scenario-header">${escapeHtml(group.scenarioName)}${infoBtn}</td>
      <td class="col-score"></td>
      <td class="col-right hide-mobile"></td>
      <td class="col-right hide-mobile"></td>
      <td class="col-right hide-mobile"></td>
    </tr>`;
}

function renderAgentRow(entry: ResultEntry, index: number, hasScores: boolean, scenarioKey: string): string {
  const s = entry.score;
  const isFailed = entry.exitCode !== 0 || !!entry.error;
  const errorBtn = entry.error
    ? `<button class="error-btn" data-error-index="${index}" title="${escapeHtml(friendlyError(entry.error))}">!</button>`
    : "";

  if (hasScores) {
    return `
      <tr class="result-row agent-row" data-index="${index}" data-scenario="${escapeHtml(scenarioKey)}">
        <td class="col-expand-indent"><span class="expand-icon">\u25B6</span></td>
        <td class="col-agent">${escapeHtml(displayAgentName(entry))}${errorBtn}</td>
        <td class="col-score">${scoreBadge(s?.axisScore)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.goalAchievement.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.environment.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.service.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.agent.score)}</td>
        <td class="col-right hide-mobile">${fmtTokens(entry.tokenUsage)}</td>
        <td class="col-right hide-mobile">${fmtDuration(entry.durationMs)}</td>
        <td class="col-right hide-mobile">${fmtCost(entry.totalCostUsd)}</td>
      </tr>`;
  }

  const status = isFailed
    ? `<span class="score-badge score-red">Fail</span>`
    : `<span class="score-badge score-green">Pass</span>`;

  return `
    <tr class="result-row agent-row" data-index="${index}" data-scenario="${escapeHtml(scenarioKey)}">
      <td class="col-expand-indent"><span class="expand-icon">\u25B6</span></td>
      <td class="col-agent">${escapeHtml(entry.agentName)}${errorBtn}</td>
      <td class="col-score">${status}</td>
      <td class="col-right hide-mobile">${fmtTokens(entry.tokenUsage)}</td>
      <td class="col-right hide-mobile">${fmtDuration(entry.durationMs)}</td>
      <td class="col-right hide-mobile">${fmtCost(entry.totalCostUsd)}</td>
    </tr>`;
}

function renderDetailRow(entry: ResultEntry, index: number, scenarioKey?: string): string {
  const colspan = entry.score ? 10 : 6;
  const scenarioAttr = scenarioKey ? ` data-scenario="${escapeHtml(scenarioKey)}"` : "";
  return `
    <tr class="detail-row" id="detail-${index}"${scenarioAttr}>
      <td colspan="${colspan}">
        <div class="detail-panel">
          ${entry.error ? `<div class="error-banner">${escapeHtml(entry.error)}</div>` : ""}
          ${entry.score ? renderScoreDetail(entry.score) : renderUnscoredDetail(entry)}
        </div>
      </td>
    </tr>`;
}

function renderUnscoredDetail(entry: ResultEntry): string {
  const tokenParts: string[] = [];
  if (entry.tokenUsage) {
    tokenParts.push(`Input: ${entry.tokenUsage.input.toLocaleString()}`);
    tokenParts.push(`Output: ${entry.tokenUsage.output.toLocaleString()}`);
    if (entry.tokenUsage.cacheReadInput) {
      tokenParts.push(`Cache: ${entry.tokenUsage.cacheReadInput.toLocaleString()}`);
    }
  }

  return `
    <div class="detail-sections">
      <div class="detail-section">
        <div class="section-header"><h3>Run Details</h3></div>
        <p style="color: var(--text-secondary); font-size: 0.875rem;">
          Duration: ${fmtDuration(entry.durationMs)}
          ${tokenParts.length ? ` &middot; Tokens: ${tokenParts.join(", ")}` : ""}
          ${entry.totalCostUsd ? ` &middot; Cost: ${fmtCost(entry.totalCostUsd)}` : ""}
        </p>
      </div>
    </div>`;
}

// --- Score Detail ---

function renderScoreDetail(score: ScoreResult): string {
  return `
    <div class="score-overview">
      ${scoreBadge(score.axisScore, true)}
      <div class="category-bars">
        ${categoryBarRow("Goal Achievement", score.goalAchievement.score)}
        ${categoryBarRow("Environment", score.environment.score)}
        ${categoryBarRow("Service", score.service.score)}
        ${categoryBarRow("Agent", score.agent.score)}
      </div>
    </div>
    <div class="detail-sections">
      ${score.sparseIndex ? renderWaterfall(score.sparseIndex) : ""}
      ${renderGoalAchievement(score.goalAchievement)}
      ${renderCategoryCard("Environment", score.environment)}
      ${renderCategoryCard("Service", score.service)}
      ${renderCategoryCard("Agent", score.agent)}
      ${score.sparseIndex ? renderSparseIndex(score.sparseIndex) : ""}
    </div>`;
}

function categoryBarRow(label: string, score: number): string {
  return `
    <div class="category-bar-row">
      <span class="category-bar-label">${label}</span>
      ${progressBar(score)}
      <span class="category-bar-value">${score}</span>
    </div>`;
}

// --- Goal Achievement ---

function renderGoalAchievement(ga: GoalAchievementScore): string {
  const criteria = ga.criteria.map(renderCriterion).join("");

  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>Goal Achievement</h3>
        <span class="section-score">${ga.score} / 100</span>
      </div>
      <div class="criteria-list">${criteria}</div>
    </div>`;
}

function renderCriterion(c: CriterionGrade): string {
  const isPerfect = c.score === 10;
  // Map 0-10 to percentage for consistent icon thresholds
  const scorePct = c.score * 10;
  const icon = scorePct >= 90 ? "\u2714" : scorePct >= 80 ? "\u2714" : scorePct >= 70 ? "\u25D0" : "\u2717";
  const iconClass = scorePct >= 90 ? "high" : scorePct >= 80 ? "good" : scorePct >= 70 ? "medium" : "low";
  const pct = Math.round(c.weight * 100);
  const itemClass = isPerfect ? "criterion-item criterion-perfect" : "criterion-item criterion-imperfect";

  return `
    <div class="${itemClass}">
      <div class="criterion-top">
        <span class="criterion-icon ${iconClass}">${icon}</span>
        <span class="criterion-name">${escapeHtml(c.check)}</span>
        <span class="criterion-score">${c.score}/10</span>
        <span class="criterion-weight">${pct}%</span>
      </div>
      <div class="criterion-bar">${progressBar(c.score, 10)}</div>
      ${isPerfect ? "" : `<div class="criterion-rationale">${escapeHtml(c.rationale)}</div>`}
    </div>`;
}

// --- Category Card ---

function renderCategoryCard(label: string, cat: CategoryScore): string {
  const headerTitle = `<h3>${escapeHtml(label)}${categoryInfoButton(label)}</h3>`;

  // Zero-state: no interactions of this category occurred in the run
  if (cat.interactionCount === 0) {
    return `
      <div class="detail-section">
        <div class="section-header">
          ${headerTitle}
          <span class="section-score">${cat.score} / 100</span>
        </div>
        <div class="category-empty-state">${escapeHtml(emptyCategoryMessage(label))}</div>
      </div>`;
  }

  const d = cat.dimensions;
  const nonDefaultAudits = cat.audits.filter((a) => a.rationale !== "default");
  const hasRealAudits = nonDefaultAudits.length > 0;

  // Dimensions that actually contribute to this category's score.
  // Env/Service score = success + speed only; Agent uses all dims.
  const includeNecessity = label === "Agent";
  const includeRelevance = label === "Agent";
  const dimEntries: Array<{ label: string; value: number }> = [
    { label: "Success", value: d.success },
    { label: "Speed", value: d.speed },
    ...(includeRelevance ? [{ label: "Relevance", value: d.relevance }] : []),
    ...(includeNecessity ? [{ label: "Necessity", value: d.necessity }] : []),
  ];
  const imperfectDims = dimEntries.filter((e) => e.value < 100);
  const isPerfect = cat.score >= 100 && imperfectDims.length === 0;

  const necessityForBreakdown = includeNecessity && cat.necessity.rationale !== "default" ? cat.necessity : null;
  const breakdownBlock = hasRealAudits
    ? renderCategoryBreakdown(dimEntries, imperfectDims, nonDefaultAudits, includeRelevance, isPerfect, necessityForBreakdown)
    : "";

  return `
    <div class="detail-section">
      <div class="section-header">
        ${headerTitle}
        <span class="section-score">${cat.score} / 100</span>
      </div>
      <div class="interaction-meta">
        ${cat.interactionCount} interaction${cat.interactionCount !== 1 ? "s" : ""}
        ${hasRealAudits ? `&middot; ${cat.auditedCount} audited` : ""}
      </div>
      ${breakdownBlock}
    </div>`;
}

function categoryInfoButton(label: string): string {
  const text = categoryDescription(label);
  if (!text) return "";
  return `<button class="info-btn" data-tooltip="${escapeHtml(text)}" aria-label="What is the ${escapeHtml(label)} score?" type="button">ℹ</button>`;
}

function categoryDescription(label: string): string {
  switch (label) {
    case "Environment":
      return "Interactions with the local execution environment — filesystem reads/writes, shell commands, processes. Each call is scored on whether it succeeded and how fast it returned.";
    case "Service":
      return "Calls to external services — HTTP requests, MCP tools, third-party APIs. Each call is scored on whether it succeeded and how fast it returned.";
    case "Agent":
      return "The agent's own decisions across the run — model thinking, tool choice, and judgment. Scored on success, speed, context relevance, and whether each action was necessary.";
    default:
      return "";
  }
}

function emptyCategoryMessage(label: string): string {
  switch (label) {
    case "Environment":
      return "No environment interactions (filesystem, shell, processes) in this run.";
    case "Service":
      return "No service interactions (HTTP requests, MCP tools, external APIs) in this run.";
    case "Agent":
      return "No agent decision points captured in this run.";
    default:
      return `No ${label.toLowerCase()} interactions in this run.`;
  }
}

function renderCategoryBreakdown(
  allDims: Array<{ label: string; value: number }>,
  _imperfectDims: Array<{ label: string; value: number }>,
  audits: InteractionAudit[],
  showRelevance: boolean,
  isPerfect: boolean,
  necessity: { score: number; unnecessaryIds: number[]; rationale: string } | null,
): string {
  // Audits with at least one sub-perfect dim that contributes to the score
  const isImperfectAudit = (a: InteractionAudit): boolean =>
    a.success < 1 || a.speed < 1 || (showRelevance && a.contextRelevance < 1);
  const imperfectAudits = audits.filter(isImperfectAudit);
  const perfectAudits = audits.filter((a) => !isImperfectAudit(a));

  // Perfect category — show a compact summary and bail
  if (isPerfect) {
    return `
      <div class="dimensions-grid">${allDims.map((e) => dimensionItem(e.label, e.value)).join("")}</div>`;
  }

  const renderRow = (a: InteractionAudit) => `
    <div class="cat-deduction-item">
      <a class="cat-deduction-id interaction-link" data-interaction-id="${a.id}" title="Jump to this interaction in the transcript">Interaction #${a.id}</a>
      <span class="cat-deduction-scores">${renderAuditDimScores(a, showRelevance)}</span>
      <span class="cat-deduction-rationale">${escapeHtml(a.rationale)}</span>
    </div>`;

  const unnecessaryLinks = necessity
    ? necessity.unnecessaryIds
        .map((id) => `<a class="interaction-link" data-interaction-id="${id}" title="Jump to this interaction in the transcript">#${id}</a>`)
        .join(", ")
    : "";
  const necessityRow = necessity
    ? `<div class="cat-deduction-item necessity-row">
         <span class="cat-deduction-id">Necessity</span>
         <span class="cat-deduction-scores">${
           necessity.unnecessaryIds.length > 0
             ? `<span class="dim-score-tag">Unnecessary: ${unnecessaryLinks}</span>`
             : ""
         }</span>
         <span class="cat-deduction-rationale">${escapeHtml(necessity.rationale)}</span>
       </div>`
    : "";

  const imperfectRows = imperfectAudits.map(renderRow).join("");
  const perfectRows = perfectAudits.map(renderRow).join("");
  const showAllToggle = perfectAudits.length
    ? `
      <button class="audits-toggle">Show ${perfectAudits.length} other passing interaction${perfectAudits.length !== 1 ? "s" : ""}</button>
      <div class="audits-list">${perfectRows}</div>`
    : "";

  const hasContent = !!necessityRow || imperfectRows.length > 0 || perfectAudits.length > 0;

  return `
    <div class="dimensions-grid">${allDims.map((e) => dimensionItem(e.label, e.value)).join("")}</div>
    ${hasContent
      ? `<div class="deductions-summary">
           <div class="deductions-header">Score breakdown</div>
           ${necessityRow}
           ${imperfectRows}
           ${showAllToggle}
         </div>`
      : ""}`;
}

function renderAuditDimScores(a: InteractionAudit, showRelevance: boolean): string {
  const dims: Array<{ label: string; value: number }> = [
    { label: "Success", value: a.success },
    { label: "Speed", value: a.speed },
    ...(showRelevance ? [{ label: "Relevance", value: a.contextRelevance }] : []),
  ];
  return dims
    .filter((d) => d.value < 1)
    .map((d) => `<span class="dim-score-tag">${d.label}: ${fmt01(d.value)}</span>`)
    .join("");
}

function fmt01(v: number): string {
  return (v * 100).toFixed(0);
}

// --- Waterfall Timeline ---

interface TickMark {
  pct: number;
  label: string;
}

const WATERFALL_COLLAPSE_THRESHOLD = 30;

function renderWaterfall(si: SparseIndex): string {
  const { interactions } = si;
  const hasTimingData = interactions.some((ix) => ix.startMs !== null);
  if (!hasTimingData || interactions.length === 0) return "";

  const wallClockMs = si.stats.wallClockMs || computeWallClock(interactions);
  if (wallClockMs <= 0) return "";

  const ticks = computeTickMarks(wallClockMs);
  const shouldCollapse = interactions.length > WATERFALL_COLLAPSE_THRESHOLD;
  const visible = shouldCollapse ? interactions.slice(0, WATERFALL_COLLAPSE_THRESHOLD) : interactions;
  const overflow = shouldCollapse ? interactions.slice(WATERFALL_COLLAPSE_THRESHOLD) : [];

  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>Timeline</h3>
        <span class="section-score">${fmtDuration(wallClockMs)} &middot; ${interactions.length} interactions</span>
      </div>
      <div class="waterfall">
        <div class="waterfall-header">
          <div class="wf-label-col"></div>
          <div class="wf-timeline-col">
            <div class="wf-ticks">
              ${ticks.map((t) => `<span class="wf-tick" style="left: ${t.pct.toFixed(2)}%">${t.label}</span>`).join("")}
            </div>
          </div>
          <div class="wf-dur-col">Duration</div>
        </div>
        <div class="waterfall-body">
          ${visible.map((ix) => renderWaterfallRow(ix, wallClockMs)).join("")}
          ${shouldCollapse ? `<div class="wf-overflow" style="display:none">${overflow.map((ix) => renderWaterfallRow(ix, wallClockMs)).join("")}</div>` : ""}
        </div>
        ${shouldCollapse ? `<button class="wf-show-all">Show all ${interactions.length} interactions</button>` : ""}
        <div class="wf-legend">
          <span class="wf-legend-item"><span class="wf-legend-dot wf-env"></span>Environment</span>
          <span class="wf-legend-item"><span class="wf-legend-dot wf-svc"></span>Service</span>
          <span class="wf-legend-item"><span class="wf-legend-dot wf-agent"></span>Agent</span>
        </div>
      </div>
    </div>`;
}

function renderWaterfallRow(ix: Interaction, totalMs: number): string {
  const startMs = ix.startMs ?? 0;
  const durMs = ix.durationMs ?? 0;
  const leftPct = (startMs / totalMs) * 100;
  const widthPct = Math.max(0.4, (durMs / totalMs) * 100);
  const catClass = waterfallCatClass(ix);
  const errorClass = ix.hasError ? " wf-bar-error" : "";
  const label = ix.toolName ?? "thinking";
  const catLabel = ix.categories.includes("environment") ? "env" : ix.categories.includes("service") ? "svc" : "agent";

  const titleParts = [
    `#${ix.id} ${label} (${catLabel})`,
    ix.durationMs !== null ? `Duration: ${fmtDuration(ix.durationMs)}` : null,
    `Context: ${fmtSize(ix.contextBytes)}`,
    ix.hasError ? "ERROR" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `
    <div class="wf-row ${catClass}">
      <div class="wf-label-col">
        <span class="wf-id">#${ix.id}</span>
        <span class="wf-cat">${catLabel}</span>
        <span class="wf-tool">${escapeHtml(label)}</span>
      </div>
      <div class="wf-timeline-col">
        <div class="wf-track">
          <div class="wf-bar${errorClass}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%" title="${escapeHtml(titleParts)}"></div>
        </div>
      </div>
      <div class="wf-dur-col">${ix.durationMs !== null ? fmtDuration(ix.durationMs) : "\u2014"}</div>
    </div>`;
}

function waterfallCatClass(ix: Interaction): string {
  if (ix.categories.includes("environment")) return "wf-env";
  if (ix.categories.includes("service")) return "wf-svc";
  return "wf-agent";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function computeWallClock(interactions: Interaction[]): number {
  let maxEnd = 0;
  for (const ix of interactions) {
    if (ix.startMs !== null) {
      const end = ix.startMs + (ix.durationMs ?? 0);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd;
}

function computeTickMarks(totalMs: number): TickMark[] {
  const niceIntervals = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000];

  let bestInterval = niceIntervals[niceIntervals.length - 1];
  for (const interval of niceIntervals) {
    const count = Math.floor(totalMs / interval);
    if (count >= 3 && count <= 8) {
      bestInterval = interval;
      break;
    }
  }

  const ticks: TickMark[] = [];
  for (let t = 0; t <= totalMs; t += bestInterval) {
    ticks.push({
      pct: (t / totalMs) * 100,
      label: fmtDuration(t),
    });
  }

  if (ticks.length === 0) {
    ticks.push({ pct: 0, label: "0s" });
  }

  return ticks;
}

// --- Sparse Index ---

function renderSparseIndex(si: SparseIndex): string {
  const hasContent = si.interactions.some((ix) => ix.content);

  const lines = si.lines
    .map((line, i) => {
      const interaction = si.interactions[i];
      let catClass = "cat-agent";
      if (interaction) {
        if (interaction.categories.includes("environment")) catClass = "cat-env";
        else if (interaction.categories.includes("service")) catClass = "cat-svc";
      } else if (line.includes("  env  ")) {
        catClass = "cat-env";
      } else if (line.includes("  service  ") || line.includes("  svc  ")) {
        catClass = "cat-svc";
      }

      const expandable = interaction?.content ? " sparse-line-expandable" : "";
      const contentBlock = interaction?.content
        ? `<div class="sparse-line-content"><pre>${escapeHtml(interaction.content)}</pre></div>`
        : "";
      const idAttr = interaction ? ` data-interaction-id="${interaction.id}"` : "";

      return `<div class="sparse-line ${catClass}${expandable}"${idAttr}>${escapeHtml(line)}${contentBlock}</div>`;
    })
    .join("");

  const tooltipText =
    "A condensed, ordered log of every tool call, model response, and decision the agent made during this run, classified as Environment, Service, or Agent. Each numbered line corresponds to the Interaction #N references in the score breakdowns above.";
  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>Transcript of agent interactions<button class="info-btn" data-tooltip="${escapeHtml(tooltipText)}" aria-label="What is this?" type="button">ℹ</button></h3>
        <span class="section-score">${si.stats.totalInteractions} interactions</span>
      </div>
      <div class="sparse-index-section">
        <button class="sparse-index-toggle">Show transcript</button>
        ${hasContent ? `<button class="sparse-expand-all">Expand all</button>` : ""}
        <div class="sparse-index-content">${lines}</div>
      </div>
    </div>`;
}

// --- Modals ---

function renderModals(results: ResultEntry[]): string {
  const promptModals = results
    .map((entry, i) => {
      if (!entry.prompt) return "";
      return renderModal(entry, i);
    })
    .join("");

  const errorModals = results
    .map((entry, i) => {
      if (!entry.error) return "";
      return renderErrorModal(entry, i);
    })
    .join("");

  return promptModals + errorModals;
}

function renderModal(entry: ResultEntry, index: number): string {
  return `
    <div class="modal-backdrop" data-modal-index="${index}">
      <div class="modal">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(entry.scenarioName)}</h3>
            <span class="modal-subtitle">${escapeHtml(entry.scenarioKey)}</span>
          </div>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${renderModalPrompt(entry.prompt)}
          ${entry.rubric ? renderModalRubric(entry.rubric) : ""}
        </div>
      </div>
    </div>`;
}

function renderModalPrompt(prompt: string): string {
  return `
    <div class="modal-section">
      <h4>Prompt</h4>
      <pre class="modal-prompt">${escapeHtml(prompt)}</pre>
    </div>`;
}

function renderModalRubric(rubric: string | RubricCriterion[]): string {
  if (typeof rubric === "string") {
    return `
      <div class="modal-section">
        <h4>Rubric</h4>
        <pre class="modal-prompt">${escapeHtml(rubric)}</pre>
      </div>`;
  }

  const rows = rubric
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.check)}</td>
        <td class="modal-rubric-weight">${Math.round(c.weight * 100)}%</td>
      </tr>`,
    )
    .join("");

  return `
    <div class="modal-section">
      <h4>Rubric</h4>
      <table class="modal-rubric-table">
        <thead><tr><th>Check</th><th>Weight</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderErrorModal(entry: ResultEntry, index: number): string {
  return `
    <div class="modal-backdrop" data-error-index="${index}">
      <div class="modal">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(displayAgentName(entry))}</h3>
            <span class="modal-subtitle">${escapeHtml(entry.scenarioName)}</span>
          </div>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="modal-section">
            <h4>Error</h4>
            <pre class="modal-prompt modal-error-text">${escapeHtml(entry.error!)}</pre>
          </div>
        </div>
      </div>
    </div>`;
}

// --- Friendly Error ---

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/quota|rate.?limit|429|too many requests/i, "Rate limit / quota exceeded"],
  [/auth|unauthorized|401|403|api.?key|token/i, "Authentication error"],
  [/timeout|timed?\s*out|ETIMEDOUT/i, "Timeout"],
  [/ECONNREFUSED|ENOTFOUND|network|socket/i, "Network error"],
  [/not found|command not found|ENOENT/i, "CLI not found"],
  [/spawn|EPERM|EACCES/i, "Permission error"],
];

function friendlyError(error: string): string {
  for (const [pattern, friendly] of ERROR_PATTERNS) {
    if (pattern.test(error)) return friendly;
  }
  return error.length > 80 ? error.slice(0, 77) + "..." : error;
}
