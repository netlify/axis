import { describe, it, expect } from "vitest";
import { sanitizeModelForName, buildAgentBaseName } from "../../../src/runner/agent-name.js";

describe("sanitizeModelForName", () => {
  it("leaves plain model names untouched", () => {
    expect(sanitizeModelForName("claude-3.5-sonnet")).toBe("claude-3.5-sonnet");
    expect(sanitizeModelForName("opus")).toBe("opus");
    expect(sanitizeModelForName("o4-mini")).toBe("o4-mini");
  });

  it("collapses provider slashes to hyphens", () => {
    expect(sanitizeModelForName("anthropic/claude-3.5-sonnet")).toBe("anthropic-claude-3.5-sonnet");
    expect(sanitizeModelForName("openrouter/anthropic/claude-3.5-sonnet")).toBe(
      "openrouter-anthropic-claude-3.5-sonnet",
    );
  });

  it("collapses runs of unsafe characters and trims edges", () => {
    expect(sanitizeModelForName("a//b")).toBe("a-b");
    expect(sanitizeModelForName("/leading/trailing/")).toBe("leading-trailing");
    expect(sanitizeModelForName("has spaces")).toBe("has-spaces");
    expect(sanitizeModelForName("pipe|inside")).toBe("pipe-inside");
  });
});

describe("buildAgentBaseName", () => {
  it("returns the bare agent when no model is set", () => {
    expect(buildAgentBaseName("claude-code")).toBe("claude-code");
  });

  it("joins agent and sanitized model with a pipe", () => {
    expect(buildAgentBaseName("claude-code", "opus")).toBe("claude-code|opus");
    expect(buildAgentBaseName("openrouter", "anthropic/claude-3.5-sonnet")).toBe(
      "openrouter|anthropic-claude-3.5-sonnet",
    );
  });

  it("keeps the pipe split able to recover the base agent", () => {
    const name = buildAgentBaseName("openrouter", "anthropic/claude-3.5-sonnet");
    expect(name.split("|")[0]).toBe("openrouter");
  });
});
