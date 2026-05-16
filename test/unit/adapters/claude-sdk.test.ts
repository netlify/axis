import { describe, it, expect, beforeEach } from "vitest";
import { createClaudeSdkAdapter } from "../../../src/adapters/claude-sdk.js";
import { getAdapter, _resetAdapterCache } from "../../../src/adapters/registry.js";

describe("ClaudeSdkAdapter", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("has name 'claude-sdk'", () => {
    const adapter = createClaudeSdkAdapter();
    expect(adapter.name).toBe("claude-sdk");
  });

  it("is retrievable from the adapter registry", () => {
    const adapter = getAdapter("claude-sdk");
    expect(adapter.name).toBe("claude-sdk");
  });

  it("requires ANTHROPIC_API_KEY environment variable", () => {
    const adapter = createClaudeSdkAdapter();
    expect(adapter.requiredEnv!()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("provides isolation env with CLAUDE_CONFIG_DIR under home, not workspace", () => {
    const adapter = createClaudeSdkAdapter();
    const env = adapter.isolationEnv!({ workspace: "/tmp/work", home: "/tmp/home" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/home/.claude");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});
