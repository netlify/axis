import type { ScoringWeights } from "./config.js";
import type { BaseRunResult, Logger, RunSummary } from "./output.js";

// --- Per-criterion judge output ---

export interface CriterionGrade {
  check: string;
  weight: number;
  score: number; // 0-10
  rationale: string;
}

// --- Goal Achievement ---

export interface GoalAchievementScore {
  score: number; // 0-100
  criteria: CriterionGrade[];
}

// --- Interaction classification and evaluation ---

/** The three process-quality categories for interaction classification. */
export type InteractionCategory = "environment" | "service" | "agent";

/**
 * A single classified interaction in the transcript.
 * An "interaction" is typically a tool_use + its paired tool_result,
 * or a group of consecutive assistant entries, or a standalone error.
 */
export interface Interaction {
  /** Sequential ID within the run (1-based). */
  id: number;
  /** Indices into the NormalizedEntry[] array that compose this interaction. */
  entryIndices: number[];
  /** Classified categories (an interaction can belong to multiple, e.g. env + service). */
  categories: InteractionCategory[];
  /** The sparse index line for this interaction. */
  sparseLine: string;
  /** Tool name if this is a tool-based interaction. */
  toolName: string | null;
  /** Whether this interaction had an error. */
  hasError: boolean;
  /** Duration in ms (from paired timestamps), null if unavailable. */
  durationMs: number | null;
  /** Offset from the first transcript entry in ms. null if timestamp unavailable. */
  startMs: number | null;
  /** Approximate token weight of the context (input + output text size in bytes). */
  contextBytes: number;
  /** Formatted content for display in reports (tool I/O, assistant text, etc). */
  content?: string;
}

/** Deterministic compressed representation of a transcript. */
export interface SparseIndex {
  /** One line per interaction, ordered by sequence. */
  lines: string[];
  /** The full interaction objects (lines[i] corresponds to interactions[i]). */
  interactions: Interaction[];
  /** Summary stats. */
  stats: {
    totalInteractions: number;
    byCategory: Record<InteractionCategory, number>;
    totalErrors: number;
    totalDurationMs: number;
    /** Wall-clock elapsed time from first to last interaction end. */
    wallClockMs: number;
  };
}

// --- Triage (LLM call 1) ---

export interface TriageFlaggedInteraction {
  /** Interaction ID (matches Interaction.id). */
  id: number;
  /** Why this interaction was flagged for deep evaluation. */
  reason: string;
  /** The concern areas to evaluate in depth. */
  concerns: ("success" | "speed" | "weight" | "relevance" | "necessity")[];
}

export interface TriagePattern {
  /** Pattern description (e.g., "Repeated failed attempts at deployment"). */
  description: string;
  /** Interaction IDs involved. */
  interactionIds: number[];
  /** Severity: how much this pattern should affect the score. */
  severity: "low" | "medium" | "high";
}

/** Output of the triage LLM pass. */
export interface TriageResult {
  /** Per-interaction triage notes. Only populated for flagged interactions. */
  flaggedInteractions: TriageFlaggedInteraction[];
  /** High-level patterns the triage pass identified. */
  patterns: TriagePattern[];
  /** Per-category preliminary notes. */
  categoryNotes: Record<InteractionCategory, string>;
}

// --- Deep Evaluation (LLM call 2) ---

/** Per-interaction audit result from the deep evaluation pass. */
export interface InteractionAudit {
  /** Interaction ID. */
  id: number;
  /** Categories (copied from interaction — may be multi-category). */
  categories: InteractionCategory[];
  /** Did the interaction succeed or encounter failures? 0-1 */
  success: number;
  /** Speed relative to expected for this type of operation. 0-1 */
  speed: number;
  /** How much context was consumed/produced, relative to what was needed. 0-1 */
  weight: number;
  /** How much of the context was actionable vs wasteful. 0-1 */
  contextRelevance: number;
  /** Brief rationale for the scores. */
  rationale: string;
}

/** Collective necessity judgment across interactions in a category. */
export interface NecessityJudgment {
  category: InteractionCategory;
  /** 0-1: were the interactions in this category necessary? */
  score: number;
  /** Interactions flagged as unnecessary. */
  unnecessaryIds: number[];
  rationale: string;
}

/** Full deep evaluation output. */
export interface DeepEvalResult {
  /** Per-interaction audits (only for flagged interactions + sampled unflagged). */
  audits: InteractionAudit[];
  /** Per-category necessity scores. */
  necessity: NecessityJudgment[];
}

// --- Category scores ---

/** Score for a single process-quality category (environment, service, agent). */
export interface CategoryScore {
  /** 0-100, after log-normal mapping. */
  score: number;
  /** Number of interactions in this category. */
  interactionCount: number;
  /** Number of audited (LLM-evaluated) interactions. */
  auditedCount: number;
  /** Breakdown of audit dimensions (each 0-100). */
  dimensions: {
    success: number;
    speed: number;
    weight: number;
    relevance: number;
    necessity: number;
  };
  /** Audit details for this category. */
  audits: InteractionAudit[];
  /** Necessity judgment. */
  necessity: NecessityJudgment;
}

// --- Composite result for one run ---

export interface ScoreResult {
  /** 0-100 composite AXIS score. */
  axisScore: number;
  /** Goal achievement (LLM judge). */
  goalAchievement: GoalAchievementScore;
  /** Process quality for environment interactions. */
  environment: CategoryScore;
  /** Process quality for service interactions. */
  service: CategoryScore;
  /** Process quality for agent-internal interactions. */
  agent: CategoryScore;
  /** Weights used for this scoring. */
  weights: ScoringWeights;
  /** The sparse index generated for this run (included in debug mode). */
  sparseIndex?: SparseIndex;
}

// --- Scored run result ---

export interface ScoredRunResult extends BaseRunResult {
  score: ScoreResult;
}

// --- Full scored output ---

export interface ScoredOutput {
  version: string;
  timestamp: string;
  durationMs: number;
  results: ScoredRunResult[];
  summary: ScoredSummary;
}

export interface ScoredSummary extends RunSummary {
  averageAxisScore: number;
}

// --- Scoring options ---

export interface ScoringOptions {
  weights?: ScoringWeights;
  logger?: Logger;
  /** Called when scoring starts/finishes for a result. */
  onProgress?: (scenarioKey: string, agentName: string, phase: "start" | "done") => void;
}
