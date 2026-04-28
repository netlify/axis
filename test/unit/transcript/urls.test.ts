import { describe, it, expect } from "vitest";
import { extractUrls, extractDomain } from "../../../src/transcript/urls.js";

describe("extractDomain", () => {
  it("extracts domain from a simple URL", () => {
    expect(extractDomain("https://example.com/path")).toBe("example.com");
  });

  it("extracts domain with port", () => {
    expect(extractDomain("http://localhost:3000/api")).toBe("localhost");
  });

  it("extracts subdomain", () => {
    expect(extractDomain("https://api.github.com/repos")).toBe("api.github.com");
  });

  it("returns null for invalid URL", () => {
    expect(extractDomain("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractDomain("")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("returns empty array for text with no URLs", () => {
    expect(extractUrls("no urls here")).toEqual([]);
  });

  it("extracts a single URL", () => {
    const result = extractUrls("visit https://example.com for more");
    expect(result).toEqual([{ url: "https://example.com", domain: "example.com" }]);
  });

  it("extracts multiple URLs", () => {
    const result = extractUrls("check https://a.com and http://b.com/path");
    expect(result).toHaveLength(2);
    expect(result[0].domain).toBe("a.com");
    expect(result[1].domain).toBe("b.com");
  });

  it("deduplicates identical URLs", () => {
    const result = extractUrls("https://example.com and https://example.com again");
    expect(result).toHaveLength(1);
  });

  it("handles URLs with query strings", () => {
    const result = extractUrls("fetch https://api.example.com/data?key=value&limit=10");
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://api.example.com/data?key=value&limit=10");
    expect(result[0].domain).toBe("api.example.com");
  });

  it("stops at whitespace and delimiters", () => {
    const result = extractUrls('"https://example.com/path" in quotes');
    expect(result[0].url).toBe("https://example.com/path");
  });

  it("handles URLs in JSON-like content", () => {
    const result = extractUrls('{"url": "https://example.com/api"}');
    expect(result[0].url).toBe("https://example.com/api");
  });

  it("returns empty array for empty string", () => {
    expect(extractUrls("")).toEqual([]);
  });
});
