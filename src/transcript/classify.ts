import type { ExtractedUrl } from "./types.js";

/** Tool names that are known to make network requests. */
const NETWORK_TOOL_NAMES = new Set([
  "WebFetch",
  "Fetch",
  "web_fetch",
  "WebSearch",
  "web_search",
  "mcp_fetch",
  "http_request",
  "curl",
  "wget",
  "fetch",
]);

/** Prefixes that indicate MCP-proxied tools (often network-related). */
const NETWORK_TOOL_PREFIXES = ["mcp__"];

/**
 * Determine if a tool call represents a network-related action.
 * Uses tool name matching and URL presence in tool input.
 */
export function isNetworkCall(toolName: string | null, urls: ExtractedUrl[]): boolean {
  if (toolName) {
    if (NETWORK_TOOL_NAMES.has(toolName)) return true;
    for (const prefix of NETWORK_TOOL_PREFIXES) {
      if (toolName.startsWith(prefix)) return true;
    }
  }

  // If the tool input contains URLs, it's likely a network call
  return urls.length > 0;
}
