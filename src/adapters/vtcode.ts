import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * VT Code (vinhnx/VTCode) via ACP — `vtcode acp`. The Rust binary requires
 * the VT_ACP_ENABLED and VT_ACP_ZED_ENABLED feature flags to expose the
 * ACP bridge. Auth is BYOK across many providers (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY,
 * MOONSHOT_API_KEY, OPENROUTER_API_KEY, ZAI_API_KEY) — set whichever
 * matches the model configured in vtcode.toml.
 */
export function createVtCodeAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "vtcode",
    cliCommand: "vtcode",
    isolationEnv: () => ({
      VT_ACP_ENABLED: "1",
      VT_ACP_ZED_ENABLED: "1",
    }),
    buildArgs: () => ["acp"],
  });
}
