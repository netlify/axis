import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * AWS Kiro CLI via ACP — `kiro-cli acp`. Auth is AWS-managed (kiro.dev
 * sign-in writes ~/.kiro/); pre-authenticate once before headless use.
 * No env var is enforced.
 */
export function createKiroCliAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "kiro-cli",
    cliCommand: "kiro-cli",
    buildArgs: () => ["acp"],
  });
}
