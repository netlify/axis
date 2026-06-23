import type { RunOutput, RunResult } from "../types/output.js";
import type { ScoringWeights } from "../types/config.js";
import type { JudgeCriterion } from "../types/scenario.js";
import type {
  CategoryScore,
  GoalAchievementScore,
  InteractionCategory,
  ScoredOutput,
  ScoredRunResult,
  ScoreResult,
  ScoringOptions,
} from "../types/scoring.js";
import { isFailedRun } from "../types/output.js";
import { normalizeTranscript, toTranscriptAnalysis } from "../transcript/normalize.js";
import { writeScenarioRawData } from "../reports/writer.js";
import { scoreGoalAchievement } from "./goal-achievement.js";
import { resolveJudgeAgent, formatJudgeLabel } from "./judge.js";
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
  // Resolve once so every judge call for this run uses the same agent and the
  // report can record exactly which agent did the scoring.
  const judgeAgent = resolveJudgeAgent(result, options?.judging);
  const resolvedJudging = [judgeAgent];
  const label = `${result.scenarioKey} (${result.agentName})`;

  logger?.verbose?.(`Scoring ${label} — judge: ${formatJudgeLabel(judgeAgent)}`);
  options?.onProgress?.(result.scenarioKey, result.agentName, "start");

  // Step 1: Normalize transcript (existing, unchanged)
  const normalized = normalizeTranscript(result.output.transcript);

  // Step 2: Build sparse index (deterministic) and populate content for reports
  const sparseIndex = buildSparseIndex(normalized, {
    agentStartTime: result.output.metadata.startTime,
    agentEndTime: result.output.metadata.endTime,
  });
  populateInteractionContent(sparseIndex, normalized);

  // Step 3: Write raw data to report dir so LLM judges can read it
  if (options?.reportDir) {
    writeScenarioRawData(options.reportDir, result, sparseIndex);
  }

  // Short-circuit: runs that failed entirely shouldn't be graded on process
  // quality — there's no process to grade. Without this, empty-transcript runs
  // get perfect-score defaults in env/service/agent because nothing was audited.
  if (isFailedRun(result.output)) {
    const score = buildZeroScore(result, weights, sparseIndex.lines.length > 0 ? sparseIndex : undefined, judgeAgent);
    options?.onProgress?.(result.scenarioKey, result.agentName, "failed");
    result.output.transcriptAnalysis = toTranscriptAnalysis(normalized);
    return {
      scenarioKey: result.scenarioKey,
      scenarioName: result.scenarioName,
      agentName: result.agentName,
      prompt: result.prompt,
      judge: result.judge,
      agentConfig: result.agentConfig,
      output: result.output,
      score,
      ...(result.workingDirectory !== undefined ? { workingDirectory: result.workingDirectory } : {}),
      ...(result.resolvedConfig !== undefined ? { resolvedConfig: result.resolvedConfig } : {}),
      ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
    };
  }

  // Step 4: Deep eval + goal achievement in parallel
  const [deepEvalResult, goalAchievement] = await Promise.all([
    runDeepEval(result, sparseIndex, normalized, {
      weights,
      reportDir: options?.reportDir,
      judging: resolvedJudging,
    }),
    scoreGoalAchievement(result, normalized.entries, resolvedJudging),
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
    judging: judgeAgent,
  };

  options?.onProgress?.(result.scenarioKey, result.agentName, "done");

  // Stamp transcript analysis onto the output so it flows into reports.
  result.output.transcriptAnalysis = toTranscriptAnalysis(normalized);

  return {
    scenarioKey: result.scenarioKey,
    scenarioName: result.scenarioName,
    agentName: result.agentName,
    prompt: result.prompt,
    judge: result.judge,
    agentConfig: result.agentConfig,
    output: result.output,
    score,
    ...(result.workingDirectory !== undefined ? { workingDirectory: result.workingDirectory } : {}),
    ...(result.resolvedConfig !== undefined ? { resolvedConfig: result.resolvedConfig } : {}),
    ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
  };
}

/**
 * Assemble a ScoredOutput from run metadata and scored results.
 */
export function buildScoredOutput(runOutput: RunOutput, scoredResults: ScoredRunResult[]): ScoredOutput {
  const completedResults = scoredResults.filter((r) => !isFailedRun(r.output));
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
      ...(runOutput.summary.skipped ? { skipped: runOutput.summary.skipped } : {}),
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

function buildZeroScore(
  result: RunResult,
  weights: ScoringWeights,
  sparseIndex: ScoreResult["sparseIndex"] | undefined,
  judging: ScoreResult["judging"],
): ScoreResult {
  const reason = result.output.metadata.error
    ? `Run failed: ${result.output.metadata.error}`
    : `Run failed with exit code ${result.output.metadata.exitCode}`;

  return {
    axisScore: 0,
    goalAchievement: buildZeroGoalAchievement(result.judge, reason),
    environment: buildZeroCategoryScore("environment"),
    service: buildZeroCategoryScore("service"),
    agent: buildZeroCategoryScore("agent"),
    weights,
    ...(sparseIndex ? { sparseIndex } : {}),
    ...(judging ? { judging } : {}),
  };
}

function buildZeroGoalAchievement(judge: RunResult["judge"], reason: string): GoalAchievementScore {
  if (typeof judge === "string") {
    return {
      score: 0,
      criteria: [{ check: judge, weight: 1, score: 0, rationale: reason }],
    };
  }
  if (Array.isArray(judge) && judge.length > 0) {
    return {
      score: 0,
      criteria: judge.map((c: JudgeCriterion) => ({
        check: c.check,
        weight: c.weight ?? 1,
        score: 0,
        rationale: reason,
      })),
    };
  }
  return { score: 0, criteria: [] };
}

function buildZeroCategoryScore(category: InteractionCategory): CategoryScore {
  return {
    score: 0,
    interactionCount: 0,
    auditedCount: 0,
    dimensions: { success: 0, speed: 0, weight: 0, relevance: 0, necessity: 0 },
    audits: [],
    necessity: { category, score: 0, unnecessaryIds: [], rationale: "Run failed before any interactions occurred" },
  };
}
