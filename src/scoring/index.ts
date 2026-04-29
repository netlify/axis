import type { RunOutput, RunResult } from "../types/output.js";
import type { ScoringWeights } from "../types/config.js";
import type { ScoredOutput, ScoredRunResult, ScoreResult, ScoringOptions } from "../types/scoring.js";
import { normalizeTranscript, toTranscriptAnalysis } from "../transcript/normalize.js";
import { writeScenarioRawData } from "../reports/writer.js";
import { scoreGoalAchievement } from "./goal-achievement.js";
import { buildSparseIndex, populateInteractionContent } from "./sparse-index.js";
import { runDeepEval } from "./deep-eval.js";
import { computeCategoryScore } from "./category-score.js";
import { computeComposite } from "./composite.js";

const DEFAULT_WEIGHTS: ScoringWeights = {
  goal_achievement: 0.4,
  environment: 0.2,
  service: 0.2,
  agent: 0.2,
};

/**
 * Score a single run result using the interaction-based evaluation pipeline:
 * normalize → sparse index → write raw data → (deep eval || goal achievement) → category score → composite
 */
export async function scoreRunResult(result: RunResult, options?: ScoringOptions): Promise<ScoredRunResult> {
  const weights = options?.weights ?? DEFAULT_WEIGHTS;
  const logger = options?.logger;
  const label = `${result.scenarioKey} (${result.agentName})`;

  logger?.verbose?.(`Scoring ${label}...`);
  options?.onProgress?.(result.scenarioKey, result.agentName, "start");

  // Step 1: Normalize transcript (existing, unchanged)
  const normalized = normalizeTranscript(result.output.transcript);

  // Step 2: Build sparse index (deterministic) and populate content for reports
  const sparseIndex = buildSparseIndex(normalized);
  populateInteractionContent(sparseIndex, normalized);

  // Step 3: Write raw data to report dir so LLM judges can read it
  if (options?.reportDir) {
    writeScenarioRawData(options.reportDir, result, sparseIndex);
  }

  // Step 4: Deep eval + goal achievement in parallel
  const [deepEvalResult, goalAchievement] = await Promise.all([
    runDeepEval(result, sparseIndex, normalized, {
      weights,
      reportDir: options?.reportDir,
    }),
    scoreGoalAchievement(result, normalized.entries),
  ]);

  // Step 5: Compute category scores
  const necessityMap = new Map(deepEvalResult.necessity.map((n) => [n.category, n]));
  const defaultNecessity = (category: "environment" | "service" | "agent") => ({
    category,
    score: 1.0,
    unnecessaryIds: [] as number[],
    rationale: "default",
  });

  const environment = computeCategoryScore(
    "environment",
    deepEvalResult.audits,
    necessityMap.get("environment") ?? defaultNecessity("environment"),
    sparseIndex.interactions,
  );

  const service = computeCategoryScore(
    "service",
    deepEvalResult.audits,
    necessityMap.get("service") ?? defaultNecessity("service"),
    sparseIndex.interactions,
  );

  const agent = computeCategoryScore(
    "agent",
    deepEvalResult.audits,
    necessityMap.get("agent") ?? defaultNecessity("agent"),
    sparseIndex.interactions,
  );

  // Step 7: Compute composite AXIS score
  const axisScore = computeComposite(goalAchievement.score, environment.score, service.score, agent.score, weights);

  const score: ScoreResult = {
    axisScore,
    goalAchievement,
    environment,
    service,
    agent,
    weights,
    sparseIndex,
  };

  options?.onProgress?.(result.scenarioKey, result.agentName, "done");

  // Stamp transcript analysis onto the output so it flows into reports.
  result.output.transcriptAnalysis = toTranscriptAnalysis(normalized);

  return {
    scenarioKey: result.scenarioKey,
    scenarioName: result.scenarioName,
    agentName: result.agentName,
    prompt: result.prompt,
    rubric: result.rubric,
    agentConfig: result.agentConfig,
    output: result.output,
    score,
  };
}

/**
 * Assemble a ScoredOutput from run metadata and scored results.
 */
export function buildScoredOutput(runOutput: RunOutput, scoredResults: ScoredRunResult[]): ScoredOutput {
  const completedResults = scoredResults.filter((r) => r.output.metadata.exitCode === 0);
  const averageAxisScore =
    completedResults.length > 0
      ? completedResults.reduce((sum, r) => sum + r.score.axisScore, 0) / completedResults.length
      : 0;

  return {
    version: runOutput.version,
    timestamp: runOutput.timestamp,
    durationMs: runOutput.durationMs,
    results: scoredResults,
    summary: {
      total: runOutput.summary.total,
      completed: runOutput.summary.completed,
      failed: runOutput.summary.failed,
      averageAxisScore: Math.round(averageAxisScore),
    },
  };
}

/**
 * Score all results in a RunOutput. Scores in parallel.
 */
export async function scoreResults(runOutput: RunOutput, options?: ScoringOptions): Promise<ScoredOutput> {
  const scoredResults = await Promise.all(runOutput.results.map((r) => scoreRunResult(r, options)));

  return buildScoredOutput(runOutput, scoredResults);
}
