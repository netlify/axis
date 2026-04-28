import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { RunResult } from "../types/output.js";
import type {
  InteractionCategory,
  SparseIndex,
  TriageFlaggedInteraction,
  TriagePattern,
  TriageResult,
} from "../types/scoring.js";
import { parseJsonFromText } from "./parse-json.js";

/** Maximum interactions to flag for deep evaluation. */
const MAX_FLAGS = 30;

/** Maximum characters for the sparse index in the triage prompt. */
const MAX_SPARSE_INDEX_CHARS = 60_000;

/**
 * Run the triage LLM pass on a sparse index.
 * Scans the compressed transcript for patterns, classifies interactions,
 * and flags areas of concern for deep evaluation.
 *
 * Returns an empty triage result on failure (no flags, no patterns).
 */
export async function runTriage(result: RunResult, sparseIndex: SparseIndex): Promise<TriageResult> {
  const prompt = buildTriagePrompt(result, sparseIndex);
  const responseText = await callJudge(result, prompt);
  return parseTriageResponse(responseText);
}

function buildTriagePrompt(result: RunResult, sparseIndex: SparseIndex): string {
  const { stats } = sparseIndex;

  return `You are an expert evaluator for AXIS, an AI agent testing framework.

You are analyzing an agent's execution trace to identify areas that need deeper evaluation.

SCENARIO: ${result.scenarioName}

TASK GIVEN TO AGENT:
${result.prompt}

SPARSE INDEX (${stats.totalInteractions} interactions):
${truncateSparseIndex(sparseIndex.lines)}

STATS:
- Environment interactions: ${stats.byCategory.environment}
- Service interactions: ${stats.byCategory.service}
- Agent interactions: ${stats.byCategory.agent}
- Errors: ${stats.totalErrors}
- Total duration: ${stats.totalDurationMs}ms

CONTEXT FOR EVALUATION:
- Tool discovery (e.g., ToolSearch, ListTools) and agent configuration reads are required infrastructure — do not flag as unnecessary unless genuinely redundant (same query repeated).
- Byte counts in sparse lines show total I/O transferred, not file content size. Small results are normal for write/edit confirmations.
- Tool durations include system overhead (SDK roundtrips, sandbox setup, process spawning) — do not flag interactions solely for being slow unless the agent caused the slowness through redundant or unnecessary work.
- If a service call (API request, web fetch) returned structured, usable content and the agent used it to complete the task, do not flag it for concerns about hypothetical missing content or page size.

INSTRUCTIONS:
Analyze this agent execution trace and identify areas of concern.

For each interaction you want to flag for deep evaluation, specify:
1. The interaction ID (#N)
2. Why it needs deeper review
3. Which dimensions to evaluate: success, speed, weight, relevance, necessity

Also identify any patterns across interactions:
- Repeated failures or retries
- Redundant service calls (same endpoint called multiple times)
- Excessive environment operations for simple tasks
- Wasted agent reasoning that didn't lead to progress
- Unnecessary interactions given prior context

Respond with ONLY valid JSON:
{
  "flaggedInteractions": [
    {"id": 1, "reason": "description of concern", "concerns": ["success", "relevance"]},
    ...
  ],
  "patterns": [
    {"description": "pattern description", "interactionIds": [1, 2, 3], "severity": "high"},
    ...
  ],
  "categoryNotes": {
    "environment": "summary of environment interaction quality",
    "service": "summary of service interaction quality",
    "agent": "summary of agent reasoning quality"
  }
}

Flag at most ${MAX_FLAGS} interactions. Focus on the most significant issues.
Non-flagged interactions will receive default passing scores.`;
}

async function callJudge(runResult: RunResult, prompt: string): Promise<string> {
  const adapter = getAdapter(runResult.agentConfig.adapter);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "axis-triage-"));
  try {
    const output = await adapter.run({
      prompt,
      config: runResult.agentConfig,
      scenario: {
        key: "__triage__",
        name: "AXIS Triage",
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

/**
 * Parse the triage LLM response. Returns empty result on failure.
 */
export function parseTriageResponse(responseText: string): TriageResult {
  const empty: TriageResult = {
    flaggedInteractions: [],
    patterns: [],
    categoryNotes: {
      environment: "",
      service: "",
      agent: "",
    },
  };

  const parsed = parseJsonFromText(responseText);
  if (!parsed) return empty;

  const flaggedInteractions = parseFlags(parsed.flaggedInteractions);
  const patterns = parsePatterns(parsed.patterns);
  const categoryNotes = parseCategoryNotes(parsed.categoryNotes);

  return { flaggedInteractions, patterns, categoryNotes };
}

function parseFlags(raw: unknown): TriageFlaggedInteraction[] {
  if (!Array.isArray(raw)) return [];

  const validConcerns = new Set(["success", "speed", "weight", "relevance", "necessity"]);
  const flags: TriageFlaggedInteraction[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== "number" || typeof obj.reason !== "string") continue;

    const concerns = Array.isArray(obj.concerns)
      ? (obj.concerns.filter(
          (c) => typeof c === "string" && validConcerns.has(c),
        ) as TriageFlaggedInteraction["concerns"])
      : [];

    flags.push({
      id: obj.id,
      reason: obj.reason,
      concerns: concerns.length > 0 ? concerns : ["success", "relevance"],
    });

    if (flags.length >= MAX_FLAGS) break;
  }

  return flags;
}

function parsePatterns(raw: unknown): TriagePattern[] {
  if (!Array.isArray(raw)) return [];

  const validSeverities = new Set(["low", "medium", "high"]);
  const patterns: TriagePattern[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.description !== "string") continue;

    const interactionIds = Array.isArray(obj.interactionIds)
      ? obj.interactionIds.filter((id): id is number => typeof id === "number")
      : [];

    const severity =
      typeof obj.severity === "string" && validSeverities.has(obj.severity)
        ? (obj.severity as TriagePattern["severity"])
        : "medium";

    patterns.push({ description: obj.description, interactionIds, severity });
  }

  return patterns;
}

function parseCategoryNotes(raw: unknown): Record<InteractionCategory, string> {
  const defaults: Record<InteractionCategory, string> = {
    environment: "",
    service: "",
    agent: "",
  };

  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;

  return {
    environment: typeof obj.environment === "string" ? obj.environment : "",
    service: typeof obj.service === "string" ? obj.service : "",
    agent: typeof obj.agent === "string" ? obj.agent : "",
  };
}

function truncateSparseIndex(lines: string[]): string {
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
