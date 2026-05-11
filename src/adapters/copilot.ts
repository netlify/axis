import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * GitHub Copilot CLI via ACP — `copilot --acp` (stdio is inferred). Copilot
 * authenticates via GitHub credentials and reads, in precedence order,
 * COPILOT_GITHUB_TOKEN → GH_TOKEN → GITHUB_TOKEN for headless use.
 * COPILOT_OFFLINE gates server contact; COPILOT_PROVIDER_BASE_URL plus
 * COPILOT_PROVIDER_API_KEY enable BYOK against a custom LLM provider.
 * Interactive sign-in is `copilot auth login`.
 */
export function createCopilotAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "copilot",
    cliCommand: "copilot",
    buildArgs: () => ["--acp"],
  });
}
