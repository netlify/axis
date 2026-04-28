import type { AgentAdapter } from "../types/agent.js";
import { createClaudeSdkAdapter } from "./claude-sdk.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import { createGeminiAdapter } from "./gemini.js";
import { createGeminiAcpAdapter } from "./gemini-acp.js";
import { createGooseAdapter } from "./goose.js";

const BUILTIN_FACTORIES: Record<string, () => AgentAdapter> = {
  "claude-sdk": createClaudeSdkAdapter,
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
  gemini: createGeminiAdapter,
  "gemini-acp": createGeminiAcpAdapter,
  goose: createGooseAdapter,
};

const instanceCache = new Map<string, AgentAdapter>();

export function getAdapter(adapterName: string): AgentAdapter {
  const cached = instanceCache.get(adapterName);
  if (cached) return cached;

  const factory = BUILTIN_FACTORIES[adapterName];
  if (!factory) {
    throw new Error(
      `Unknown adapter: "${adapterName}". Built-in: claude-sdk, claude-code, codex, gemini, gemini-acp, goose. ` +
        `Register custom adapters via the "adapters" config field or registerAdapter().`,
    );
  }

  const instance = factory();
  instanceCache.set(adapterName, instance);
  return instance;
}

/** Register a custom adapter by name. */
export function registerAdapter(name: string, adapter: AgentAdapter): void {
  instanceCache.set(name, adapter);
}

/** Reset the instance cache. For testing only. */
export function _resetAdapterCache(): void {
  instanceCache.clear();
}
