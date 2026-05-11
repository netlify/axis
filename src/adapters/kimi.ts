import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Moonshot Kimi CLI via ACP — `kimi acp`. Kimi's primary auth flow is OAuth
 * (`kimi /login` writes ~/.kimi/config.toml). When the openai_legacy /
 * openai_responses providers are configured, Kimi also reads OPENAI_API_KEY
 * (which overrides the config file — see kimi-cli issue #1165).
 */
export function createKimiAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "kimi",
    cliCommand: "kimi",
    buildArgs: () => ["acp"],
  });
}
