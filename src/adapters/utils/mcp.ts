import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "../../types/config.js";

/**
 * Write .mcp.json for Claude Code (project-scoped, placed in workspace root).
 * Claude Code auto-discovers this file when it starts in the workspace directory.
 */
export function writeClaudeMcpConfig(workspace: string, servers: Record<string, McpServerConfig>): void {
  const mcpServers: Record<string, unknown> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "stdio") {
      const entry: Record<string, unknown> = { command: server.command };
      if (server.args?.length) entry.args = server.args;
      if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
      mcpServers[name] = entry;
    } else {
      const entry: Record<string, unknown> = { type: "http", url: server.url };
      if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
      mcpServers[name] = entry;
    }
  }

  fs.writeFileSync(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2) + "\n");
}

/**
 * Write config.toml for Codex (placed in CODEX_HOME).
 * Hand-generates TOML to avoid a library dependency.
 */
export function writeCodexMcpConfig(codexHome: string, servers: Record<string, McpServerConfig>): void {
  const lines: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);

    if (server.type === "stdio") {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args?.length) {
        lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(server.env)) {
          lines.push(`${k} = ${tomlString(v)}`);
        }
      }
    } else {
      lines.push(`type = "http"`);
      lines.push(`url = ${tomlString(server.url)}`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${name}.headers]`);
        for (const [k, v] of Object.entries(server.headers)) {
          lines.push(`${k} = ${tomlString(v)}`);
        }
      }
    }

    lines.push("");
  }

  fs.writeFileSync(path.join(codexHome, "config.toml"), lines.join("\n"));
}

/** Escape a string for TOML (basic string with backslash escaping). */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
