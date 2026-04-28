import { describe, it, expect } from "vitest";
import { normalizeTranscript } from "../../../src/transcript/normalize.js";
import type { TranscriptEntry } from "../../../src/types/agent.js";

function entry(type: TranscriptEntry["type"], content: Record<string, unknown>): TranscriptEntry {
  return { type, timestamp: new Date().toISOString(), content };
}

describe("normalizeTranscript", () => {
  it("returns empty transcript for empty input", () => {
    const result = normalizeTranscript([]);
    expect(result.entries).toEqual([]);
    expect(result.toolUseCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.toolNames).toEqual([]);
    expect(result.domains).toEqual([]);
  });

  it("normalizes a mixed transcript", () => {
    const transcript: TranscriptEntry[] = [
      entry("assistant", { text: "I'll check that." }),
      entry("tool_use", { tool_name: "Bash", tool_id: "b1", parameters: { command: "ls" } }),
      entry("tool_result", { tool_id: "b1", output: "file1.txt" }),
      entry("error", { message: "Something failed" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries).toHaveLength(4);
    expect(result.toolUseCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.toolNames).toEqual(["Bash"]);
  });

  it("classifies entry types correctly", () => {
    const transcript: TranscriptEntry[] = [
      entry("assistant", { text: "thinking" }),
      entry("tool_use", { tool_name: "Read", parameters: { file_path: "/foo" } }),
      entry("tool_result", { output: "contents" }),
      entry("error", { error: "fail" }),
      entry("system", { text: "init" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].isProductive).toBe(true);
    expect(result.entries[1].isProductive).toBe(true);
    expect(result.entries[2].isProductive).toBe(false);
    expect(result.entries[3].isError).toBe(true);
    expect(result.entries[3].isProductive).toBe(false);
    expect(result.entries[4].isProductive).toBe(false);
  });

  it("extracts URLs and classifies network calls", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", {
        tool_name: "WebFetch",
        parameters: { url: "https://example.com/api/data" },
      }),
      entry("tool_result", { output: "response data" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].isNetworkCall).toBe(true);
    expect(result.entries[0].urls).toHaveLength(1);
    expect(result.entries[0].urls[0].domain).toBe("example.com");
    expect(result.domains).toEqual(["example.com"]);
  });

  it("re-classifies Claude Code assistant entries with tool_use as tool_use", () => {
    const transcript: TranscriptEntry[] = [
      entry("assistant", {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "WebFetch", id: "toolu_1", input: { url: "https://example.com/api" } }],
        },
      }),
      entry("tool_result", {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "response data" }],
        },
      }),
    ];

    const result = normalizeTranscript(transcript);

    // Should be re-classified as tool_use
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].toolName).toBe("WebFetch");
    expect(result.entries[0].isNetworkCall).toBe(true);
    expect(result.entries[0].urls).toHaveLength(1);
    expect(result.entries[0].urls[0].domain).toBe("example.com");

    // Should pair with the tool_result
    expect(result.entries[0].pairedIndex).toBe(1);
    expect(result.entries[1].pairedIndex).toBe(0);

    // Aggregate should reflect the tool use
    expect(result.toolUseCount).toBe(1);
    expect(result.pairedToolCount).toBe(1);
    expect(result.toolNames).toEqual(["WebFetch"]);
    expect(result.domains).toEqual(["example.com"]);
  });

  it("does not re-classify plain assistant entries", () => {
    const transcript: TranscriptEntry[] = [entry("assistant", { text: "Just some text" })];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].type).toBe("assistant");
    expect(result.entries[0].toolName).toBeNull();
    expect(result.entries[0].isNetworkCall).toBe(false);
    expect(result.toolUseCount).toBe(0);
  });

  it("computes type counts", () => {
    const transcript: TranscriptEntry[] = [
      entry("assistant", { text: "a" }),
      entry("assistant", { text: "b" }),
      entry("tool_use", { tool_name: "X" }),
      entry("error", { error: "e" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.typeCounts["assistant"]).toBe(2);
    expect(result.typeCounts["tool_use"]).toBe(1);
    expect(result.typeCounts["error"]).toBe(1);
  });

  it("collects unique tool names", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { tool_name: "Bash" }),
      entry("tool_use", { tool_name: "Read" }),
      entry("tool_use", { tool_name: "Bash" }),
    ];

    const result = normalizeTranscript(transcript);
    expect(result.toolNames).toEqual(["Bash", "Read"]);
  });
});

describe("tool pairing", () => {
  it("pairs by toolId (Gemini style)", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { tool_name: "Bash", tool_id: "t1", parameters: { command: "ls" } }),
      entry("tool_result", { tool_id: "t1", output: "files" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].pairedIndex).toBe(1);
    expect(result.entries[1].pairedIndex).toBe(0);
    expect(result.pairedToolCount).toBe(1);
  });

  it("pairs positionally when no toolId", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { name: "read_file" }),
      entry("tool_result", { text: "file contents" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].pairedIndex).toBe(1);
    expect(result.entries[1].pairedIndex).toBe(0);
  });

  it("pairs multiple tools in sequence", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { name: "read" }),
      entry("tool_result", { text: "data1" }),
      entry("tool_use", { name: "write" }),
      entry("tool_result", { text: "ok" }),
    ];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].pairedIndex).toBe(1);
    expect(result.entries[1].pairedIndex).toBe(0);
    expect(result.entries[2].pairedIndex).toBe(3);
    expect(result.entries[3].pairedIndex).toBe(2);
  });

  it("handles unpaired tool_use (no result follows)", () => {
    const transcript: TranscriptEntry[] = [entry("tool_use", { name: "deploy" }), entry("error", { error: "timeout" })];

    const result = normalizeTranscript(transcript);

    expect(result.entries[0].pairedIndex).toBeNull();
    expect(result.pairedToolCount).toBe(0);
  });

  it("does not pair across another tool_use", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { name: "read" }),
      entry("tool_use", { name: "write" }),
      entry("tool_result", { text: "result" }),
    ];

    const result = normalizeTranscript(transcript);

    // First tool_use should NOT pair with the tool_result (blocked by second tool_use)
    expect(result.entries[0].pairedIndex).toBeNull();
    // Second tool_use pairs with the tool_result
    expect(result.entries[1].pairedIndex).toBe(2);
    expect(result.entries[2].pairedIndex).toBe(1);
  });

  it("prefers toolId pairing over positional", () => {
    const transcript: TranscriptEntry[] = [
      entry("tool_use", { tool_name: "A", tool_id: "id-1" }),
      entry("tool_use", { tool_name: "B", tool_id: "id-2" }),
      entry("tool_result", { tool_id: "id-2", output: "result-b" }),
      entry("tool_result", { tool_id: "id-1", output: "result-a" }),
    ];

    const result = normalizeTranscript(transcript);

    // ID-based pairing should cross positions
    expect(result.entries[0].pairedIndex).toBe(3); // A -> result-a
    expect(result.entries[1].pairedIndex).toBe(2); // B -> result-b
  });
});
