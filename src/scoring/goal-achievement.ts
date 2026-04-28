import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { NormalizedEntry } from "../transcript/types.js";
import type { RubricCriterion } from "../types/scenario.js";
import type { RunResult } from "../types/output.js";
import type { GoalAchievementScore, CriterionGrade } from "../types/scoring.js";
import { parseJsonFromText } from "./parse-json.js";

export async function scoreGoalAchievement(
  result: RunResult,
  normalizedEntries: NormalizedEntry[],
): Promise<GoalAchievementScore> {
  const { rubric } = result;
  const { result: finalResult } = result.output;

  if (typeof rubric === "string") {
    return scoreStringRubric(result, rubric, normalizedEntries, finalResult);
  }

  if (!rubric || rubric.length === 0) {
    return { score: 0, criteria: [] };
  }

  return scoreArrayRubric(result, rubric, normalizedEntries, finalResult);
}

async function scoreStringRubric(
  runResult: RunResult,
  rubric: string,
  entries: NormalizedEntry[],
  finalResult: string | null,
): Promise<GoalAchievementScore> {
  const prompt = buildStringRubricPrompt(runResult, entries, finalResult, rubric);
  const responseText = await callJudge(runResult, prompt);

  const parsed = parseJsonFromText(responseText);
  if (!parsed || typeof parsed.score !== "number") {
    return {
      score: 0,
      criteria: [
        {
          check: rubric,
          weight: 1.0,
          score: 0,
          rationale: "Failed to parse judge response",
        },
      ],
    };
  }

  const score = Math.max(0, Math.min(10, Math.round(parsed.score)));
  return {
    score: Math.round((score / 10) * 100),
    criteria: [
      {
        check: rubric,
        weight: 1.0,
        score,
        rationale: (parsed.rationale as string) ?? "",
      },
    ],
  };
}

async function scoreArrayRubric(
  runResult: RunResult,
  rubric: RubricCriterion[],
  entries: NormalizedEntry[],
  finalResult: string | null,
): Promise<GoalAchievementScore> {
  const prompt = buildArrayRubricPrompt(runResult, entries, finalResult, rubric);
  const responseText = await callJudge(runResult, prompt);

  const criteria = parseArrayJudgeResponse(responseText, rubric);
  const score = computeWeightedScore(criteria);

  return { score, criteria };
}

async function callJudge(runResult: RunResult, prompt: string): Promise<string> {
  const adapter = getAdapter(runResult.agentConfig.adapter);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "axis-judge-"));
  try {
    const output = await adapter.run({
      prompt,
      config: runResult.agentConfig,
      scenario: {
        key: "__judge__",
        name: "AXIS Judge",
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

/** Max characters for the condensed transcript section. */
const MAX_TRANSCRIPT_CHARS = 50_000;

/** Max characters per individual transcript entry. */
const MAX_ENTRY_CHARS = 2_000;

function buildStringRubricPrompt(
  result: RunResult,
  entries: NormalizedEntry[],
  finalResult: string | null,
  rubric: string,
): string {
  return `You are an expert evaluator for an AI agent testing framework called AXIS.

An AI agent was given a task. You must evaluate how well it performed by reviewing its transcript AND by independently verifying the results yourself.

SCENARIO: ${result.scenarioName}

TASK GIVEN TO AGENT:
${getOriginalPrompt(result)}

---

AGENT TRANSCRIPT (condensed):
${formatTranscriptForJudge(entries)}

---

AGENT'S FINAL RESULT:
${finalResult ?? "(no final result)"}

---

RUBRIC:
${rubric}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — visit URLs, check endpoints, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. Score based on what you can verify, not just what the agent claims.

When done, respond with ONLY valid JSON on its own line:
{"score": <0-10>, "rationale": "<1-2 sentence explanation>"}

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met.`;
}

function buildArrayRubricPrompt(
  result: RunResult,
  entries: NormalizedEntry[],
  finalResult: string | null,
  rubric: RubricCriterion[],
): string {
  const rubricText = rubric.map((r, i) => `${i}. "${r.check}" (weight: ${r.weight!})`).join("\n");

  return `You are an expert evaluator for an AI agent testing framework called AXIS.

An AI agent was given a task. You must evaluate how well it performed by reviewing its transcript AND by independently verifying the results yourself.

SCENARIO: ${result.scenarioName}

TASK GIVEN TO AGENT:
${getOriginalPrompt(result)}

---

AGENT TRANSCRIPT (condensed):
${formatTranscriptForJudge(entries)}

---

AGENT'S FINAL RESULT:
${finalResult ?? "(no final result)"}

---

RUBRIC CRITERIA:
${rubricText}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — visit URLs, check endpoints, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. For each criterion, provide a score from 0 to 10 and a brief rationale.

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met.

When done, respond with ONLY valid JSON on its own line:
{"grades": [{"criterion_index": 0, "score": <0-10>, "rationale": "<string>"}, ...]}`;
}

function getOriginalPrompt(result: RunResult): string {
  return result.prompt;
}

/**
 * Condense normalized entries into a human-readable summary for the judge.
 */
function formatTranscriptForJudge(entries: NormalizedEntry[]): string {
  if (entries.length === 0) return "(empty transcript)";

  const lines: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < entries.length; i++) {
    const condensed = condenseEntry(entries[i], i + 1);

    if (totalChars + condensed.length > MAX_TRANSCRIPT_CHARS) {
      const remaining = entries.length - i;
      lines.push(`\n... (${remaining} more entries truncated for brevity)`);
      break;
    }

    lines.push(condensed);
    totalChars += condensed.length;
  }

  return lines.join("\n");
}

/**
 * Condense a single normalized entry into a readable line.
 */
function condenseEntry(entry: NormalizedEntry, index: number): string {
  switch (entry.type) {
    case "assistant":
      return `[${index}] ASSISTANT: ${truncate(entry.text ?? "(no text)", MAX_ENTRY_CHARS)}`;
    case "tool_use": {
      const name = entry.toolName ?? "unknown";
      const input = entry.toolInputSummary ? `(${truncate(entry.toolInputSummary, 500)})` : "";
      return `[${index}] TOOL_USE: ${name}${input}`;
    }
    case "tool_result":
      return `[${index}] TOOL_RESULT: ${truncate(entry.toolResultText ?? "(no result)", MAX_ENTRY_CHARS)}`;
    case "error":
      return `[${index}] ERROR: ${truncate(entry.errorMessage ?? entry.text ?? "(unknown error)", MAX_ENTRY_CHARS)}`;
    case "system":
      return `[${index}] SYSTEM: ${truncate(entry.text ?? "(no content)", 500)}`;
    case "user":
      return `[${index}] USER: ${truncate(entry.text ?? "(no content)", MAX_ENTRY_CHARS)}`;
    default:
      return `[${index}] ${entry.type}: ${truncate(entry.text ?? "(no content)", 500)}`;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function parseArrayJudgeResponse(responseText: string, rubric: RubricCriterion[]): CriterionGrade[] {
  const parsed = parseJsonFromText(responseText);
  if (!parsed || !Array.isArray(parsed.grades)) {
    return rubric.map((r) => ({
      check: r.check,
      weight: r.weight!,
      score: 0,
      rationale: "Failed to parse judge response",
    }));
  }

  const grades = parsed.grades as Array<{
    criterion_index: number;
    score: number;
    rationale: string;
  }>;

  return rubric.map((r, i) => {
    const grade = grades.find((g) => g.criterion_index === i);
    return {
      check: r.check,
      weight: r.weight!,
      score: grade ? Math.max(0, Math.min(10, Math.round(grade.score))) : 0,
      rationale: grade?.rationale ?? "No grade provided",
    };
  });
}

function computeWeightedScore(criteria: CriterionGrade[]): number {
  if (criteria.length === 0) return 0;

  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;

  const weightedSum = criteria.reduce((sum, c) => sum + (c.score / 10) * c.weight, 0);

  return Math.round((weightedSum / totalWeight) * 100);
}
