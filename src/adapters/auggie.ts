import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Augment Code (Auggie) via ACP — `auggie --acp`. Auth is session-based:
 * either run `auggie login` once interactively, or set AUGMENT_SESSION_AUTH
 * to a JSON blob obtained from `auggie token print` (CI/headless flow).
 */
export function createAuggieAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "auggie",
    cliCommand: "auggie",
    requiredEnv: () => ["AUGMENT_SESSION_AUTH"],
    buildArgs: () => ["--acp"],
  });
}
