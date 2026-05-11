import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Poolside via ACP — `pool acp`. Requires POOLSIDE_API_KEY (issued from
 * the Poolside console).
 */
export function createPoolsideAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "poolside",
    cliCommand: "pool",
    requiredEnv: () => ["POOLSIDE_API_KEY"],
    buildArgs: () => ["acp"],
  });
}
