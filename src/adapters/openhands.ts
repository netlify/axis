import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * OpenHands via ACP — `openhands acp`. OpenHands is BYOK and reads LLM
 * credentials from ~/.openhands/settings.json; pre-configure once with
 * `openhands /settings` before headless use. No env var is enforced.
 */
export function createOpenHandsAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "openhands",
    cliCommand: "openhands",
    buildArgs: () => ["acp"],
  });
}
