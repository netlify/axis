import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * SDK-based Codex adapter. Uses the @zed-industries/codex-acp bridge to
 * communicate with OpenAI's Codex CLI via the Agent Client Protocol over
 * stdio. The bridge spawns Codex internally and translates between ACP
 * and Codex's native protocol.
 *
 * Named `codex-sdk` (parallel to `claude-sdk`) to distinguish from the
 * NDJSON-mode `codex` adapter.
 */
export function createCodexSdkAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "codex-sdk",
    cliCommand: "codex-acp",
    requiredEnv: () => ["OPENAI_API_KEY"],
  });
}
