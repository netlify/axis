import type { TranscriptEntry } from "../types/agent.js";

/** A URL extracted from entry content with its parsed domain. */
export interface ExtractedUrl {
  url: string;
  domain: string | null;
}

/** Normalized, adapter-agnostic representation of a transcript entry. */
export interface NormalizedEntry {
  /** Index in the original transcript array. */
  index: number;

  /** The original raw entry, preserved for custom access patterns. */
  raw: TranscriptEntry;

  /** Entry type, copied from raw for convenience. */
  type: TranscriptEntry["type"];

  /** ISO timestamp, copied from raw for convenience. */
  timestamp: string;

  // --- Extracted fields (null = could not be determined) ---

  /** Human-readable text content of this entry. */
  text: string | null;

  /** Tool name, for tool_use and tool_result entries. */
  toolName: string | null;

  /** Tool input as structured data, for tool_use entries. */
  toolInput: Record<string, unknown> | null;

  /** Tool input summarized as a brief string, for tool_use entries. */
  toolInputSummary: string | null;

  /** Tool result text, for tool_result entries. */
  toolResultText: string | null;

  /** Error message, for error entries or entries indicating failure. */
  errorMessage: string | null;

  /** Tool ID for pairing tool_use with tool_result. */
  toolId: string | null;

  /**
   * Index of the paired entry in the normalized array.
   * For tool_use: points to the matching tool_result.
   * For tool_result: points to the matching tool_use.
   * null if no pair was found.
   */
  pairedIndex: number | null;

  // --- Classifications ---

  /** URLs found in text content or tool inputs. */
  urls: ExtractedUrl[];

  /** True if this entry represents a network-related action. */
  isNetworkCall: boolean;

  /** True if this entry is an error. */
  isError: boolean;

  /** True if this is a productive action (assistant reasoning or tool invocation). */
  isProductive: boolean;
}

/** Aggregate metadata about a normalized transcript. */
export interface NormalizedTranscript {
  /** Normalized entries in original order. */
  entries: NormalizedEntry[];

  /** Count of entries by type. */
  typeCounts: Record<string, number>;

  /** Total number of tool_use entries. */
  toolUseCount: number;

  /** Total number of error entries. */
  errorCount: number;

  /** Number of successfully paired tool_use/tool_result pairs. */
  pairedToolCount: number;

  /** All unique tool names used. */
  toolNames: string[];

  /** All unique domains referenced. */
  domains: string[];
}

// ---------------------------------------------------------------------------
// Serializable analysis types (stored on AgentOutput, written to reports)
// ---------------------------------------------------------------------------

/** Per-entry extracted signals, indexed to match transcript[]. No raw back-reference. */
export interface EntryAnalysis {
  type: TranscriptEntry["type"];
  timestamp: string;
  text: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolInputSummary: string | null;
  toolResultText: string | null;
  errorMessage: string | null;
  toolId: string | null;
  pairedIndex: number | null;
  urls: ExtractedUrl[];
  isNetworkCall: boolean;
  isError: boolean;
  isProductive: boolean;
}

/** Serializable transcript analysis — per-entry signals + aggregates. */
export interface TranscriptAnalysis {
  /** Per-entry signals. entries[i] corresponds to transcript[i]. */
  entries: EntryAnalysis[];
  typeCounts: Record<string, number>;
  toolUseCount: number;
  errorCount: number;
  pairedToolCount: number;
  toolNames: string[];
  domains: string[];
}
