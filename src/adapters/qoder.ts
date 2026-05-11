import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Qoder CLI via ACP — `qodercli --acp`. Requires QODER_PERSONAL_ACCESS_TOKEN
 * (alternatively, run `qodercli /login` once interactively).
 */
export function createQoderAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "qoder",
    cliCommand: "qodercli",
    requiredEnv: () => ["QODER_PERSONAL_ACCESS_TOKEN"],
    buildArgs: () => ["--acp"],
  });
}
