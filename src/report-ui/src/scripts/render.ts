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
      <footer class="report-footer">AXIS \u2014 Agent eXperience Index Score</footer>
    </div>
    ${renderModals(report.results)}`;
}

// --- Header ---

function renderHeader(report: ReportData): string {
  const scored = isScoredSummary(report.summary);
  const totalCost = report.results.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

  return `
    <header class="report-header">
      <div class="report-title">
        <h1>AXIS Report</h1>
        <span class="report-id">${escapeHtml(report.reportId)}</span>
      </div>
      <span class="report-timestamp">${fmtTimestamp(report.timestamp)}</span>
      <div class="summary-cards">
        <div class="summary-card">
          <div class="card-value">${report.summary.total}</div>
          <div class="card-label">Scenarios</div>
        </div>
        <div class="summary-card">
          <div class="card-value">${report.summary.completed}</div>
          <div class="card-label">Passed</div>
        </div>
        <div class="summary-card${report.summary.failed > 0 ? " card-failed" : ""}">
          <div class="card-value">${report.summary.failed}</div>
          <div class="card-label">Failed</div>
        </div>
        ${
          scored
            ? `
        <div class="summary-card">
          <div class="card-value">${scoreBadge(report.summary.averageAxisScore)}</div>
          <div class="card-label">Avg AXIS Result</div>
        </div>`
            : ""
        }
        <div class="summary-card">
          <div class="card-value">${fmtDuration(report.durationMs)}</div>
          <div class="card-label">Duration</div>
        </div>
        <div class="summary-card">
          <div class="card-value">${fmtCost(totalCost > 0 ? totalCost : undefined)}</div>
          <div class="card-label">Total Cost</div>
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

  const rows = report.results
    .map((entry, i) => renderResultRow(entry, i, hasScores) + renderDetailRow(entry, i))
    .join("");

  return `
    <section class="results-section">
      <table class="results-table">
        <thead>
          <tr>
            <th></th>
            <th>Scenario</th>
            <th>Agent</th>
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
            <th class="col-right hide-mobile">Duration</th>
            <th class="col-right hide-mobile">Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderResultRow(entry: ResultEntry, index: number, hasScores: boolean): string {
  const s = entry.score;
  const isFailed = entry.exitCode !== 0 || !!entry.error;

  const errorHint = entry.error ? `<span class="error-hint">${escapeHtml(friendlyError(entry.error))}</span>` : "";

  const infoBtn = entry.prompt
    ? `<button class="info-btn" data-modal-index="${index}" title="View scenario settings">\u2139</button>`
    : "";

  if (hasScores) {
    return `
      <tr class="result-row" data-index="${index}">
        <td><span class="expand-icon">\u25B6</span></td>
        <td class="col-scenario">${escapeHtml(entry.scenarioName)}${infoBtn}${errorHint}</td>
        <td class="col-agent">${escapeHtml(entry.agentName)}</td>
        <td class="col-score">${scoreBadge(s?.axisScore)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.goalAchievement.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.environment.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.service.score)}</td>
        <td class="col-score hide-mobile">${scoreBadge(s?.agent.score)}</td>
        <td class="col-right hide-mobile">${fmtDuration(entry.durationMs)}</td>
        <td class="col-right hide-mobile">${fmtCost(entry.totalCostUsd)}</td>
      </tr>`;
  }

  const status = isFailed
    ? `<span class="score-badge score-red">Fail</span>`
    : `<span class="score-badge score-green">Pass</span>`;

  return `
    <tr class="result-row" data-index="${index}">
      <td><span class="expand-icon">\u25B6</span></td>
      <td class="col-scenario">${escapeHtml(entry.scenarioName)}${infoBtn}${errorHint}</td>
      <td class="col-agent">${escapeHtml(entry.agentName)}</td>
      <td class="col-score">${status}</td>
      <td class="col-right hide-mobile">${fmtDuration(entry.durationMs)}</td>
      <td class="col-right hide-mobile">${fmtCost(entry.totalCostUsd)}</td>
    </tr>`;
}

function renderDetailRow(entry: ResultEntry, index: number): string {
  const colspan = entry.score ? 10 : 7;
  return `
    <tr class="detail-row" id="detail-${index}">
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
  const imperfect = ga.criteria.filter((c) => c.score < 10);
  const deductions = imperfect.length > 0 ? renderDeductionsSummary(imperfect) : "";
  const criteria = ga.criteria.map(renderCriterion).join("");

  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>Goal Achievement</h3>
        <span class="section-score">${ga.score} / 100</span>
      </div>
      ${deductions}
      <div class="criteria-list">${criteria}</div>
    </div>`;
}

function renderDeductionsSummary(imperfect: CriterionGrade[]): string {
  const items = imperfect
    .map((c) => {
      const lost = 10 - c.score;
      return `
      <div class="deduction-item">
        <span class="deduction-criterion">${escapeHtml(c.check)}</span>
        <span class="deduction-lost">-${lost} pts</span>
        <span class="deduction-rationale">${escapeHtml(c.rationale)}</span>
      </div>`;
    })
    .join("");

  return `
    <div class="deductions-summary">
      <div class="deductions-header">Areas for improvement</div>
      ${items}
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
  const d = cat.dimensions;
  const nonDefaultAudits = cat.audits.filter((a) => a.rationale !== "default");
  const hasRealAudits = nonDefaultAudits.length > 0;

  // Identify dimensions below 100
  const dimEntries: Array<{ label: string; value: number }> = [
    { label: "Success", value: d.success },
    { label: "Speed", value: d.speed },
    { label: "Relevance", value: d.relevance },
    { label: "Necessity", value: d.necessity },
  ];
  const imperfectDims = dimEntries.filter((e) => e.value < 100);

  // Only show dimensions grid when interactions were deeply evaluated
  const dimensionsBlock = hasRealAudits
    ? `<div class="dimensions-grid">${dimEntries.map((e) => dimensionItem(e.label, e.value)).join("")}</div>`
    : "";

  // Deductions: real audit rationales or baseline note
  const deductionsBlock =
    imperfectDims.length > 0 ? renderCategoryDeductions(imperfectDims, nonDefaultAudits, hasRealAudits) : "";

  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>${escapeHtml(label)}</h3>
        <span class="section-score">${cat.score} / 100</span>
      </div>
      <div class="interaction-meta">
        ${cat.interactionCount} interaction${cat.interactionCount !== 1 ? "s" : ""}
        ${hasRealAudits ? `&middot; ${cat.auditedCount} audited` : ""}
      </div>
      ${dimensionsBlock}
      ${deductionsBlock}
      ${hasRealAudits ? renderAudits(nonDefaultAudits) : ""}
      ${renderNecessity(cat.necessity)}
    </div>`;
}

function renderCategoryDeductions(
  imperfectDims: Array<{ label: string; value: number }>,
  audits: InteractionAudit[],
  _hasRealAudits: boolean,
): string {
  const dimTags = imperfectDims
    .map((d) => `<span class="dim-tag ${fillColorClass(d.value)}">${d.label}: ${d.value}</span>`)
    .join("");

  const reasons = audits
    .map(
      (a) => `
      <div class="cat-deduction-item">
        <span class="cat-deduction-id">#${a.id}</span>
        <span class="cat-deduction-scores">${renderAuditDimScores(a)}</span>
        <span class="cat-deduction-rationale">${escapeHtml(a.rationale)}</span>
      </div>`,
    )
    .join("");

  return `
    <div class="deductions-summary">
      <div class="deductions-header">Score breakdown</div>
      <div class="dim-tags">${dimTags}</div>
      ${reasons}
    </div>`;
}

function renderAuditDimScores(a: InteractionAudit): string {
  const dims: Array<{ label: string; value: number }> = [
    { label: "Success", value: a.success },
    { label: "Speed", value: a.speed },
    { label: "Relevance", value: a.contextRelevance },
  ];
  return dims
    .filter((d) => d.value < 1)
    .map((d) => `<span class="dim-score-tag">${d.label}: ${fmt01(d.value)}</span>`)
    .join("");
}

function renderAudits(audits: InteractionAudit[]): string {
  const items = audits.map(renderAuditItem).join("");
  return `
    <div class="audits-section">
      <button class="audits-toggle">Show audits (${audits.length})</button>
      <div class="audits-list">${items}</div>
    </div>`;
}

function renderAuditItem(a: InteractionAudit): string {
  return `
    <div class="audit-item">
      <div class="audit-header">
        <span class="audit-id">#${a.id}</span>
        <span class="audit-scores">
          S:${fmt01(a.success)} Sp:${fmt01(a.speed)} R:${fmt01(a.contextRelevance)}
        </span>
      </div>
      <div class="audit-rationale">${escapeHtml(a.rationale)}</div>
    </div>`;
}

function fmt01(v: number): string {
  return (v * 100).toFixed(0);
}

function renderNecessity(n: { score: number; unnecessaryIds: number[]; rationale: string }): string {
  if (n.rationale === "default") return "";

  const scoreDisplay = Math.round(n.score * 100);
  const unnecessary = n.unnecessaryIds.length > 0 ? ` &middot; Unnecessary: #${n.unnecessaryIds.join(", #")}` : "";

  return `
    <div class="necessity-section">
      <div class="necessity-header">
        <span class="necessity-label">Necessity</span>
        <span class="necessity-score ${scoreColorClass(scoreDisplay)}">${scoreDisplay}/100</span>
        ${unnecessary}
      </div>
      <div class="necessity-rationale">${escapeHtml(n.rationale)}</div>
    </div>`;
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

      return `<div class="sparse-line ${catClass}${expandable}">${escapeHtml(line)}${contentBlock}</div>`;
    })
    .join("");

  return `
    <div class="detail-section">
      <div class="section-header">
        <h3>Transcript</h3>
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
  return results
    .map((entry, i) => {
      if (!entry.prompt) return "";
      return renderModal(entry, i);
    })
    .join("");
}

function renderModal(entry: ResultEntry, index: number): string {
  return `
    <div class="modal-backdrop" data-modal-index="${index}">
      <div class="modal">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(entry.scenarioName)}</h3>
            <span class="modal-subtitle">${escapeHtml(entry.scenarioKey)} &middot; ${escapeHtml(entry.agentName)}</span>
          </div>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${renderModalPrompt(entry.prompt)}
          ${entry.rubric ? renderModalRubric(entry.rubric) : ""}
          ${entry.agentConfig ? renderModalConfig(entry.agentConfig) : ""}
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

function renderModalConfig(config: Record<string, unknown>): string {
  const entries = Object.entries(config);
  if (entries.length === 0) return "";

  const items = entries
    .map(([key, val]) => {
      const display = typeof val === "string" ? val : JSON.stringify(val);
      return `<div class="modal-config-item"><span class="modal-config-key">${escapeHtml(key)}</span><span class="modal-config-val">${escapeHtml(String(display))}</span></div>`;
    })
    .join("");

  return `
    <div class="modal-section">
      <h4>Agent Configuration</h4>
      <div class="modal-config">${items}</div>
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
