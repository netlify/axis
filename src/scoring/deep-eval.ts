import type { NormalizedEntry, NormalizedTranscript } from "../transcript/types.js";
import type { RunResult } from "../types/output.js";
import type { ScoringWeights } from "../types/config.js";
import type {
  CategoryEvalResult,
  DeepEvalResult,
  EvalPattern,
  Interaction,
  InteractionAudit,
  InteractionCategory,
  NecessityJudgment,
  SparseIndex,
} from "../types/scoring.js";
import { DEFAULT_AUDIT_SCORES } from "./category-score.js";
import { callJudge } from "./judge.js";
import { parseJsonFromText } from "./parse-json.js";
import { CATEGORY_GUIDANCE, getPromptTemplates, interpolate } from "./prompt-templates.js";

/** Max characters of full content to include per interaction. */
const MAX_CONTENT_PER_INTERACTION = 3_000;

/** Max total content characters to send to the judge. */
const MAX_TOTAL_CONTENT = 40_000;

/** Max characters for the sparse index in the evaluation prompt. */
const MAX_SPARSE_INDEX_CHARS = 60_000;

/** Options for the deep evaluation pass. */
export interface DeepEvalOptions {
  /** Scoring weights — categories with weight 0 are skipped. */
  weights?: ScoringWeights;
  /** Report directory containing raw data files for judges. */
  reportDir?: string;
}

/**
 * Run the deep evaluation as parallel per-category judge calls.
 *
 * Each category (environment, service, agent) gets its own focused LLM judge.
 * Categories with no interactions or zero weight are skipped (default scores used).
 * Speed is always computed heuristically from interaction timing data (no LLM needed).
 */
export async function runDeepEval(
  result: RunResult,
  sparseIndex: SparseIndex,
  normalized: NormalizedTranscript,
  options?: DeepEvalOptions,
): Promise<DeepEvalResult> {
  // If there are no interactions at all, return defaults
  if (sparseIndex.interactions.length === 0) {
    return buildDefaultResult(sparseIndex);
  }

  const categories: InteractionCategory[] = ["environment", "service", "agent"];

  // Run per-category judges in parallel
  const categoryResults = await Promise.all(
    categories.map(async (category) => {
      // Skip categories with no interactions
      if (sparseIndex.stats.byCategory[category] === 0) {
        return buildDefaultCategoryResult(category);
      }

      // Skip categories with zero weight
      if (options?.weights && options.weights[category] === 0) {
        return buildDefaultCategoryResult(category);
      }

      return runCategoryEval(result, sparseIndex, normalized, category, options?.reportDir);
    }),
  );

  // Merge per-category results into a single DeepEvalResult
  const merged = mergeCategoryResults(categoryResults, sparseIndex);

  // Inject heuristic speed into ALL audits — speed is always deterministic
  for (const audit of merged.audits) {
    const interaction = sparseIndex.interactions.find((i) => i.id === audit.id);
    if (interaction) {
      audit.speed = computeHeuristicSpeed(interaction);
    }
  }

  return merged;
}

/**
 * Compute a heuristic speed score (0-1) for an interaction based on
 * duration and category. Deterministic — no LLM needed.
 *
 * Thresholds are generous to account for system overhead
 * (SDK roundtrips, sandbox setup, process spawning).
 */
export function computeHeuristicSpeed(interaction: Interaction): number {
  const { durationMs, categories } = interaction;

  // No timing data — assume efficient
  if (durationMs === null || durationMs <= 0) return 1.0;

  const seconds = durationMs / 1000;

  // Service interactions (API calls, web fetches): network latency expected
  if (categories.includes("service")) {
    if (seconds <= 2) return 1.0;
    if (seconds <= 5) return 0.9;
    if (seconds <= 10) return 0.8;
    if (seconds <= 25) return 0.6;
    return 0.4;
  }

  // Environment interactions (file ops, shell commands): local, should be near-instant
  if (categories.includes("environment")) {
    if (seconds <= 0.5) return 1.0;
    if (seconds <= 2) return 0.9;
    if (seconds <= 5) return 0.8;
    if (seconds <= 10) return 0.6;
    return 0.4;
  }

  // Agent thinking: reasoning latency
  if (seconds <= 2) return 1.0;
  if (seconds <= 5) return 0.9;
  if (seconds <= 15) return 0.8;
  if (seconds <= 30) return 0.6;
  return 0.4;
}

// --- Per-category judge ---

async function runCategoryEval(
  result: RunResult,
  sparseIndex: SparseIndex,
  normalized: NormalizedTranscript,
  category: InteractionCategory,
  reportDir?: string,
): Promise<CategoryEvalResult> {
  const prompt = buildCategoryEvalPrompt(result, sparseIndex, normalized, category, reportDir);
  const responseText = await callJudge(result, prompt, {
    scenarioKey: `__${category}_eval__`,
    scenarioName: `AXIS ${category} Evaluation`,
  });

  return parseCategoryEvalResponse(responseText, category, sparseIndex);
}

function buildCategoryEvalPrompt(
  result: RunResult,
  sparseIndex: SparseIndex,
  normalized: NormalizedTranscript,
  category: InteractionCategory,
  reportDir?: string,
): string {
  const { stats } = sparseIndex;
  const sparseLines = truncateSparseLines(sparseIndex.lines);

  // Filter interactions to this category and build content
  const categoryInteractions = sparseIndex.interactions.filter((i) => i.categories.includes(category));
  const interactionContent = buildCategoryInteractionContent(categoryInteractions, normalized);

  // Build data dir reference
  const dataDir = reportDir ? `${reportDir}/scenarios/${result.scenarioKey}` : "(not available)";

  const { category_eval } = getPromptTemplates();

  return interpolate(category_eval.template, {
    scenarioName: result.scenarioName,
    prompt: result.prompt,
    categoryName: category,
    totalInteractions: stats.totalInteractions,
    categoryInteractionCount: categoryInteractions.length,
    sparseLines,
    categoryGuidance: CATEGORY_GUIDANCE[category] ?? "",
    interactionContent,
    dataDir,
    evaluationDimensions: getEvaluationDimensions(category),
    necessitySection: getNecessitySection(category),
    responseFormat: getResponseFormat(category),
  });
}

// --- Per-category prompt content ---

/**
 * Env/service: only evaluate execution success.
 * Agent: evaluate success + decision quality (weight, contextRelevance).
 */
function getEvaluationDimensions(category: InteractionCategory): string {
  if (category === "agent") {
    return `- success: Was the reasoning productive and focused? Did it lead to progress on the task?
- weight: Were tool invocations right-sized for the operation? Evaluate whether the agent sent an appropriate amount of data to the tool and received a proportionate response. (1.0 = right-sized, 0.3 = bloated/wasteful)
- contextRelevance: Was the tool's output relevant and usable for the task? If the tool succeeded and the agent used the output to make progress, score 1.0. Only reduce this score if the output was genuinely irrelevant noise that the agent could not use. (1.0 = all useful/necessary, 0.0 = all noise)`;
  }

  // Environment and service: execution quality only
  return `- success: Did the interaction complete without errors? Were the results correct and usable? Evaluate based on the actual content returned, not assumptions about what a "complete" result should look like.

NOTE: Only evaluate whether the tool/service EXECUTED correctly. The agent's choice of what to invoke and with what parameters is evaluated separately under the agent dimension.`;
}

/**
 * Agent: necessity spans ALL categories (the agent decides what to invoke).
 * Env/service: no necessity evaluation (they just execute what they're told).
 */
function getNecessitySection(category: InteractionCategory): string {
  if (category === "agent") {
    return `Also evaluate NECESSITY for the agent's overall execution across ALL categories:
- necessity (0.0 to 1.0): Were the agent's interactions necessary for the task? Consider interactions across ALL categories (environment, service, agent) — the agent is responsible for deciding what tools to invoke. Evaluate only what the agent actually did — do not penalize for hypothetical steps it could have taken. 1.0 = all interactions were necessary, 0.0 = all were unnecessary.
- List any interaction IDs (from any category) that were unnecessary.`;
  }

  return "";
}

/**
 * Build the expected JSON response format based on category.
 * Env/service: audits with success only, no necessity.
 * Agent: audits with full dimensions + necessity.
 */
function getResponseFormat(category: InteractionCategory): string {
  if (category === "agent") {
    return `Respond with ONLY valid JSON:
{
  "audits": [
    {"id": 1, "success": 0.9, "weight": 0.8, "contextRelevance": 0.6, "rationale": "brief explanation"},
    ...
  ],
  "necessity": {"score": 0.85, "unnecessaryIds": [4], "rationale": "brief explanation"},
  "patterns": [
    {"description": "pattern description", "interactionIds": [1, 2, 3], "severity": "high"},
    ...
  ]
}`;
  }

  // Environment and service: success-only audits, no necessity
  return `Respond with ONLY valid JSON:
{
  "audits": [
    {"id": 1, "success": 0.9, "rationale": "brief explanation"},
    ...
  ],
  "patterns": [
    {"description": "pattern description", "interactionIds": [1, 2, 3], "severity": "high"},
    ...
  ]
}`;
}

/**
 * Build the full content section for interactions in a specific category.
 * Includes as much content as fits within the total budget.
 */
function buildCategoryInteractionContent(interactions: Interaction[], normalized: NormalizedTranscript): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (let idx = 0; idx < interactions.length; idx++) {
    const interaction = interactions[idx];

    const fullContent = interaction.entryIndices.map((i) => formatFullEntry(normalized.entries[i])).join("\n");

    const truncatedContent =
      fullContent.length > MAX_CONTENT_PER_INTERACTION
        ? fullContent.slice(0, MAX_CONTENT_PER_INTERACTION) + "\n... (truncated)"
        : fullContent;

    if (totalChars + truncatedContent.length > MAX_TOTAL_CONTENT) {
      sections.push(`\n... (remaining ${interactions.length - idx} interactions shown only in sparse index above)`);
      break;
    }

    sections.push(`---
#${interaction.id} | Category: ${interaction.categories.join(", ")}
${truncatedContent}
---`);

    totalChars += truncatedContent.length;
  }

  return sections.join("\n\n");
}

function formatFullEntry(entry: NormalizedEntry): string {
  const parts: string[] = [];

  switch (entry.type) {
    case "assistant":
      parts.push(`[ASSISTANT] ${entry.text ?? "(no text)"}`);
      break;
    case "tool_use":
      parts.push(`[TOOL_USE] ${entry.toolName ?? "unknown"}`);
      if (entry.toolInputSummary) parts.push(`  Input: ${entry.toolInputSummary}`);
      if (entry.toolInput) {
        const inputStr = JSON.stringify(entry.toolInput);
        parts.push(`  Full input: ${inputStr.length > 1000 ? inputStr.slice(0, 1000) + "..." : inputStr}`);
      }
      break;
    case "tool_result":
      parts.push(`[TOOL_RESULT]`);
      if (entry.toolResultText) {
        const resultText =
          entry.toolResultText.length > 2000 ? entry.toolResultText.slice(0, 2000) + "..." : entry.toolResultText;
        parts.push(`  Result: ${resultText}`);
      }
      break;
    case "error":
      parts.push(`[ERROR] ${entry.errorMessage ?? entry.text ?? "(unknown error)"}`);
      break;
    default:
      parts.push(`[${entry.type.toUpperCase()}] ${entry.text ?? "(no content)"}`);
  }

  return parts.join("\n");
}

// --- Response parsing ---

/**
 * Parse a per-category judge response into a CategoryEvalResult.
 * Fills in default audits for interactions the LLM missed.
 */
export function parseCategoryEvalResponse(
  responseText: string,
  category: InteractionCategory,
  sparseIndex: SparseIndex,
): CategoryEvalResult {
  const parsed = parseJsonFromText(responseText);

  const categoryInteractions = sparseIndex.interactions.filter((i) => i.categories.includes(category));

  if (!parsed) {
    return buildDefaultCategoryResult(category, categoryInteractions);
  }

  // Parse audits
  const llmAudits = parseCategoryAudits(parsed.audits, category, sparseIndex);
  const auditMap = new Map(llmAudits.map((a) => [a.id, a]));

  const allAudits: InteractionAudit[] = categoryInteractions.map((interaction) => {
    const existing = auditMap.get(interaction.id);
    if (existing) return existing;
    return {
      id: interaction.id,
      categories: interaction.categories,
      success: interaction.hasError ? 0.3 : DEFAULT_AUDIT_SCORES.success,
      speed: DEFAULT_AUDIT_SCORES.speed,
      weight: DEFAULT_AUDIT_SCORES.weight,
      contextRelevance: DEFAULT_AUDIT_SCORES.contextRelevance,
      rationale: "default",
    };
  });

  // Parse necessity (single object, not array)
  const necessity = parseSingleNecessity(parsed.necessity, category);

  // Parse patterns
  const patterns = parsePatterns(parsed.patterns);

  return { category, audits: allAudits, necessity, patterns };
}

/**
 * Parse the legacy deep eval LLM response (all categories in one call).
 * Kept for backward compatibility with existing tests and any code that uses it.
 */
export function parseDeepEvalResponse(responseText: string, sparseIndex: SparseIndex): DeepEvalResult {
  const parsed = parseJsonFromText(responseText);

  let llmAudits: InteractionAudit[] = [];
  let llmNecessity: NecessityJudgment[] = [];
  let llmPatterns: EvalPattern[] = [];

  if (parsed) {
    llmAudits = parseAudits(parsed.audits, sparseIndex);
    llmNecessity = parseNecessityArray(parsed.necessity);
    llmPatterns = parsePatterns(parsed.patterns);
  }

  // Build complete audit list: LLM-scored where available, defaults for any the LLM missed
  const auditMap = new Map(llmAudits.map((a) => [a.id, a]));
  const allAudits: InteractionAudit[] = [];

  for (const interaction of sparseIndex.interactions) {
    const existing = auditMap.get(interaction.id);
    if (existing) {
      allAudits.push(existing);
    } else {
      allAudits.push({
        id: interaction.id,
        categories: interaction.categories,
        success: interaction.hasError ? 0.3 : DEFAULT_AUDIT_SCORES.success,
        speed: DEFAULT_AUDIT_SCORES.speed,
        weight: DEFAULT_AUDIT_SCORES.weight,
        contextRelevance: DEFAULT_AUDIT_SCORES.contextRelevance,
        rationale: "default",
      });
    }
  }

  // Ensure all three categories have necessity judgments
  const categories: InteractionCategory[] = ["environment", "service", "agent"];
  const necessityMap = new Map(llmNecessity.map((n) => [n.category, n]));
  const allNecessity: NecessityJudgment[] = categories.map((cat) => {
    const existing = necessityMap.get(cat);
    if (existing) return existing;
    return {
      category: cat,
      score: 1.0,
      unnecessaryIds: [],
      rationale: "default",
    };
  });

  return { audits: allAudits, necessity: allNecessity, patterns: llmPatterns };
}

// --- Merge per-category results ---

/**
 * Merge per-category results into a single DeepEvalResult.
 * Interactions that appear in multiple categories get the audit from the first
 * category that evaluated them (multi-category interactions are rare).
 */
export function mergeCategoryResults(categoryResults: CategoryEvalResult[], sparseIndex: SparseIndex): DeepEvalResult {
  const auditMap = new Map<number, InteractionAudit>();

  // Collect all audits, first-write-wins for multi-category interactions
  for (const catResult of categoryResults) {
    for (const audit of catResult.audits) {
      if (!auditMap.has(audit.id)) {
        auditMap.set(audit.id, audit);
      }
    }
  }

  // Ensure every interaction has an audit (some may be uncategorized or missed)
  const allAudits: InteractionAudit[] = sparseIndex.interactions.map((interaction) => {
    const existing = auditMap.get(interaction.id);
    if (existing) return existing;
    return {
      id: interaction.id,
      categories: interaction.categories,
      success: interaction.hasError ? 0.3 : DEFAULT_AUDIT_SCORES.success,
      speed: DEFAULT_AUDIT_SCORES.speed,
      weight: DEFAULT_AUDIT_SCORES.weight,
      contextRelevance: DEFAULT_AUDIT_SCORES.contextRelevance,
      rationale: "default",
    };
  });

  // Collect necessity and patterns from each category
  const necessity: NecessityJudgment[] = categoryResults.map((r) => r.necessity);
  const patterns: EvalPattern[] = categoryResults.flatMap((r) => r.patterns);

  return { audits: allAudits, necessity, patterns };
}

// --- Default builders ---

function buildDefaultResult(sparseIndex: SparseIndex): DeepEvalResult {
  const audits: InteractionAudit[] = sparseIndex.interactions.map((interaction) => ({
    id: interaction.id,
    categories: interaction.categories,
    success: interaction.hasError ? 0.3 : DEFAULT_AUDIT_SCORES.success,
    speed: DEFAULT_AUDIT_SCORES.speed,
    weight: DEFAULT_AUDIT_SCORES.weight,
    contextRelevance: DEFAULT_AUDIT_SCORES.contextRelevance,
    rationale: "default",
  }));

  const categories: InteractionCategory[] = ["environment", "service", "agent"];
  const necessity: NecessityJudgment[] = categories.map((cat) => ({
    category: cat,
    score: 0.8,
    unnecessaryIds: [],
    rationale: "default",
  }));

  return { audits, necessity, patterns: [] };
}

export function buildDefaultCategoryResult(
  category: InteractionCategory,
  interactions?: Interaction[],
): CategoryEvalResult {
  const audits: InteractionAudit[] = (interactions ?? []).map((interaction) => ({
    id: interaction.id,
    categories: interaction.categories,
    success: interaction.hasError ? 0.3 : DEFAULT_AUDIT_SCORES.success,
    speed: DEFAULT_AUDIT_SCORES.speed,
    weight: DEFAULT_AUDIT_SCORES.weight,
    contextRelevance: DEFAULT_AUDIT_SCORES.contextRelevance,
    rationale: "default",
  }));

  return {
    category,
    audits,
    necessity: {
      category,
      score: 0.8,
      unnecessaryIds: [],
      rationale: "default",
    },
    patterns: [],
  };
}

// --- Parsing helpers ---

function parseCategoryAudits(
  raw: unknown,
  category: InteractionCategory,
  sparseIndex: SparseIndex,
): InteractionAudit[] {
  if (!Array.isArray(raw)) return [];

  const categoryInteractions = sparseIndex.interactions.filter((i) => i.categories.includes(category));
  const interactionMap = new Map(categoryInteractions.map((i) => [i.id, i]));
  const audits: InteractionAudit[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== "number") continue;

    const interaction = interactionMap.get(obj.id);
    if (!interaction) continue;

    audits.push({
      id: obj.id,
      categories: interaction.categories,
      success: clamp01(obj.success),
      speed: DEFAULT_AUDIT_SCORES.speed, // placeholder — overridden by heuristic
      // weight/contextRelevance may be absent for env/service (success-only responses)
      weight: typeof obj.weight === "number" ? clamp01(obj.weight) : DEFAULT_AUDIT_SCORES.weight,
      contextRelevance:
        typeof obj.contextRelevance === "number"
          ? clamp01(obj.contextRelevance)
          : DEFAULT_AUDIT_SCORES.contextRelevance,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    });
  }

  return audits;
}

function parseSingleNecessity(raw: unknown, category: InteractionCategory): NecessityJudgment {
  if (!raw || typeof raw !== "object") {
    return { category, score: 1.0, unnecessaryIds: [], rationale: "default" };
  }

  const obj = raw as Record<string, unknown>;

  const unnecessaryIds = Array.isArray(obj.unnecessaryIds)
    ? obj.unnecessaryIds.filter((id): id is number => typeof id === "number")
    : [];

  return {
    category,
    score: clamp01(obj.score),
    unnecessaryIds,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

/** Parse audits from legacy all-in-one deep eval response. */
function parseAudits(raw: unknown, sparseIndex: SparseIndex): InteractionAudit[] {
  if (!Array.isArray(raw)) return [];

  const interactionMap = new Map(sparseIndex.interactions.map((i) => [i.id, i]));
  const audits: InteractionAudit[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== "number") continue;

    const interaction = interactionMap.get(obj.id);
    if (!interaction) continue;

    audits.push({
      id: obj.id,
      categories: interaction.categories,
      success: clamp01(obj.success),
      speed: DEFAULT_AUDIT_SCORES.speed, // placeholder — overridden by heuristic
      weight: clamp01(obj.weight),
      contextRelevance: clamp01(obj.contextRelevance),
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    });
  }

  return audits;
}

/** Parse necessity array from legacy all-in-one deep eval response. */
function parseNecessityArray(raw: unknown): NecessityJudgment[] {
  if (!Array.isArray(raw)) return [];

  const validCategories = new Set<InteractionCategory>(["environment", "service", "agent"]);
  const judgments: NecessityJudgment[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.category !== "string" || !validCategories.has(obj.category as InteractionCategory)) continue;

    const unnecessaryIds = Array.isArray(obj.unnecessaryIds)
      ? obj.unnecessaryIds.filter((id): id is number => typeof id === "number")
      : [];

    judgments.push({
      category: obj.category as InteractionCategory,
      score: clamp01(obj.score),
      unnecessaryIds,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    });
  }

  return judgments;
}

function parsePatterns(raw: unknown): EvalPattern[] {
  if (!Array.isArray(raw)) return [];

  const validSeverities = new Set(["low", "medium", "high"]);
  const patterns: EvalPattern[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.description !== "string") continue;

    const interactionIds = Array.isArray(obj.interactionIds)
      ? obj.interactionIds.filter((id): id is number => typeof id === "number")
      : [];

    const severity =
      typeof obj.severity === "string" && validSeverities.has(obj.severity)
        ? (obj.severity as EvalPattern["severity"])
        : "medium";

    patterns.push({ description: obj.description, interactionIds, severity });
  }

  return patterns;
}

function truncateSparseLines(lines: string[]): string {
  let totalChars = 0;
  const included: string[] = [];
  for (const line of lines) {
    if (totalChars + line.length > MAX_SPARSE_INDEX_CHARS) {
      included.push(`... (${lines.length - included.length} more interactions omitted)`);
      break;
    }
    included.push(line);
    totalChars += line.length;
  }
  return included.join("\n");
}

function clamp01(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
