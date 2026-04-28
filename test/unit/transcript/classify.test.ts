import { describe, it, expect } from "vitest";
import { isNetworkCall } from "../../../src/transcript/classify.js";

describe("isNetworkCall", () => {
  it("returns true for WebFetch", () => {
    expect(isNetworkCall("WebFetch", [])).toBe(true);
  });

  it("returns true for web_search", () => {
    expect(isNetworkCall("web_search", [])).toBe(true);
  });

  it("returns true for mcp_fetch", () => {
    expect(isNetworkCall("mcp_fetch", [])).toBe(true);
  });

  it("returns true for MCP-prefixed tools", () => {
    expect(isNetworkCall("mcp__my_server__fetch", [])).toBe(true);
  });

  it("returns true when URLs are present even with unknown tool", () => {
    expect(isNetworkCall("custom_tool", [{ url: "https://example.com", domain: "example.com" }])).toBe(true);
  });

  it("returns false for non-network tools without URLs", () => {
    expect(isNetworkCall("Bash", [])).toBe(false);
  });

  it("returns false for Read tool without URLs", () => {
    expect(isNetworkCall("Read", [])).toBe(false);
  });

  it("returns false for null tool name with no URLs", () => {
    expect(isNetworkCall(null, [])).toBe(false);
  });
});
