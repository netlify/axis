/**
 * Extract and parse the first JSON object from text.
 * Handles LLM output that wraps JSON in markdown fences or surrounding text.
 */
export function parseJsonFromText(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}
