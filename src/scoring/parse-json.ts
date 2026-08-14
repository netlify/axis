/**
 * Extract the JSON verdict from a judge reply that may also contain prose,
 * quoted code, and example objects.
 *
 * Finds every real `{…}` object in the reply and returns the last one that
 * matches the caller's expected shape (`isVerdict`). Judges put their verdict
 * at the end, so "last matching object" is the verdict even when earlier
 * prose quotes code or JSON examples.
 */
export function parseJsonFromText(
  text: string,
  isVerdict?: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: { at: number; value: Record<string, unknown> }[] = [];
  for (const fence of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    const parsed = tryParseObject(fence[1].trim());
    if (parsed) candidates.push({ at: fence.index, value: parsed });
  }
  // Try larger spans first: if a whole object parses, its nested objects are
  // part of it and are skipped as candidates.
  const spans = matchedSpans(text);
  spans.sort((a, b) => b.end - b.start - (a.end - a.start));
  const accepted: { start: number; end: number }[] = [];
  let parseBudget = PARSE_BUDGET;
  for (const span of spans) {
    if (parseBudget <= 0) break;
    if (accepted.some((a) => a.start <= span.start && a.end >= span.end)) continue;
    if (span.end - span.start > parseBudget) continue;
    parseBudget -= span.end - span.start;
    const parsed = tryParseObject(text.slice(span.start, span.end + 1));
    if (parsed) {
      accepted.push(span);
      candidates.push({ at: span.start, value: parsed });
    }
  }
  // Fallback: the extraction this function used historically. Keeps behavior
  // from ever being worse than the old parser (e.g. when an unpaired quote in
  // prose confuses the string-aware scan above).
  if (candidates.length === 0) {
    const greedy = text.match(/\{[\s\S]*\}/);
    if (greedy) {
      const parsed = tryParseObject(greedy[0]);
      if (parsed) candidates.push({ at: greedy.index ?? 0, value: parsed });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  if (isVerdict) {
    for (let c = candidates.length - 1; c >= 0; c -= 1) {
      if (isVerdict(candidates[c].value)) return candidates[c].value;
    }
    return null;
  }
  return candidates.length ? candidates[candidates.length - 1].value : null;
}

/** Max characters JSON.parse may consume in total per reply. */
const PARSE_BUDGET = 8_000_000;
/** Max candidate objects remembered per reply (keeps the most recent). */
const SPAN_LIMIT = 10_000;

function tryParseObject(candidate: string): Record<string, unknown> | null {
  if (!candidate.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Find every `{…}` whose braces genuinely pair up, in one pass. A stack pairs
 * each `}` with its `{`; braces inside string values are ignored; an
 * unmatched brace in prose pairs with nothing and is dropped. Results are
 * kept in a fixed-size ring buffer so pathological inputs stay O(n).
 */
function matchedSpans(text: string): { start: number; end: number }[] {
  const ring: ({ start: number; end: number } | undefined)[] = new Array(SPAN_LIMIT);
  let count = 0;
  const stack: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined) {
        ring[count % SPAN_LIMIT] = { start, end: i };
        count += 1;
      }
    }
  }
  const spans: { start: number; end: number }[] = [];
  const from = Math.max(0, count - SPAN_LIMIT);
  for (let n = from; n < count; n += 1) spans.push(ring[n % SPAN_LIMIT]!);
  return spans;
}
