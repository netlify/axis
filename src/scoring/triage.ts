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
import { getPromptTemplates, interpolate } from "./prompt-templates.js";

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
  const { triage } = getPromptTemplates();

  return interpolate(triage.template, {
    scenarioName: result.scenarioName,
    prompt: result.prompt,
    totalInteractions: stats.totalInteractions,
    sparseLines: truncateSparseIndex(sparseIndex.lines),
    envInteractions: stats.byCategory.environment,
    svcInteractions: stats.byCategory.service,
    agentInteractions: stats.byCategory.agent,
    totalErrors: stats.totalErrors,
    totalDurationMs: stats.totalDurationMs,
    maxFlags: MAX_FLAGS,
  });
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
