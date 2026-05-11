import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Cline CLI via ACP — `cline --acp`. Cline auth is login-gated through
 * app.cline.bot (`cline auth`); pre-authenticate once before headless
 * use. No env var is enforced.
 */
export function createClineAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "cline",
    cliCommand: "cline",
    buildArgs: () => ["--acp"],
  });
}
