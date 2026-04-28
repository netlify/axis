import { describe, it, expect, beforeEach } from "vitest";
import { createGeminiAcpAdapter } from "../../../src/adapters/gemini-acp.js";
import { getAdapter, _resetAdapterCache } from "../../../src/adapters/registry.js";

describe("GeminiAcpAdapter", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("has name 'gemini-acp'", () => {
    const adapter = createGeminiAcpAdapter();
    expect(adapter.name).toBe("gemini-acp");
  });

  it("is retrievable from the adapter registry", () => {
    const adapter = getAdapter("gemini-acp");
    expect(adapter.name).toBe("gemini-acp");
  });

  it("requires GEMINI_API_KEY environment variable", () => {
    const adapter = createGeminiAcpAdapter();
    expect(adapter.requiredEnv!()).toEqual(["GEMINI_API_KEY"]);
  });

  it("provides isolation env with GEMINI_CLI_HOME", () => {
    const adapter = createGeminiAcpAdapter();
    const env = adapter.isolationEnv!("/tmp/workspace");
    expect(env.GEMINI_CLI_HOME).toBe("/tmp/workspace/.gemini");
    expect(env.GEMINI_TELEMETRY_ENABLED).toBe("false");
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("");
  });
});
