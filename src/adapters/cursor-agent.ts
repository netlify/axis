import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * Cursor CLI via ACP — the binary is literally named `agent` (installed
 * to ~/.local/bin/agent by the Cursor installer). `agent acp` starts an
 * ACP session over stdio.
 *
 * Cursor honors CURSOR_API_KEY for headless auth; alternatively users can
 * run `agent login` once interactively.
 */
export function createCursorAgentAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "cursor-agent",
    cliCommand: "agent",
    requiredEnv: () => ["CURSOR_API_KEY"],
    buildArgs: () => ["acp"],
  });
}
