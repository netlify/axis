import type { TranscriptEntry } from "../types/agent.js";
import type { EntryAnalysis, NormalizedEntry, NormalizedTranscript, TranscriptAnalysis } from "./types.js";
import { extractFields } from "./extract.js";
import { extractUrls } from "./urls.js";
import { isNetworkCall } from "./classify.js";

const PRODUCTIVE_TYPES = new Set<TranscriptEntry["type"]>(["assistant", "tool_use"]);

/**
 * Normalize a raw transcript into adapter-agnostic entries.
 * Purely deterministic — no LLM calls, no side effects.
 * Designed to be called once after adapter.run() returns and before scoring.
 */
export function normalizeTranscript(transcript: TranscriptEntry[]): NormalizedTranscript {
  const entries = transcript.map((raw, index) => normalizeEntry(raw, index));

  pairTools(entries);

  return buildAggregate(entries);
}

function normalizeEntry(raw: TranscriptEntry, index: number): NormalizedEntry {
  const fields = extractFields(raw);

  // Claude Code embeds tool_use blocks inside "assistant" entries.
  // Re-classify to "tool_use" so pairing, counting, and network detection all work.
  const effectiveType = raw.type === "assistant" && fields.toolName !== null ? "tool_use" : raw.type;

  // Collect all text that might contain URLs for extraction
  const textForUrls = collectTextForUrls(fields);
  const urls = textForUrls ? extractUrls(textForUrls) : [];

  return {
    index,
    raw,
    type: effectiveType,
    timestamp: raw.timestamp,
    text: fields.text,
    toolName: fields.toolName,
    toolInput: fields.toolInput,
    toolInputSummary: fields.toolInputSummary,
    toolResultText: fields.toolResultText,
    errorMessage: fields.errorMessage,
    toolId: fields.toolId,
    pairedIndex: null,
    urls,
    isNetworkCall: effectiveType === "tool_use" && isNetworkCall(fields.toolName, urls),
    isError: raw.type === "error",
    isProductive: PRODUCTIVE_TYPES.has(raw.type),
  };
}

/**
 * Collect text from entry fields that may contain URLs.
 * Prioritizes tool input (most likely for network calls) and general text.
 */
function collectTextForUrls(fields: ReturnType<typeof extractFields>): string | null {
  const parts: string[] = [];

  if (fields.toolInputSummary) parts.push(fields.toolInputSummary);
  if (fields.text) parts.push(fields.text);
  if (fields.toolResultText) parts.push(fields.toolResultText);

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Pair tool_use entries with their corresponding tool_result entries.
 * Pass 1: pair by matching toolId (Gemini, Claude with IDs).
 * Pass 2: positional pairing for remaining unpaired entries.
 */
function pairTools(entries: NormalizedEntry[]): void {
  // Pass 1: pair by toolId
  const useByToolId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "tool_use" && entry.toolId) {
      useByToolId.set(entry.toolId, entry.index);
    }
  }

  for (const entry of entries) {
    if (entry.type === "tool_result" && entry.toolId && useByToolId.has(entry.toolId)) {
      const useIndex = useByToolId.get(entry.toolId)!;
      entry.pairedIndex = useIndex;
      entries[useIndex].pairedIndex = entry.index;
    }
  }

  // Pass 2: positional pairing for unpaired entries
  for (const entry of entries) {
    if (entry.type === "tool_use" && entry.pairedIndex === null) {
      for (let j = entry.index + 1; j < entries.length; j++) {
        const candidate = entries[j];
        if (candidate.type === "tool_result" && candidate.pairedIndex === null) {
          entry.pairedIndex = j;
          candidate.pairedIndex = entry.index;
          break;
        }
        // Don't skip over another unpaired tool_use
        if (candidate.type === "tool_use") break;
      }
    }
  }
}

function buildAggregate(entries: NormalizedEntry[]): NormalizedTranscript {
  const typeCounts: Record<string, number> = {};
  const toolNameSet = new Set<string>();
  const domainSet = new Set<string>();
  let toolUseCount = 0;
  let errorCount = 0;
  let pairedToolCount = 0;

  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;

    if (entry.type === "tool_use") {
      toolUseCount++;
      if (entry.pairedIndex !== null) pairedToolCount++;
    }

    if (entry.isError) errorCount++;

    if (entry.toolName) toolNameSet.add(entry.toolName);

    for (const { domain } of entry.urls) {
      if (domain) domainSet.add(domain);
    }
  }

  return {
    entries,
    typeCounts,
    toolUseCount,
    errorCount,
    pairedToolCount,
    toolNames: [...toolNameSet],
    domains: [...domainSet],
  };
}

/**
 * Convert a NormalizedTranscript to the serializable TranscriptAnalysis format.
 * Strips the `raw` back-reference and `index` from each entry so the result
 * can be safely JSON-serialized alongside the original transcript.
 */
export function toTranscriptAnalysis(normalized: NormalizedTranscript): TranscriptAnalysis {
  return {
    entries: normalized.entries.map(toEntryAnalysis),
    typeCounts: normalized.typeCounts,
    toolUseCount: normalized.toolUseCount,
    errorCount: normalized.errorCount,
    pairedToolCount: normalized.pairedToolCount,
    toolNames: normalized.toolNames,
    domains: normalized.domains,
  };
}

function toEntryAnalysis(entry: NormalizedEntry): EntryAnalysis {
  return {
    type: entry.type,
    timestamp: entry.timestamp,
    text: entry.text,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    toolInputSummary: entry.toolInputSummary,
    toolResultText: entry.toolResultText,
    errorMessage: entry.errorMessage,
    toolId: entry.toolId,
    pairedIndex: entry.pairedIndex,
    urls: entry.urls,
    isNetworkCall: entry.isNetworkCall,
    isError: entry.isError,
    isProductive: entry.isProductive,
  };
}
