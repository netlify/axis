import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * fast-agent (fast-agent.ai) via ACP — installs as a separate
 * `fast-agent-acp` binary that speaks ACP directly. fast-agent is BYOK
 * across multiple providers; configure the appropriate provider env var
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) for your model selection.
 */
export function createFastAgentAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "fast-agent",
    cliCommand: "fast-agent-acp",
  });
}
