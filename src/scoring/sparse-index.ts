import type { NormalizedEntry, NormalizedTranscript } from "../transcript/types.js";
import type { Interaction, InteractionCategory, SparseIndex } from "../types/scoring.js";
import { categorizeInteraction } from "../transcript/categorize.js";

/** Max characters for the detail portion of a sparse line. */
const MAX_DETAIL_CHARS = 80;

/** Max characters for the outcome portion. */
const MAX_OUTCOME_CHARS = 40;

/**
 * Build a deterministic sparse index from a normalized transcript.
 * Groups entries into interactions, classifies each, and produces compressed lines.
 *
 * Purely deterministic — no LLM calls, no side effects.
 */
export interface BuildSparseIndexOptions {
  /** Wall-clock timestamps of the agent process (ISO strings). When provided, used to compute startupMs/shutdownMs gaps. */
  agentStartTime?: string;
  agentEndTime?: string;
}

export function buildSparseIndex(
  normalized: NormalizedTranscript,
  options: BuildSparseIndexOptions = {},
): SparseIndex {
  const { entries } = normalized;
  const interactions: Interaction[] = [];
  const lines: string[] = [];
  const visited = new Set<number>();

  // Reference timestamp for computing startMs offsets — prefer the agent's spawn time
  // so the timeline span matches the agent process lifetime. Fall back to first event.
  const firstEntryMs = entries.length > 0 ? new Date(entries[0].timestamp).getTime() : 0;
  const agentStartMs = options.agentStartTime ? new Date(options.agentStartTime).getTime() : 0;
  const timeZero = agentStartMs > 0 ? agentStartMs : firstEntryMs;

  let nextId = 1;

  for (let i = 0; i < entries.length; i++) {
    if (visited.has(i)) continue;

    const entry = entries[i];
    const interaction = buildInteraction(entry, entries, visited, nextId, timeZero);
    interactions.push(interaction);
    lines.push(interaction.sparseLine);
    nextId++;
  }

  // Second pass: fill in durationMs for interactions that lack it (e.g. assistant thinking)
  // by using the gap to the next interaction's startMs
  for (let i = 0; i < interactions.length; i++) {
    if (interactions[i].durationMs === null && interactions[i].startMs !== null) {
      if (i + 1 < interactions.length && interactions[i + 1].startMs !== null) {
        interactions[i].durationMs = interactions[i + 1].startMs! - interactions[i].startMs!;
      }
    }
  }

  const stats = computeStats(interactions);

  // Compute startup/shutdown gaps relative to the agent process lifetime, if known.
  if (options.agentStartTime && options.agentEndTime && entries.length > 0) {
    const agentEndMs = new Date(options.agentEndTime).getTime();
    const firstEventMs = new Date(entries[0].timestamp).getTime();
    const lastEventMs = new Date(entries[entries.length - 1].timestamp).getTime();
    const startupMs = Math.max(0, firstEventMs - agentStartMs);
    const shutdownMs = Math.max(0, agentEndMs - lastEventMs);
    if (startupMs > 0) stats.startupMs = startupMs;
    if (shutdownMs > 0) stats.shutdownMs = shutdownMs;
  }

  return { lines, interactions, stats };
}

/**
 * Build a single interaction from one or more transcript entries.
 */
function buildInteraction(
  entry: NormalizedEntry,
  entries: NormalizedEntry[],
  visited: Set<number>,
  id: number,
  timeZero: number,
): Interaction {
  // Consecutive assistant entries merge into one agent interaction
  if (entry.type === "assistant") {
    return buildAssistantInteraction(entry, entries, visited, id, timeZero);
  }

  // tool_use + paired tool_result = 1 interaction
  if (entry.type === "tool_use") {
    return buildToolInteraction(entry, entries, visited, id, timeZero);
  }

  // Standalone error
  if (entry.type === "error") {
    return buildErrorInteraction(entry, visited, id, timeZero);
  }

  // tool_result without a pair, system, user, or other entry types
  return buildStandaloneInteraction(entry, visited, id, timeZero);
}

/**
 * Merge consecutive assistant entries into a single agent interaction.
 */
function buildAssistantInteraction(
  start: NormalizedEntry,
  entries: NormalizedEntry[],
  visited: Set<number>,
  id: number,
  timeZero: number,
): Interaction {
  const indices: number[] = [start.index];
  visited.add(start.index);

  // Merge consecutive assistant entries
  let j = start.index + 1;
  while (j < entries.length && entries[j].type === "assistant") {
    indices.push(j);
    visited.add(j);
    j++;
  }

  const text = indices
    .map((idx) => entries[idx].text ?? "")
    .filter(Boolean)
    .join(" ");
  const summary = truncate(text || "(thinking)", MAX_DETAIL_CHARS);
  const contextBytes = textSize(text);

  const sparseLine = formatSparseLine(id, "agent", "assistant", summary);

  return {
    id,
    entryIndices: indices,
    categories: ["agent"],
    sparseLine,
    toolName: null,
    hasError: false,
    durationMs: null,
    startMs: computeStartMs(start.timestamp, timeZero),
    contextBytes,
  };
}

/**
 * Build a tool_use interaction, including its paired tool_result if available.
 */
function buildToolInteraction(
  entry: NormalizedEntry,
  entries: NormalizedEntry[],
  visited: Set<number>,
  id: number,
  timeZero: number,
): Interaction {
  const indices: number[] = [entry.index];
  visited.add(entry.index);

  const toolName = entry.toolName ?? "unknown";
  const categories = categorizeInteraction(entry.type, entry.toolName, {
    toolInputSummary: entry.toolInputSummary,
    isNetworkCall: entry.isNetworkCall,
    kind: entry.kind,
  });

  let resultText: string | null = null;
  let durationMs: number | null = null;
  let hasError = false;
  let pairedInputSummary: string | null = null;
  let pairedToolInput: Record<string, unknown> | null = null;

  // Include paired tool_result
  if (entry.pairedIndex !== null && !visited.has(entry.pairedIndex)) {
    const paired = entries[entry.pairedIndex];
    indices.push(entry.pairedIndex);
    visited.add(entry.pairedIndex);
    resultText = paired.toolResultText;
    hasError = paired.isError;
    pairedInputSummary = paired.toolInputSummary;
    pairedToolInput = paired.toolInput;

    // Estimate duration from timestamps
    if (entry.timestamp && paired.timestamp) {
      const start = new Date(entry.timestamp).getTime();
      const end = new Date(paired.timestamp).getTime();
      if (start > 0 && end > 0 && end >= start) {
        durationMs = end - start;
      }
    }
  }

  // Check if any following error is within 2 entries (associated error)
  if (!hasError) {
    for (let k = entry.index + 1; k < Math.min(entry.index + 3, entries.length); k++) {
      if (entries[k].type === "error" && !visited.has(k)) {
        hasError = true;
        indices.push(k);
        visited.add(k);
        break;
      }
    }
  }

  // Some adapters emit empty inputs on the tool_use (e.g. codex web_search) and the
  // populated input only appears on the paired tool_result. Fall back to that.
  const effectiveInputSummary = entry.toolInputSummary ?? pairedInputSummary;
  const effectiveToolInput = entry.toolInput ?? pairedToolInput;
  const inputSummary = effectiveInputSummary ? `(${truncate(effectiveInputSummary, 60)})` : "";
  const detail = `${toolName}${inputSummary}`;
  const inputBytes = effectiveToolInput ? textSize(JSON.stringify(effectiveToolInput)) : textSize(effectiveInputSummary);
  const contextBytes = inputBytes + textSize(resultText);
  const outcome = buildOutcome(hasError, durationMs, contextBytes);

  const sparseLine = formatSparseLineWithOutcome(id, categoriesShort(categories), "tool_use", detail, outcome);

  return {
    id,
    entryIndices: indices,
    categories,
    sparseLine,
    toolName,
    hasError,
    durationMs,
    startMs: computeStartMs(entry.timestamp, timeZero),
    contextBytes,
  };
}

/**
 * Build a standalone error interaction.
 */
function buildErrorInteraction(
  entry: NormalizedEntry,
  visited: Set<number>,
  id: number,
  timeZero: number,
): Interaction {
  visited.add(entry.index);

  const message = truncate(entry.errorMessage ?? entry.text ?? "(unknown error)", MAX_DETAIL_CHARS);
  const contextBytes = textSize(entry.errorMessage ?? entry.text);

  const sparseLine = formatSparseLine(id, "error", "error", `"${message}"`);

  return {
    id,
    entryIndices: [entry.index],
    categories: ["agent"],
    sparseLine,
    toolName: null,
    hasError: true,
    durationMs: null,
    startMs: computeStartMs(entry.timestamp, timeZero),
    contextBytes,
  };
}

/**
 * Build a standalone interaction for system, user, or orphaned tool_result entries.
 */
function buildStandaloneInteraction(
  entry: NormalizedEntry,
  visited: Set<number>,
  id: number,
  timeZero: number,
): Interaction {
  visited.add(entry.index);

  const categories = categorizeInteraction(entry.type, entry.toolName, {
    kind: entry.kind,
  });
  const text = entry.text ?? entry.toolResultText ?? "(no content)";
  const summary = truncate(text, MAX_DETAIL_CHARS);
  const contextBytes = textSize(text);

  const sparseLine = formatSparseLine(id, categoriesShort(categories), entry.type, summary);

  return {
    id,
    entryIndices: [entry.index],
    categories,
    sparseLine,
    toolName: entry.toolName,
    hasError: entry.isError,
    durationMs: null,
    startMs: computeStartMs(entry.timestamp, timeZero),
    contextBytes,
  };
}

// --- Timeline helpers ---

function computeStartMs(timestamp: string, timeZero: number): number | null {
  if (!timestamp || !timeZero) return null;
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, t - timeZero);
}

// --- Formatting helpers ---

function formatSparseLine(id: number, category: string, type: string, detail: string): string {
  const idStr = `#${id}`.padEnd(5);
  const catStr = category.padEnd(9);
  const typeStr = type.padEnd(12);
  return `${idStr}${catStr}${typeStr}${detail}`;
}

function formatSparseLineWithOutcome(
  id: number,
  category: string,
  type: string,
  detail: string,
  outcome: string,
): string {
  const idStr = `#${id}`.padEnd(5);
  const catStr = category.padEnd(9);
  const typeStr = type.padEnd(12);
  return `${idStr}${catStr}${typeStr}${detail} -> ${outcome}`;
}

function buildOutcome(hasError: boolean, durationMs: number | null, contextBytes: number): string {
  const parts: string[] = [];

  if (hasError) {
    parts.push("error");
  } else {
    parts.push("ok");
  }

  if (contextBytes > 0) {
    parts.push(formatSize(contextBytes));
  }

  if (durationMs !== null && durationMs > 0) {
    parts.push(formatDurationShort(durationMs));
  }

  return truncate(parts.join(", "), MAX_OUTCOME_CHARS);
}

function categoriesShort(categories: InteractionCategory[]): string {
  return categories.map((c) => (c === "environment" ? "env" : c)).join(",");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, maxLen: number): string {
  // Collapse whitespace for display
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + "...";
}

function textSize(text: string | null | undefined): number {
  return text ? new TextEncoder().encode(text).length : 0;
}

// --- Content population ---

/** Max characters of content to store per interaction for report display. */
const MAX_CONTENT_PER_INTERACTION = 2_000;

/**
 * Populate the `content` field on each interaction with formatted entry content
 * for display in reports. Mutates interactions in-place.
 */
export function populateInteractionContent(sparseIndex: SparseIndex, normalized: NormalizedTranscript): void {
  for (const interaction of sparseIndex.interactions) {
    const parts: string[] = [];

    for (const idx of interaction.entryIndices) {
      const entry = normalized.entries[idx];
      if (!entry) continue;

      switch (entry.type) {
        case "assistant":
          parts.push(`[ASSISTANT] ${entry.text ?? "(no text)"}`);
          break;
        case "tool_use": {
          parts.push(`[TOOL_USE] ${entry.toolName ?? "unknown"}`);
          // Some adapters emit empty inputs on tool_use start (e.g. codex web_search):
          // the populated input lands on the paired tool_result. Fall back to it.
          let inputSummary = entry.toolInputSummary;
          let toolInput = entry.toolInput;
          if (!inputSummary && entry.pairedIndex !== null) {
            const paired = normalized.entries[entry.pairedIndex];
            if (paired?.toolInputSummary) {
              inputSummary = paired.toolInputSummary;
              toolInput = paired.toolInput;
            }
          }
          if (inputSummary) parts.push(`  Input: ${inputSummary}`);
          if (toolInput) {
            const inputStr = JSON.stringify(toolInput);
            parts.push(`  Full input: ${inputStr.length > 800 ? inputStr.slice(0, 800) + "..." : inputStr}`);
          }
          break;
        }
        case "tool_result":
          parts.push(`[TOOL_RESULT]`);
          if (entry.toolResultText) {
            const result =
              entry.toolResultText.length > 1200 ? entry.toolResultText.slice(0, 1200) + "..." : entry.toolResultText;
            parts.push(`  Result: ${result}`);
          }
          break;
        case "error":
          parts.push(`[ERROR] ${entry.errorMessage ?? entry.text ?? "(unknown error)"}`);
          break;
        default:
          parts.push(`[${entry.type.toUpperCase()}] ${entry.text ?? "(no content)"}`);
      }
    }

    const content = parts.join("\n");
    interaction.content =
      content.length > MAX_CONTENT_PER_INTERACTION
        ? content.slice(0, MAX_CONTENT_PER_INTERACTION) + "\n... (truncated)"
        : content;
  }
}

// --- Stats ---

function computeStats(interactions: Interaction[]): SparseIndex["stats"] {
  const byCategory: Record<InteractionCategory, number> = {
    environment: 0,
    service: 0,
    agent: 0,
  };

  let totalErrors = 0;
  let totalDurationMs = 0;

  for (const interaction of interactions) {
    for (const cat of interaction.categories) {
      byCategory[cat]++;
    }
    if (interaction.hasError) totalErrors++;
    if (interaction.durationMs !== null) totalDurationMs += interaction.durationMs;
  }

  // Wall-clock elapsed time from first interaction start to last interaction end
  let wallClockMs = 0;
  if (interactions.length > 0) {
    const last = interactions[interactions.length - 1];
    if (last.startMs !== null) {
      wallClockMs = last.startMs + (last.durationMs ?? 0);
    }
  }

  return {
    totalInteractions: interactions.length,
    byCategory,
    totalErrors,
    totalDurationMs,
    wallClockMs,
  };
}
