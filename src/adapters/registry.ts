import type { AgentAdapter } from "../types/agent.js";
import { createClaudeSdkAdapter } from "./claude-sdk.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import { createCodexSdkAdapter } from "./codex-sdk.js";
import { createGeminiAdapter } from "./gemini.js";
import { createGooseAdapter } from "./goose.js";
import { createOpenCodeAdapter } from "./opencode.js";
import { createQwenCodeAdapter } from "./qwen-code.js";
import { createStakpakAdapter } from "./stakpak.js";
import { createBlackboxAdapter } from "./blackbox.js";
import { createFastAgentAdapter } from "./fast-agent.js";
import { createMistralVibeAdapter } from "./mistral-vibe.js";
import { createFactoryDroidAdapter } from "./factory-droid.js";
import { createPoolsideAdapter } from "./poolside.js";
import { createVtCodeAdapter } from "./vtcode.js";
import { createCursorAgentAdapter } from "./cursor-agent.js";
import { createAuggieAdapter } from "./auggie.js";
import { createKimiAdapter } from "./kimi.js";
import { createOpenHandsAdapter } from "./openhands.js";
import { createClineAdapter } from "./cline.js";
import { createKiroCliAdapter } from "./kiro-cli.js";
import { createKiloAdapter } from "./kilo.js";
import { createQoderAdapter } from "./qoder.js";
import { createCopilotAdapter } from "./copilot.js";

const BUILTIN_FACTORIES: Record<string, () => AgentAdapter> = {
  "claude-sdk": createClaudeSdkAdapter,
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
  "codex-sdk": createCodexSdkAdapter,
  gemini: createGeminiAdapter,
  goose: createGooseAdapter,
  opencode: createOpenCodeAdapter,
  "qwen-code": createQwenCodeAdapter,
  stakpak: createStakpakAdapter,
  blackbox: createBlackboxAdapter,
  "fast-agent": createFastAgentAdapter,
  "mistral-vibe": createMistralVibeAdapter,
  "factory-droid": createFactoryDroidAdapter,
  poolside: createPoolsideAdapter,
  vtcode: createVtCodeAdapter,
  "cursor-agent": createCursorAgentAdapter,
  auggie: createAuggieAdapter,
  kimi: createKimiAdapter,
  openhands: createOpenHandsAdapter,
  cline: createClineAdapter,
  "kiro-cli": createKiroCliAdapter,
  kilo: createKiloAdapter,
  qoder: createQoderAdapter,
  copilot: createCopilotAdapter,
};

const instanceCache = new Map<string, AgentAdapter>();

export function getAdapter(adapterName: string): AgentAdapter {
  const cached = instanceCache.get(adapterName);
  if (cached) return cached;

  const factory = BUILTIN_FACTORIES[adapterName];
  if (!factory) {
    throw new Error(
      `Unknown agent: "${adapterName}". Built-in: ${getBuiltinAdapterNames().join(", ")}. ` +
        `Register custom agents via the "adapters" config field or registerAdapter().`,
    );
  }

  const instance = factory();
  instanceCache.set(adapterName, instance);
  return instance;
}

/** Names of all built-in agent adapters. */
export function getBuiltinAdapterNames(): string[] {
  return Object.keys(BUILTIN_FACTORIES);
}

/** Register a custom adapter by name. */
export function registerAdapter(name: string, adapter: AgentAdapter): void {
  instanceCache.set(name, adapter);
}

/** Reset the instance cache. For testing only. */
export function _resetAdapterCache(): void {
  instanceCache.clear();
}
