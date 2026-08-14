/**
 * Extract and parse a JSON object from LLM judge output.
 *
 * Judges are instructed to reply with "ONLY valid JSON on its own line", but
 * in practice they add prose — and when the material being graded contains
 * code, that prose quotes brace-laden snippets (`{ modified, etag }`) or
 * whole fenced JSON examples. A first-`{`-to-last-`}` regex spans from the
 * quoted code to the verdict and captures garbage, so the score is withheld
 * even though a valid verdict is sitting in the reply.
 *
 * Instead: one string-aware pass collects every MATCHED `{…}` span (a stack
 * pairs each close with its open; a lone prose brace never pops, so it
 * poisons nothing). Outermost parseable spans become candidates alongside
 * fenced blocks, and the LAST candidate the caller's schema accepts wins:
 * the reply format puts the verdict at the end, and the schema check stops a
 * quoted example from shadowing a real verdict.
 */
export function parseJsonFromText(
  text: string,
  isVerdict?: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: { at: number; value: Record<string, unknown> }[] = [];
  // Fenced blocks: the fence bounds the object exactly — no brace ambiguity.
  for (const fence of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    const parsed = tryParseObject(fence[1].trim());
    if (parsed) candidates.push({ at: fence.index, value: parsed });
  }
  // Bare objects: outermost parseable matched spans. Larger spans are tried
  // first so a verdict's inner objects never pose as candidates; an
  // unparseable outer span (prose braces around real JSON) lets its inner
  // spans through. The parse budget only bounds adversarial towers of large
  // unparseable spans — legitimate replies never approach it.
  const spans = matchedSpans(text);
  spans.sort((a, b) => b.end - b.start - (a.end - a.start));
  const accepted: { start: number; end: number }[] = [];
  let parseBudget = PARSE_BUDGET;
  for (const span of spans) {
    if (parseBudget <= 0) break;
    if (accepted.some((a) => a.start <= span.start && a.end >= span.end)) continue;
    parseBudget -= span.end - span.start;
    const parsed = tryParseObject(text.slice(span.start, span.end + 1));
    if (parsed) {
      accepted.push(span);
      candidates.push({ at: span.start, value: parsed });
    }
  }
  // Last resort — the original first-{-to-last-} extraction. A stray
  // unpaired quote in prose can corrupt string-parity for the span scan
  // above; this floor guarantees the rewrite is never worse than the
  // behavior it replaced.
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

/** Total characters JSON.parse may be fed across candidate attempts. */
const PARSE_BUDGET = 8_000_000;
/** Matched spans retained per reply, evicting the oldest-CLOSED first. An
 * adversarial reply closing >10k spans after the verdict can evict it —
 * bounded memory at no-worse-than-the-old-parser fidelity. */
const SPAN_LIMIT = 10_000;

function tryParseObject(candidate: string): Record<string, unknown> | null {
  if (!candidate.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — other candidates may still parse
  }
  return null;
}

/** Every `{…}` span whose braces genuinely pair, found in one string-aware
 * pass: push on `{`, pop on `}`. Braces inside JSON string values don't
 * count, and an unmatched open simply never pops. */
function matchedSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
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
        spans.push({ start, end: i });
        if (spans.length > SPAN_LIMIT) spans.shift();
      }
    }
  }
  return spans;
}
