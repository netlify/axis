import { describe, it, expect } from "vitest";
import { buildSparseIndex } from "../../../src/scoring/sparse-index.js";
import type { NormalizedEntry, NormalizedTranscript } from "../../../src/transcript/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal NormalizedEntry with sensible defaults. */
function makeEntry(
  overrides: Partial<NormalizedEntry> & { index: number; type: NormalizedEntry["type"] },
): NormalizedEntry {
  return {
    raw: { type: overrides.type, timestamp: "", content: {} },
    timestamp: "",
    text: null,
    toolName: null,
    toolInput: null,
    toolInputSummary: null,
    toolResultText: null,
    errorMessage: null,
    toolId: null,
    pairedIndex: null,
    urls: [],
    isNetworkCall: false,
    isError: false,
    isProductive: false,
    ...overrides,
  };
}

/** Wrap entries in a NormalizedTranscript structure. */
function makeTranscript(entries: NormalizedEntry[]): NormalizedTranscript {
  return {
    entries,
    typeCounts: {},
    toolUseCount: 0,
    errorCount: 0,
    pairedToolCount: 0,
    toolNames: [],
    domains: [],
  };
}

// ---------------------------------------------------------------------------
// Empty transcript
// ---------------------------------------------------------------------------

describe("buildSparseIndex — empty transcript", () => {
  it("returns empty interactions and zero stats", () => {
    const result = buildSparseIndex(makeTranscript([]));

    expect(result.interactions).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.stats.totalInteractions).toBe(0);
    expect(result.stats.byCategory.environment).toBe(0);
    expect(result.stats.byCategory.service).toBe(0);
    expect(result.stats.byCategory.agent).toBe(0);
    expect(result.stats.totalErrors).toBe(0);
    expect(result.stats.totalDurationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Assistant entries
// ---------------------------------------------------------------------------

describe("buildSparseIndex — assistant entries", () => {
  it("single assistant entry produces 1 agent interaction", () => {
    const entries = [makeEntry({ index: 0, type: "assistant", text: "Let me think about this." })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].id).toBe(1);
    expect(result.interactions[0].categories).toEqual(["agent"]);
    expect(result.interactions[0].toolName).toBeNull();
    expect(result.interactions[0].hasError).toBe(false);
    expect(result.interactions[0].durationMs).toBeNull();
    expect(result.interactions[0].entryIndices).toEqual([0]);
  });

  it("consecutive assistant entries merge into 1 interaction", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "First thought." }),
      makeEntry({ index: 1, type: "assistant", text: "Second thought." }),
      makeEntry({ index: 2, type: "assistant", text: "Third thought." }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].entryIndices).toEqual([0, 1, 2]);
    expect(result.interactions[0].categories).toEqual(["agent"]);
    expect(result.stats.totalInteractions).toBe(1);
    expect(result.stats.byCategory.agent).toBe(1);
  });

  it("non-consecutive assistant entries do not merge", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "First thought." }),
      makeEntry({ index: 1, type: "tool_use", toolName: "Bash", pairedIndex: null }),
      makeEntry({ index: 2, type: "assistant", text: "Second thought." }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // 3 interactions: assistant, tool_use (no pair), assistant
    expect(result.interactions).toHaveLength(3);
    expect(result.interactions[0].categories).toEqual(["agent"]);
    expect(result.interactions[2].categories).toEqual(["agent"]);
  });

  it("contextBytes reflect text size", () => {
    const text = "Hello, world!";
    const entries = [makeEntry({ index: 0, type: "assistant", text })];
    const result = buildSparseIndex(makeTranscript(entries));

    // TextEncoder.encode(text).length for ASCII is text.length
    expect(result.interactions[0].contextBytes).toBe(new TextEncoder().encode(text).length);
  });

  it("assistant with no text uses '(thinking)' placeholder", () => {
    const entries = [makeEntry({ index: 0, type: "assistant", text: null })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].sparseLine).toContain("(thinking)");
    expect(result.interactions[0].contextBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool use interactions
// ---------------------------------------------------------------------------

describe("buildSparseIndex — tool_use entries", () => {
  it("tool_use + paired tool_result = 1 interaction", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        toolInputSummary: "ls -la",
        pairedIndex: 1,
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        toolResultText: "file1.txt\nfile2.txt",
        pairedIndex: 0,
        isError: false,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].entryIndices).toEqual([0, 1]);
    expect(result.interactions[0].toolName).toBe("Bash");
    expect(result.interactions[0].hasError).toBe(false);
  });

  it("environment tool (Bash) is categorized as 'environment'", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({ index: 1, type: "tool_result", toolName: "Bash", pairedIndex: 0 }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].categories).toEqual(["environment"]);
    expect(result.stats.byCategory.environment).toBe(1);
  });

  it("unknown tool is categorized as 'service'", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "my_custom_api", pairedIndex: 1 }),
      makeEntry({ index: 1, type: "tool_result", toolName: "my_custom_api", pairedIndex: 0 }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].categories).toEqual(["service"]);
    expect(result.stats.byCategory.service).toBe(1);
  });

  it("tool_use with error result sets hasError true", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 0,
        isError: true,
        toolResultText: "command not found",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].hasError).toBe(true);
    expect(result.stats.totalErrors).toBe(1);
  });

  it("tool_use without paired result has pairedIndex null", () => {
    const entries = [makeEntry({ index: 0, type: "tool_use", toolName: "Write", pairedIndex: null })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].toolName).toBe("Write");
    expect(result.interactions[0].entryIndices).toEqual([0]);
  });

  it("tool_use with null toolName uses 'unknown'", () => {
    const entries = [makeEntry({ index: 0, type: "tool_use", toolName: null, pairedIndex: null })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].toolName).toBe("unknown");
  });

  it("duration calculated from timestamps when both present", () => {
    const start = "2025-01-01T00:00:00.000Z";
    const end = "2025-01-01T00:00:02.500Z";
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1, timestamp: start }),
      makeEntry({ index: 1, type: "tool_result", toolName: "Bash", pairedIndex: 0, timestamp: end }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].durationMs).toBe(2500);
  });

  it("duration is null when timestamps are missing", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1, timestamp: "" }),
      makeEntry({ index: 1, type: "tool_result", toolName: "Bash", pairedIndex: 0, timestamp: "" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].durationMs).toBeNull();
  });

  it("duration is null when end is before start (invalid)", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        pairedIndex: 1,
        timestamp: "2025-01-01T00:00:05.000Z",
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 0,
        timestamp: "2025-01-01T00:00:02.000Z",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].durationMs).toBeNull();
  });

  it("contextBytes calculated from toolInputSummary + toolResultText", () => {
    const inputSummary = "echo hello";
    const resultText = "hello";
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        toolInputSummary: inputSummary,
        pairedIndex: 1,
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        toolResultText: resultText,
        pairedIndex: 0,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    const expectedBytes = new TextEncoder().encode(inputSummary).length + new TextEncoder().encode(resultText).length;
    expect(result.interactions[0].contextBytes).toBe(expectedBytes);
  });

  it("contextBytes uses full toolInput when available", () => {
    const toolInput = { file_path: "/tmp/file.md", content: "A".repeat(2000) };
    const resultText = "File created successfully";
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Write",
        toolInput,
        toolInputSummary: "file_path: /tmp/file.md, content: AAAA...",
        pairedIndex: 1,
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Write",
        toolResultText: resultText,
        pairedIndex: 0,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    const expectedBytes =
      new TextEncoder().encode(JSON.stringify(toolInput)).length + new TextEncoder().encode(resultText).length;
    expect(result.interactions[0].contextBytes).toBe(expectedBytes);
    // Should be much larger than just summary + result
    expect(result.interactions[0].contextBytes).toBeGreaterThan(2000);
  });

  it("outcome shows total context bytes, not just result text size", () => {
    const toolInput = { content: "A".repeat(2000) };
    const resultText = "File created successfully";
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Write",
        toolInput,
        toolInputSummary: "content: AAAA...",
        pairedIndex: 1,
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Write",
        toolResultText: resultText,
        pairedIndex: 0,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // Should show ~2KB, not "24B" from the result text
    expect(result.interactions[0].sparseLine).toContain("KB");
  });
});

// ---------------------------------------------------------------------------
// Error entries
// ---------------------------------------------------------------------------

describe("buildSparseIndex — error entries", () => {
  it("standalone error produces 1 agent interaction with hasError=true", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "error",
        isError: true,
        errorMessage: "Something went wrong",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].categories).toEqual(["agent"]);
    expect(result.interactions[0].hasError).toBe(true);
    expect(result.interactions[0].toolName).toBeNull();
    expect(result.stats.totalErrors).toBe(1);
  });

  it("error within 2 entries of a tool_use is associated with that interaction", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: null }),
      makeEntry({ index: 1, type: "error", isError: true, errorMessage: "timeout" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // Should be 1 interaction (tool + associated error)
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].entryIndices).toEqual([0, 1]);
    expect(result.interactions[0].hasError).toBe(true);
  });

  it("error 2 entries after tool_use is still associated", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Write", pairedIndex: null }),
      makeEntry({ index: 1, type: "assistant", text: "attempting..." }),
      makeEntry({ index: 2, type: "error", isError: true, errorMessage: "permission denied" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // The tool_use at index 0 looks ahead up to index 2 (index+1 and index+2)
    // Index 1 is an assistant entry, which will be checked for "error" type — it's not
    // Index 2 is an error entry — it gets associated
    expect(result.interactions[0].entryIndices).toContain(0);
    expect(result.interactions[0].entryIndices).toContain(2);
    expect(result.interactions[0].hasError).toBe(true);
  });

  it("error 3+ entries after tool_use is NOT associated", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: null }),
      makeEntry({ index: 1, type: "assistant", text: "step 1" }),
      makeEntry({ index: 2, type: "assistant", text: "step 2" }),
      makeEntry({ index: 3, type: "error", isError: true, errorMessage: "late error" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // tool_use checks indices 1 and 2 — both are assistant, not error
    // The error at index 3 is not within range of tool_use at index 0
    const toolInteraction = result.interactions[0];
    expect(toolInteraction.entryIndices).not.toContain(3);
    expect(toolInteraction.hasError).toBe(false);

    // The error at index 3 should be its own standalone error interaction
    const errorInteraction = result.interactions.find((i) => i.entryIndices.includes(3));
    expect(errorInteraction).toBeDefined();
    expect(errorInteraction!.hasError).toBe(true);
  });

  it("error already claimed by paired tool_result is not double-counted", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 0,
        isError: true,
        toolResultText: "error output",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].hasError).toBe(true);
    // Only 1 error counted
    expect(result.stats.totalErrors).toBe(1);
  });

  it("error contextBytes from errorMessage", () => {
    const msg = "Connection refused";
    const entries = [makeEntry({ index: 0, type: "error", isError: true, errorMessage: msg })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].contextBytes).toBe(new TextEncoder().encode(msg).length);
  });

  it("error with no errorMessage falls back to text", () => {
    const text = "Some error text";
    const entries = [makeEntry({ index: 0, type: "error", isError: true, errorMessage: null, text })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].contextBytes).toBe(new TextEncoder().encode(text).length);
  });
});

// ---------------------------------------------------------------------------
// Sparse line formatting
// ---------------------------------------------------------------------------

describe("buildSparseIndex — sparse line formatting", () => {
  it("assistant interaction has id, 'agent', 'assistant', and detail", () => {
    const entries = [makeEntry({ index: 0, type: "assistant", text: "I will help." })];
    const result = buildSparseIndex(makeTranscript(entries));

    const line = result.interactions[0].sparseLine;
    expect(line).toContain("#1");
    expect(line).toContain("agent");
    expect(line).toContain("assistant");
    expect(line).toContain("I will help.");
  });

  it("tool_use interaction has '->' outcome separator", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        toolInputSummary: "ls",
        pairedIndex: 1,
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        toolResultText: "output",
        pairedIndex: 0,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    const line = result.interactions[0].sparseLine;
    expect(line).toContain("->");
    expect(line).toContain("ok");
  });

  it("error tool interaction shows 'error' in outcome", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 0,
        isError: true,
        toolResultText: "fail",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].sparseLine).toContain("error");
  });

  it("standalone error has quoted message", () => {
    const entries = [makeEntry({ index: 0, type: "error", isError: true, errorMessage: "bad thing" })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].sparseLine).toContain('"bad thing"');
  });

  it("long text is truncated in sparse line", () => {
    const longText = "A".repeat(200);
    const entries = [makeEntry({ index: 0, type: "assistant", text: longText })];
    const result = buildSparseIndex(makeTranscript(entries));

    // The detail portion is truncated to MAX_DETAIL_CHARS (80), ending with "..."
    expect(result.interactions[0].sparseLine).toContain("...");
    // The full sparse line should be reasonably bounded
    expect(result.interactions[0].sparseLine.length).toBeLessThan(200);
  });

  it("lines array matches interactions array", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "hello" }),
      makeEntry({ index: 1, type: "tool_use", toolName: "Bash", pairedIndex: null }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.lines).toHaveLength(result.interactions.length);
    for (let i = 0; i < result.lines.length; i++) {
      expect(result.lines[i]).toBe(result.interactions[i].sparseLine);
    }
  });

  it("IDs are sequential starting from 1", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "a" }),
      makeEntry({ index: 1, type: "assistant", text: "b" }),
      makeEntry({ index: 2, type: "tool_use", toolName: "Read", pairedIndex: 3 }),
      makeEntry({ index: 3, type: "tool_result", toolName: "Read", pairedIndex: 2 }),
      makeEntry({ index: 4, type: "assistant", text: "c" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // assistant [0,1] merged -> id 1, tool [2,3] -> id 2, assistant [4] -> id 3
    expect(result.interactions.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("environment tool shows 'env' category abbreviation", () => {
    const entries = [makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: null })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].sparseLine).toContain("env");
  });

  it("tool_use with toolInputSummary shows it in parentheses", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        toolInputSummary: "npm test",
        pairedIndex: null,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].sparseLine).toContain("Bash(npm test)");
  });
});

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

describe("buildSparseIndex — stats", () => {
  it("totalInteractions matches interaction count", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "hello" }),
      makeEntry({ index: 1, type: "tool_use", toolName: "Bash", pairedIndex: 2 }),
      makeEntry({ index: 2, type: "tool_result", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({ index: 3, type: "error", isError: true, errorMessage: "oh no" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.stats.totalInteractions).toBe(result.interactions.length);
  });

  it("byCategory counts correct", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "thinking" }),
      makeEntry({ index: 1, type: "tool_use", toolName: "Bash", pairedIndex: 2 }),
      makeEntry({ index: 2, type: "tool_result", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({ index: 3, type: "tool_use", toolName: "my_api", pairedIndex: 4 }),
      makeEntry({ index: 4, type: "tool_result", toolName: "my_api", pairedIndex: 3 }),
      makeEntry({ index: 5, type: "assistant", text: "more thinking" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.stats.byCategory.agent).toBe(2); // two assistant groups
    expect(result.stats.byCategory.environment).toBe(1); // Bash
    expect(result.stats.byCategory.service).toBe(1); // my_api
  });

  it("totalErrors counts interactions with hasError", () => {
    const entries = [
      makeEntry({ index: 0, type: "tool_use", toolName: "Bash", pairedIndex: 1 }),
      makeEntry({ index: 1, type: "tool_result", toolName: "Bash", pairedIndex: 0, isError: true }),
      makeEntry({ index: 2, type: "error", isError: true, errorMessage: "standalone" }),
      makeEntry({ index: 3, type: "assistant", text: "fine" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.stats.totalErrors).toBe(2);
  });

  it("totalDurationMs sums all non-null durations", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_use",
        toolName: "Bash",
        pairedIndex: 1,
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
      makeEntry({
        index: 1,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 0,
        timestamp: "2025-01-01T00:00:01.000Z",
      }),
      makeEntry({
        index: 2,
        type: "tool_use",
        toolName: "Read",
        pairedIndex: 3,
        timestamp: "2025-01-01T00:00:02.000Z",
      }),
      makeEntry({
        index: 3,
        type: "tool_result",
        toolName: "Read",
        pairedIndex: 2,
        timestamp: "2025-01-01T00:00:02.500Z",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // 1000ms + 500ms = 1500ms
    expect(result.stats.totalDurationMs).toBe(1500);
  });

  it("totalDurationMs is 0 when no durations are available", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "hello" }),
      makeEntry({ index: 1, type: "error", isError: true, errorMessage: "err" }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.stats.totalDurationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeline: startMs and wallClockMs
// ---------------------------------------------------------------------------

describe("buildSparseIndex — timeline", () => {
  it("computes startMs from entry timestamps relative to first entry", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "thinking", timestamp: "2025-01-01T00:00:00.000Z" }),
      makeEntry({
        index: 1,
        type: "tool_use",
        toolName: "Bash",
        pairedIndex: 2,
        timestamp: "2025-01-01T00:00:02.000Z",
      }),
      makeEntry({
        index: 2,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 1,
        timestamp: "2025-01-01T00:00:03.000Z",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].startMs).toBe(0); // first entry
    expect(result.interactions[1].startMs).toBe(2000); // 2s after start
    expect(result.interactions[1].durationMs).toBe(1000); // 1s tool duration
  });

  it("fills assistant durationMs from gap to next interaction", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "planning", timestamp: "2025-01-01T00:00:00.000Z" }),
      makeEntry({
        index: 1,
        type: "tool_use",
        toolName: "Read",
        pairedIndex: 2,
        timestamp: "2025-01-01T00:00:03.000Z",
      }),
      makeEntry({
        index: 2,
        type: "tool_result",
        toolName: "Read",
        pairedIndex: 1,
        timestamp: "2025-01-01T00:00:03.500Z",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // Assistant duration filled from gap: 3000ms - 0ms = 3000ms
    expect(result.interactions[0].durationMs).toBe(3000);
  });

  it("does not fill durationMs for last interaction without successor", () => {
    const entries = [makeEntry({ index: 0, type: "assistant", text: "done", timestamp: "2025-01-01T00:00:05.000Z" })];
    const result = buildSparseIndex(makeTranscript(entries));

    // Last interaction, no next interaction to compute gap
    expect(result.interactions[0].durationMs).toBeNull();
  });

  it("computes wallClockMs from last interaction end", () => {
    const entries = [
      makeEntry({ index: 0, type: "assistant", text: "hi", timestamp: "2025-01-01T00:00:00.000Z" }),
      makeEntry({
        index: 1,
        type: "tool_use",
        toolName: "Bash",
        pairedIndex: 2,
        timestamp: "2025-01-01T00:00:02.000Z",
      }),
      makeEntry({
        index: 2,
        type: "tool_result",
        toolName: "Bash",
        pairedIndex: 1,
        timestamp: "2025-01-01T00:00:05.000Z",
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // Last interaction: startMs=2000, durationMs=3000 → wallClock=5000
    expect(result.stats.wallClockMs).toBe(5000);
  });

  it("startMs is null when entries have no timestamps", () => {
    const entries = [makeEntry({ index: 0, type: "assistant", text: "no time", timestamp: "" })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions[0].startMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Standalone / other entry types
// ---------------------------------------------------------------------------

describe("buildSparseIndex — standalone entries", () => {
  it("system entry becomes agent interaction", () => {
    const entries = [makeEntry({ index: 0, type: "system", text: "You are a helpful assistant." })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].categories).toEqual(["agent"]);
  });

  it("user entry becomes agent interaction", () => {
    const entries = [makeEntry({ index: 0, type: "user", text: "Please fix the bug." })];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].categories).toEqual(["agent"]);
  });

  it("orphaned tool_result (no paired tool_use) becomes standalone", () => {
    const entries = [
      makeEntry({
        index: 0,
        type: "tool_result",
        toolName: null,
        toolResultText: "some result",
        pairedIndex: null,
      }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].entryIndices).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Complex mixed transcript
// ---------------------------------------------------------------------------

describe("buildSparseIndex — complex mixed transcript", () => {
  it("processes a realistic multi-step transcript correctly", () => {
    const entries = [
      // System prompt
      makeEntry({ index: 0, type: "system", text: "You are an AI coding assistant." }),
      // User request
      makeEntry({ index: 1, type: "user", text: "Fix the login bug." }),
      // Agent thinks
      makeEntry({ index: 2, type: "assistant", text: "I will look at the login code." }),
      makeEntry({ index: 3, type: "assistant", text: "Let me read the file first." }),
      // Tool use: Read (environment)
      makeEntry({
        index: 4,
        type: "tool_use",
        toolName: "Read",
        toolInputSummary: "src/login.ts",
        pairedIndex: 5,
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
      makeEntry({
        index: 5,
        type: "tool_result",
        toolName: "Read",
        toolResultText: "const login = () => { ... }",
        pairedIndex: 4,
        timestamp: "2025-01-01T00:00:00.100Z",
      }),
      // Agent thinks again
      makeEntry({ index: 6, type: "assistant", text: "I see the issue. The validation is missing." }),
      // Tool use: Edit (environment)
      makeEntry({
        index: 7,
        type: "tool_use",
        toolName: "Edit",
        toolInputSummary: "add validation",
        pairedIndex: 8,
        timestamp: "2025-01-01T00:00:01.000Z",
      }),
      makeEntry({
        index: 8,
        type: "tool_result",
        toolName: "Edit",
        toolResultText: "File edited successfully",
        pairedIndex: 7,
        timestamp: "2025-01-01T00:00:01.050Z",
      }),
      // External API call (service)
      makeEntry({
        index: 9,
        type: "tool_use",
        toolName: "fetch_docs",
        toolInputSummary: "login-api",
        pairedIndex: 10,
      }),
      makeEntry({
        index: 10,
        type: "tool_result",
        toolName: "fetch_docs",
        toolResultText: "API documentation content",
        pairedIndex: 9,
      }),
      // Final assistant message
      makeEntry({ index: 11, type: "assistant", text: "The bug is fixed." }),
    ];
    const result = buildSparseIndex(makeTranscript(entries));

    // Expected interactions:
    // 1: system (agent)
    // 2: user (agent)
    // 3: assistant merged [2,3] (agent)
    // 4: Read tool [4,5] (environment)
    // 5: assistant [6] (agent)
    // 6: Edit tool [7,8] (environment)
    // 7: fetch_docs tool [9,10] (service)
    // 8: assistant [11] (agent)
    expect(result.interactions).toHaveLength(8);

    // Check categories
    expect(result.stats.byCategory.agent).toBe(5); // system + user + 3 assistant groups
    expect(result.stats.byCategory.environment).toBe(2); // Read + Edit
    expect(result.stats.byCategory.service).toBe(1); // fetch_docs

    // Check durations
    expect(result.stats.totalDurationMs).toBe(150); // 100ms + 50ms

    // No errors
    expect(result.stats.totalErrors).toBe(0);

    // Lines count matches
    expect(result.lines).toHaveLength(8);
  });
});
