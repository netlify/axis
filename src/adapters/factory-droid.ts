import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Factory Droid via ACP — uses the @yaonyan/droid-acp bridge, which
 * spawns Factory's `droid` CLI underneath. Both must be installed:
 *   npm i -g @yaonyan/droid-acp
 *   curl -fsSL https://app.factory.ai/cli | sh
 *
 * Requires FACTORY_API_KEY.
 */
export function createFactoryDroidAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "factory-droid",
    cliCommand: "droid-acp",
    requiredEnv: () => ["FACTORY_API_KEY"],
  });
}
