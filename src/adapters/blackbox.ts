import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Blackbox AI CLI via ACP — `blackbox --experimental-acp`. Requires
 * BLACKBOX_API_KEY for headless authentication.
 */
export function createBlackboxAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "blackbox",
    cliCommand: "blackbox",
    requiredEnv: () => ["BLACKBOX_API_KEY"],
    buildArgs: () => ["--experimental-acp"],
  });
}
