import type { ExtractedUrl } from "./types.js";

/** Match HTTP(S) URLs in arbitrary text. */
const URL_REGEX = /https?:\/\/[^\s"'<>)\]},]+/gi;

/**
 * Extract the domain from a URL string. Returns null on parse failure.
 */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract URLs from a string. Returns deduplicated URLs with parsed domains.
 */
export function extractUrls(text: string): ExtractedUrl[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];

  const seen = new Set<string>();
  const results: ExtractedUrl[] = [];

  for (const url of matches) {
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, domain: extractDomain(url) });
  }

  return results;
}
