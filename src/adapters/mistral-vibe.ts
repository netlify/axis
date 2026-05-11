import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Mistral Vibe via ACP — installs a separate `vibe-acp` binary that
 * speaks ACP directly (the interactive TUI lives in `vibe`).
 * Requires MISTRAL_API_KEY.
 */
export function createMistralVibeAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "mistral-vibe",
    cliCommand: "vibe-acp",
    requiredEnv: () => ["MISTRAL_API_KEY"],
  });
}
