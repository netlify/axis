import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Stakpak (stakpak/agent) via ACP — `stakpak acp`. Stakpak is BYOK: it reads
 * its own STAKPAK_API_KEY plus standard provider keys (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY) depending on the configured profile.
 */
export function createStakpakAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "stakpak",
    cliCommand: "stakpak",
    buildArgs: () => ["acp"],
  });
}
