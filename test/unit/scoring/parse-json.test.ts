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

  it("survives brace-quoting prose before the verdict (judge grading code answers)", () => {
    // A judge grading code quotes braces in its prose before the verdict.
    const input = `The answer correctly uses store.set(key, value, { onlyIfNew: true }) and checks the returned { modified, etag } object.

{"score": 1, "grades": [{"check": "Uses onlyIfNew", "score": 1}]}`;
    expect(parseJsonFromText(input)).toEqual({
      score: 1,
      grades: [{ check: "Uses onlyIfNew", score: 1 }],
    });
  });

  it("survives trailing prose with braces after the verdict", () => {
    const input = `{"score": 0.5, "grades": []}\n\nNote: the answer's { onlyIfMatch } usage was incorrect.`;
    expect(parseJsonFromText(input)).toEqual({ score: 0.5, grades: [] });
  });

  it("prefers the last object when several parse (verdict comes last)", () => {
    const input = `Working example: {"example": true}\nFinal verdict: {"score": 0.75}`;
    expect(parseJsonFromText(input)).toEqual({ score: 0.75 });
  });

  it("recovers the verdict after a lone unbalanced brace in prose", () => {
    const input = `An unmatched { brace in prose.\n{"score": 1, "grades": []}`;
    expect(parseJsonFromText(input)).toEqual({ score: 1, grades: [] });
  });

  it("ignores braces inside JSON string values", () => {
    const input = `{"rationale": "uses set(k, v, { onlyIfNew: true }) correctly", "score": 1}`;
    expect(parseJsonFromText(input)).toEqual({
      rationale: "uses set(k, v, { onlyIfNew: true }) correctly",
      score: 1,
    });
  });

  it("prefers the last fenced block when the verdict is fenced after quoted code", () => {
    const input =
      'Quoted code:\n```ts\nawait store.set(k, v, { onlyIfNew: true });\n```\n\n```json\n{"score": 1, "grades": []}\n```';
    expect(parseJsonFromText(input)).toEqual({ score: 1, grades: [] });
  });

  it("falls back past an unparseable fenced block to a bare verdict", () => {
    const input = '```ts\nconst x = { a: 1 };\n```\n{"score": 0.25}';
    expect(parseJsonFromText(input)).toEqual({ score: 0.25 });
  });

  it("schema validator picks the verdict over a LATER quoted example", () => {
    const input = `{"score": 8, "grades": [{"check": "a", "score": 8}]}\n\nFor reference, a full-credit grade looks like {"example": true}.`;
    const result = parseJsonFromText(input, (c) => typeof c.score === "number");
    expect(result).toEqual({ score: 8, grades: [{ check: "a", score: 8 }] });
  });

  it("schema validator returns null when nothing matches the shape", () => {
    const input = `{"example": true} and {"another": 1}`;
    expect(parseJsonFromText(input, (c) => typeof c.score === "number")).toBeNull();
  });

  it("a bare verdict AFTER a fenced example wins (position order, not fence priority)", () => {
    const input = '```json\n{"example": true}\n```\nFinal verdict: {"score": 10}';
    expect(parseJsonFromText(input)).toEqual({ score: 10 });
  });

  it("parses a legitimate verdict far larger than any tail window", () => {
    // Deep-eval verdicts carry one audit per interaction; size must never
    // cause withholding.
    const audits = Array.from({ length: 500 }, (_, n) => ({
      interactionId: `i${n}`,
      category: "environment",
      score: 8,
      rationale: "adequate handling of the interaction with reasonable latency and correct output ".repeat(2),
    }));
    const verdict = { audits, necessity: [], patterns: [] };
    const input = `The transcript { was long }.\n\n${JSON.stringify(verdict)}`;
    const result = parseJsonFromText(input, (c) => "audits" in c);
    expect(result).toEqual(verdict);
    expect(JSON.stringify(verdict).length).toBeGreaterThan(100_000);
  });

  it("recovers a large verdict AFTER a brace flood (combined pathological case)", () => {
    const audits = Array.from({ length: 500 }, (_, n) => ({
      interactionId: `i${n}`,
      category: "environment",
      score: 8,
      rationale: "adequate handling of the interaction with reasonable latency and correct output ".repeat(2),
    }));
    const verdict = { audits, necessity: [], patterns: [] };
    const input = `${"{ ".repeat(60_000)}\n${JSON.stringify(verdict)}`;
    const started = Date.now();
    expect(parseJsonFromText(input, (c) => "audits" in c)).toEqual(verdict);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("falls back to greedy extraction when a stray prose quote corrupts string parity", () => {
    const input = 'He said "never\n{"score": 1, "grades": []}';
    expect(parseJsonFromText(input)).toEqual({ score: 1, grades: [] });
  });

  it("bounds work on pathological brace floods and still finds the trailing verdict", () => {
    const flood = "{ ".repeat(60_000);
    const input = `${flood}\n{"score": 3}`;
    const started = Date.now();
    expect(parseJsonFromText(input)).toEqual({ score: 3 });
    expect(Date.now() - started).toBeLessThan(2_000);
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

describe("parseJsonFromText hardening (review follow-ups)", () => {
  it("a {}{}{} pair flood stays fast and keeps the trailing verdict", () => {
    const input = `${"{}".repeat(500_000)}{"score": 7}`;
    const started = Date.now();
    expect(parseJsonFromText(input, (c) => typeof c.score === "number")).toEqual({ score: 7 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a span larger than the parse budget is skipped, smaller later spans still parse", () => {
    const big = `{${"9".repeat(9_000_000)} not json}`;
    const input = `${big}\n{"score": 4}`;
    expect(parseJsonFromText(input)).toEqual({ score: 4 });
  });
});
