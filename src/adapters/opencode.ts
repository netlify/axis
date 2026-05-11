import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * OpenCode (sst/opencode) via ACP — `opencode acp` starts an ACP server
 * over stdio. OpenCode is BYOK; it reads provider credentials from
 * `opencode auth login` (stored in ~/.local/share/opencode/auth.json) or
 * from common provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).
 *
 * No `requiredEnv` is enforced because OpenCode supports many providers
 * and login-based auth — pre-configure via `opencode auth login` or set
 * the provider key matching your configured model.
 */
export function createOpenCodeAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "opencode",
    cliCommand: "opencode",
    buildArgs: () => ["acp"],
  });
}
