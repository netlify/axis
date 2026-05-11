import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Kilo Code via ACP — `kilo acp`. Auth is interactive (`kilo /connect`);
 * pre-authenticate once before headless use. No env var is enforced.
 */
export function createKiloAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "kilo",
    cliCommand: "kilo",
    buildArgs: () => ["acp"],
  });
}
