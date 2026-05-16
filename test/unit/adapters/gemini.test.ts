import { describe, it, expect, beforeEach } from "vitest";
import { createGeminiAdapter } from "../../../src/adapters/gemini.js";
import { getAdapter, _resetAdapterCache } from "../../../src/adapters/registry.js";

describe("GeminiAdapter", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("has name 'gemini'", () => {
    const adapter = createGeminiAdapter();
    expect(adapter.name).toBe("gemini");
  });

  it("is retrievable from the adapter registry", () => {
    const adapter = getAdapter("gemini");
    expect(adapter.name).toBe("gemini");
  });

  it("requires GEMINI_API_KEY environment variable", () => {
    const adapter = createGeminiAdapter();
    expect(adapter.requiredEnv!()).toEqual(["GEMINI_API_KEY"]);
  });

  it("provides isolation env with GEMINI_CLI_HOME under home, not workspace", () => {
    const adapter = createGeminiAdapter();
    const env = adapter.isolationEnv!({ workspace: "/tmp/work", home: "/tmp/home" });
    expect(env.GEMINI_CLI_HOME).toBe("/tmp/home/.gemini");
    expect(env.GEMINI_TELEMETRY_ENABLED).toBe("false");
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("");
  });
});
