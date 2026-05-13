import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeClaudeMcpConfig, writeCodexMcpConfig } from "../../../../src/adapters/utils/mcp.js";
import type { McpServerConfig } from "../../../../src/types/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-mcp-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const stdioServer: McpServerConfig = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@example/mcp-server"],
  env: { API_KEY: "test-key" },
};

const httpServer: McpServerConfig = {
  type: "http",
  url: "https://mcp.example.com/tools",
  headers: { Authorization: "Bearer tok123" },
};

const minimalStdio: McpServerConfig = {
  type: "stdio",
  command: "echo",
};

const minimalHttp: McpServerConfig = {
  type: "http",
  url: "https://mcp.example.com",
};

describe("writeClaudeMcpConfig", () => {
  it("writes .mcp.json with a stdio server", () => {
    writeClaudeMcpConfig(tmpDir, { myServer: stdioServer });

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.myServer).toEqual({
      command: "npx",
      args: ["-y", "@example/mcp-server"],
      env: { API_KEY: "test-key" },
    });
  });

  it("writes .mcp.json with an http server", () => {
    writeClaudeMcpConfig(tmpDir, { remote: httpServer });

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/tools",
      headers: { Authorization: "Bearer tok123" },
    });
  });

  it("writes .mcp.json with mixed servers", () => {
    writeClaudeMcpConfig(tmpDir, { local: stdioServer, remote: httpServer });

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"));
    expect(Object.keys(content.mcpServers)).toEqual(["local", "remote"]);
    expect(content.mcpServers.local.command).toBe("npx");
    expect(content.mcpServers.remote.url).toBe("https://mcp.example.com/tools");
  });

  it("omits empty optional fields", () => {
    writeClaudeMcpConfig(tmpDir, { min: minimalStdio });

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.min).toEqual({ command: "echo" });
    expect(content.mcpServers.min.args).toBeUndefined();
    expect(content.mcpServers.min.env).toBeUndefined();
  });
});

describe("writeCodexMcpConfig", () => {
  it("writes config.toml with a stdio server", () => {
    writeCodexMcpConfig(tmpDir, { myServer: stdioServer });

    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf-8");
    expect(content).toContain("[mcp_servers.myServer]");
    expect(content).toContain('command = "npx"');
    expect(content).toContain('args = ["-y", "@example/mcp-server"]');
    expect(content).toContain("[mcp_servers.myServer.env]");
    expect(content).toContain('API_KEY = "test-key"');
  });

  it("writes config.toml with an http server", () => {
    writeCodexMcpConfig(tmpDir, { remote: httpServer });

    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf-8");
    expect(content).toContain("[mcp_servers.remote]");
    expect(content).toContain('type = "http"');
    expect(content).toContain('url = "https://mcp.example.com/tools"');
    expect(content).toContain("[mcp_servers.remote.headers]");
    expect(content).toContain('Authorization = "Bearer tok123"');
  });

  it("writes config.toml with minimal stdio (no args, no env)", () => {
    writeCodexMcpConfig(tmpDir, { min: minimalStdio });

    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf-8");
    expect(content).toContain("[mcp_servers.min]");
    expect(content).toContain('command = "echo"');
    expect(content).not.toContain("args");
    expect(content).not.toContain("[mcp_servers.min.env]");
  });

  it("writes config.toml with multiple servers", () => {
    writeCodexMcpConfig(tmpDir, { local: minimalStdio, remote: minimalHttp });

    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf-8");
    expect(content).toContain("[mcp_servers.local]");
    expect(content).toContain("[mcp_servers.remote]");
  });

  it("escapes special characters in TOML strings", () => {
    const server: McpServerConfig = {
      type: "stdio",
      command: "echo",
      env: { MSG: 'hello "world"\nnewline' },
    };
    writeCodexMcpConfig(tmpDir, { test: server });

    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf-8");
    expect(content).toContain('MSG = "hello \\"world\\"\\nnewline"');
  });
});
