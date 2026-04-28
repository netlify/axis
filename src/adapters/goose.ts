import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

export function createGooseAdapter(): AgentAdapter {
  return createAcpBasedAdapter({
    name: "goose",
    cliCommand: "goose",
    buildArgs: () => ["acp"],
  });
}
