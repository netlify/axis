import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { NormalizedEntry, NormalizedTranscript } from "../transcript/types.js";
import type { RunResult } from "../types/output.js";
import type {
  DeepEvalResult,
  EvalPattern,
  Interaction,
  InteractionAudit,
  InteractionCategory,
  NecessityJudgment,
  SparseIndex,
} from "../types/scoring.js";
import { DEFAULT_AUDIT_SCORES } from "./category-score.js";
import { parseJsonFromText } from "./parse-json.js";
import { getPromptTemplates, interpolate } from "./prompt-templates.js";

/** Max characters of full content to include per interaction. */
const MAX_CONTENT_PER_INTERACTION = 3_000;

/** Max total content characters to send to the judge. */
const MAX_TOTAL_CONTENT = 40_000;

/** Max characters for the sparse index in the evaluation prompt. */
const MAX_SPARSE_INDEX_CHARS = 60_000;

/**
 * Run the deep evaluation LLM pass.
 *
 * Speed is always computed heuristically from interaction timing data (no LLM needed).
 * The LLM evaluates ALL interactions for success, weight, contextRelevance,
 * and necessity per category.
 */
export async function runDeepEval(
  result: RunResult,
  sparseIndex: SparseIndex,
  normalized: NormalizedTranscript,
): Promise<DeepEvalResult> {
  // If there are no interactions at all, return defaults
  if (sparseIndex.interactions.length === 0) {
    return buildDefaultResult(sparseIndex);
  }

  // Always call LLM to evaluate all interactions
  const prompt = buildDeepEvalPrompt(result, sparseIndex, normalized);
  const responseText = await callJudge(result, prompt);
  const deepResult = parseDeepEvalResponse(responseText, sparseIndex);

  // Inject heuristic speed into ALL audits — speed is always deterministic
  for (const audit of deepResult.audits) {
    const interaction = sparseIndex.interactions.find((i) => i.id === audit.id);
    if (interaction) {
      audit.speed = computeHeuristicSpeed(interaction);
    }
  }

  return deepResult;
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

function buildDeepEvalPrompt(
  result: RunResult,
  sparseIndex: SparseIndex,
  normalized: NormalizedTranscript,
): string {
  const { stats } = sparseIndex;

  const sparseLines = truncateSparseLines(sparseIndex.lines);
  const interactionContent = buildInteractionContent(sparseIndex, normalized);

  const { deep_eval } = getPromptTemplates();

  return interpolate(deep_eval.template, {
    scenarioName: result.scenarioName,
    prompt: result.prompt,
    totalInteractions: stats.totalInteractions,
    sparseLines,
    envInteractions: stats.byCategory.environment,
    svcInteractions: stats.byCategory.service,
    agentInteractions: stats.byCategory.agent,
    totalErrors: stats.totalErrors,
    totalDurationMs: stats.totalDurationMs,
    interactionContent,
  });
}

/**
 * Build the full content section for ALL interactions.
 * Includes as much content as fits within the total budget.
 */
function buildInteractionContent(sparseIndex: SparseIndex, normalized: NormalizedTranscript): string {
  const sections: string[] = [];
  let totalChars = 0;

  for (let idx = 0; idx < sparseIndex.interactions.length; idx++) {
    const interaction = sparseIndex.interactions[idx];

    const fullContent = interaction.entryIndices.map((i) => formatFullEntry(normalized.entries[i])).join("\n");

    const truncatedContent =
      fullContent.length > MAX_CONTENT_PER_INTERACTION
        ? fullContent.slice(0, MAX_CONTENT_PER_INTERACTION) + "\n... (truncated)"
        : fullContent;

    if (totalChars + truncatedContent.length > MAX_TOTAL_CONTENT) {
      sections.push(
        `\n... (remaining ${sparseIndex.interactions.length - idx} interactions shown only in sparse index above)`,
      );
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
        const result =
          entry.toolResultText.length > 2000 ? entry.toolResultText.slice(0, 2000) + "..." : entry.toolResultText;
        parts.push(`  Result: ${result}`);
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

async function callJudge(runResult: RunResult, prompt: string): Promise<string> {
  const adapter = getAdapter(runResult.agentConfig.adapter);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "axis-deep-eval-"));
  try {
    const output = await adapter.run({
      prompt,
      config: runResult.agentConfig,
      scenario: {
        key: "__deep_eval__",
        name: "AXIS Deep Evaluation",
        prompt,
        rubric: [],
      },
      workingDirectory: workspace,
    });
    return output.result ?? "";
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// --- Response parsing ---

/**
 * Parse the deep eval LLM response.
 * Fills in default audits for interactions the LLM missed and default necessity for missing categories.
 */
export function parseDeepEvalResponse(responseText: string, sparseIndex: SparseIndex): DeepEvalResult {
  const parsed = parseJsonFromText(responseText);

  let llmAudits: InteractionAudit[] = [];
  let llmNecessity: NecessityJudgment[] = [];
  let llmPatterns: EvalPattern[] = [];

  if (parsed) {
    llmAudits = parseAudits(parsed.audits, sparseIndex);
    llmNecessity = parseNecessity(parsed.necessity);
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

function parseNecessity(raw: unknown): NecessityJudgment[] {
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
