import { describe, it, expect } from "vitest";
import { parseJsonFromText } from "../../../src/scoring/parse-json.js";

describe("parseJsonFromText", () => {
  it("parses valid JSON object", () => {
    const result = parseJsonFromText('{"key": "value", "num": 42}');
    expect(result).toEqual({ key: "value", num: 42 });
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseJsonFromText('Here is the result: {"score": 0.9} and more text.');
    expect(result).toEqual({ score: 0.9 });
  });

  it("extracts JSON from markdown code fences", () => {
    const result = parseJsonFromText('```json\n{"score": 0.85, "rationale": "good"}\n```');
    expect(result).toEqual({ score: 0.85, rationale: "good" });
  });

  it("returns null for empty string", () => {
    expect(parseJsonFromText("")).toBeNull();
  });

  it("returns null when no JSON object is present", () => {
    expect(parseJsonFromText("This is just plain text with no JSON.")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonFromText("{broken: json, missing quotes}")).toBeNull();
  });

  it("matches outermost braces for nested JSON objects", () => {
    const input = '{"outer": {"inner": {"deep": 1}}, "other": 2}';
    const result = parseJsonFromText(input);
    expect(result).toEqual({ outer: { inner: { deep: 1 } }, other: 2 });
  });

  it("handles JSON with arrays inside", () => {
    const result = parseJsonFromText('{"items": [1, 2, 3]}');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("returns null for a bare JSON array (no surrounding object)", () => {
    expect(parseJsonFromText("[1, 2, 3]")).toBeNull();
  });

  it("handles multiline JSON wrapped in fences", () => {
    const input = `Some explanation:
\`\`\`
{
  "flaggedInteractions": [],
  "patterns": []
}
\`\`\`
End.`;
    const result = parseJsonFromText(input);
    expect(result).toEqual({ flaggedInteractions: [], patterns: [] });
  });
});
