import type { ScenarioInput } from "../dist/index.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants(
  {
    key: "configure-mcp",
    name: "Configure a shared MCP server",

    setup: [{ action: "run_script", command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/configure-mcp/." .' }],

    prompt:
      'An AXIS project already exists in this directory. Modify `axis.config.json` so that all agents have access to a filesystem MCP server. The server should run as a stdio process using the command `npx` with args `["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`. The server name should be `fs`. Place the configuration at the right level in the config so it is shared across all agents (not duplicated per agent). Do not modify any other field in the config.',

    judge: [
      { check: "`axis.config.json` still parses as valid JSON", weight: 0.1 },
      {
        check: "An `mcp_servers` field exists at the TOP LEVEL of the config (not inside any agent block)",
        weight: 0.25,
      },
      { check: '`mcp_servers` contains a key `fs` with `type: "stdio"`', weight: 0.2 },
      {
        check:
          'The `fs` server\'s `command` is `npx` and `args` is exactly `["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`',
        weight: 0.25,
      },
      { check: "The original `scenarios` and `agents` fields are preserved unchanged", weight: 0.2 },
    ],
  },
  {
    docsPage: "https://axis.run/configuration",
  },
) satisfies ScenarioInput;
