import { describe, it, expect } from "vitest";
import { categorizeInteraction } from "../../../src/transcript/categorize.js";

describe("categorizeInteraction", () => {
  // --- Agent entries (by type) ---

  it("classifies assistant entries as agent", () => {
    expect(categorizeInteraction("assistant", null)).toEqual(["agent"]);
  });

  it("classifies system entries as agent", () => {
    expect(categorizeInteraction("system", null)).toEqual(["agent"]);
  });

  it("classifies user entries as agent", () => {
    expect(categorizeInteraction("user", null)).toEqual(["agent"]);
  });

  it("classifies error entries as agent", () => {
    expect(categorizeInteraction("error", null)).toEqual(["agent"]);
  });

  // --- Environment tools ---

  it("classifies Bash as environment", () => {
    expect(categorizeInteraction("tool_use", "Bash")).toEqual(["environment"]);
  });

  it("classifies Read as environment", () => {
    expect(categorizeInteraction("tool_use", "Read")).toEqual(["environment"]);
  });

  it("classifies Write as environment", () => {
    expect(categorizeInteraction("tool_use", "Write")).toEqual(["environment"]);
  });

  it("classifies Edit as environment", () => {
    expect(categorizeInteraction("tool_use", "Edit")).toEqual(["environment"]);
  });

  it("classifies Glob as environment", () => {
    expect(categorizeInteraction("tool_use", "Glob")).toEqual(["environment"]);
  });

  it("classifies Grep as environment", () => {
    expect(categorizeInteraction("tool_use", "Grep")).toEqual(["environment"]);
  });

  it("classifies git as environment", () => {
    expect(categorizeInteraction("tool_use", "git")).toEqual(["environment"]);
  });

  it("classifies npm as environment", () => {
    expect(categorizeInteraction("tool_use", "npm")).toEqual(["environment"]);
  });

  it("is case-insensitive for environment tools", () => {
    expect(categorizeInteraction("tool_use", "BASH")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "read")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "GIT")).toEqual(["environment"]);
  });

  it("classifies file_ prefixed tools as environment", () => {
    expect(categorizeInteraction("tool_use", "file_read")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "file_write")).toEqual(["environment"]);
  });

  it("classifies fs_ prefixed tools as environment", () => {
    expect(categorizeInteraction("tool_use", "fs_read")).toEqual(["environment"]);
  });

  it("classifies mcp__filesystem__ prefixed tools as environment", () => {
    expect(categorizeInteraction("tool_use", "mcp__filesystem__read_file")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "mcp__filesystem__write_file")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "mcp__filesystem__list_directory")).toEqual(["environment"]);
  });

  // --- Agent tools (tool_use entries that are agent-internal) ---

  it("classifies ToolSearch as agent", () => {
    expect(categorizeInteraction("tool_use", "ToolSearch")).toEqual(["agent"]);
  });

  it("classifies Task as agent", () => {
    expect(categorizeInteraction("tool_use", "Task")).toEqual(["agent"]);
  });

  it("classifies TaskCreate as agent", () => {
    expect(categorizeInteraction("tool_use", "TaskCreate")).toEqual(["agent"]);
  });

  it("classifies TaskUpdate as agent", () => {
    expect(categorizeInteraction("tool_use", "TaskUpdate")).toEqual(["agent"]);
  });

  it("classifies TodoWrite as agent", () => {
    expect(categorizeInteraction("tool_use", "TodoWrite")).toEqual(["agent"]);
  });

  it("classifies TodoRead as agent", () => {
    expect(categorizeInteraction("tool_use", "TodoRead")).toEqual(["agent"]);
  });

  it("classifies EnterPlanMode as agent", () => {
    expect(categorizeInteraction("tool_use", "EnterPlanMode")).toEqual(["agent"]);
  });

  it("classifies ExitPlanMode as agent", () => {
    expect(categorizeInteraction("tool_use", "ExitPlanMode")).toEqual(["agent"]);
  });

  it("classifies AskUserQuestion as agent", () => {
    expect(categorizeInteraction("tool_use", "AskUserQuestion")).toEqual(["agent"]);
  });

  it("classifies AskFollowupQuestion as agent", () => {
    expect(categorizeInteraction("tool_use", "AskFollowupQuestion")).toEqual(["agent"]);
  });

  it("classifies Skill as agent", () => {
    expect(categorizeInteraction("tool_use", "Skill")).toEqual(["agent"]);
  });

  it("is case-insensitive for agent tools", () => {
    expect(categorizeInteraction("tool_use", "toolsearch")).toEqual(["agent"]);
    expect(categorizeInteraction("tool_use", "TOOLSEARCH")).toEqual(["agent"]);
    expect(categorizeInteraction("tool_use", "taskcreate")).toEqual(["agent"]);
  });

  // --- Agent-internal path overrides ---

  it("classifies Read of .claude/ path as agent", () => {
    expect(
      categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: .claude/skills/test-skill/SKILL.md" }),
    ).toEqual(["agent"]);
  });

  it("classifies Write to .claude/ path as agent", () => {
    expect(
      categorizeInteraction("tool_use", "Write", { toolInputSummary: "file_path: .claude/settings.json" }),
    ).toEqual(["agent"]);
  });

  it("classifies Read of CLAUDE.md as agent", () => {
    expect(categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: /workspace/CLAUDE.md" })).toEqual([
      "agent",
    ]);
  });

  it("classifies Read of AGENTS.md as agent", () => {
    expect(categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: AGENTS.md" })).toEqual(["agent"]);
  });

  it("classifies Read of .codex/ path as agent", () => {
    expect(categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: .codex/config.toml" })).toEqual([
      "agent",
    ]);
  });

  it("classifies Read of .gemini/ path as agent", () => {
    expect(categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: .gemini/settings.json" })).toEqual(
      ["agent"],
    );
  });

  it("classifies Read of normal path as environment", () => {
    expect(categorizeInteraction("tool_use", "Read", { toolInputSummary: "file_path: src/index.ts" })).toEqual([
      "environment",
    ]);
  });

  it("classifies environment tool without context as environment", () => {
    expect(categorizeInteraction("tool_use", "Read")).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "Read", {})).toEqual(["environment"]);
  });

  // --- Dual-category: environment + service (network calls from env tools) ---

  it("classifies Bash with isNetworkCall as environment + service", () => {
    expect(categorizeInteraction("tool_use", "Bash", { isNetworkCall: true })).toEqual(["environment", "service"]);
  });

  it("classifies shell with isNetworkCall as environment + service", () => {
    expect(categorizeInteraction("tool_use", "shell", { isNetworkCall: true })).toEqual(["environment", "service"]);
  });

  it("classifies Bash without isNetworkCall as environment only", () => {
    expect(categorizeInteraction("tool_use", "Bash", { isNetworkCall: false })).toEqual(["environment"]);
  });

  it("classifies Bash with both path and isNetworkCall correctly", () => {
    // agent-internal path takes precedence
    expect(
      categorizeInteraction("tool_use", "Bash", {
        toolInputSummary: "command: cat .claude/settings.json",
        isNetworkCall: false,
      }),
    ).toEqual(["agent"]);
  });

  it("classifies Read with URL in input as environment + service when isNetworkCall", () => {
    expect(
      categorizeInteraction("tool_use", "Read", {
        toolInputSummary: "file_path: /tmp/api-response.json",
        isNetworkCall: true,
      }),
    ).toEqual(["environment", "service"]);
  });

  // --- Service tools (fallback) ---

  it("classifies WebFetch as service", () => {
    expect(categorizeInteraction("tool_use", "WebFetch")).toEqual(["service"]);
  });

  it("classifies unknown tools as service", () => {
    expect(categorizeInteraction("tool_use", "my_custom_api")).toEqual(["service"]);
  });

  it("classifies orphaned tool_result without toolName as service", () => {
    expect(categorizeInteraction("tool_result", null)).toEqual(["service"]);
  });

  // --- ACP kind-based classification ---
  // ACP-based adapters (Gemini) set toolName to a human-readable title
  // ("Writing to README.md") and the semantic kind ("edit") on a separate
  // field. Classification must fall through to kind when the title doesn't
  // match a known tool name.

  it("classifies ACP kind=read as environment", () => {
    expect(categorizeInteraction("tool_use", "package.json", { kind: "read" })).toEqual(["environment"]);
  });

  it("classifies ACP kind=edit as environment", () => {
    expect(
      categorizeInteraction("tool_use", "Writing to src/data/products.ts", { kind: "edit" }),
    ).toEqual(["environment"]);
  });

  it("classifies ACP kind=search as environment", () => {
    expect(categorizeInteraction("tool_use", "src/routes", { kind: "search" })).toEqual(["environment"]);
  });

  it("classifies ACP kind=execute as environment", () => {
    expect(categorizeInteraction("tool_use", "Running build script", { kind: "execute" })).toEqual([
      "environment",
    ]);
  });

  it("classifies ACP kind=modify/add/delete/move as environment", () => {
    expect(categorizeInteraction("tool_use", "x", { kind: "modify" })).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "x", { kind: "add" })).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "x", { kind: "delete" })).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "x", { kind: "move" })).toEqual(["environment"]);
  });

  it("classifies ACP kind=think as agent", () => {
    expect(
      categorizeInteraction("tool_use", 'Update topic to: "Implementing Product Data"', { kind: "think" }),
    ).toEqual(["agent"]);
  });

  it("classifies ACP kind=switch_mode as agent", () => {
    expect(categorizeInteraction("tool_use", "Switch to plan mode", { kind: "switch_mode" })).toEqual([
      "agent",
    ]);
  });

  it("classifies ACP kind=fetch as service", () => {
    expect(categorizeInteraction("tool_use", "Fetching https://api.example.com", { kind: "fetch" })).toEqual([
      "service",
    ]);
  });

  it("classifies ACP kind=other as service (default fallback)", () => {
    expect(categorizeInteraction("tool_use", "Plan approval", { kind: "other" })).toEqual(["service"]);
  });

  it("classifies ACP kind=edit on agent-internal path as agent", () => {
    expect(
      categorizeInteraction("tool_use", "Writing to .gemini/settings.json", {
        kind: "edit",
        toolInputSummary: "path: .gemini/settings.json",
      }),
    ).toEqual(["agent"]);
  });

  it("classifies ACP kind=execute with network call as environment + service", () => {
    expect(categorizeInteraction("tool_use", "curl call", { kind: "execute", isNetworkCall: true })).toEqual([
      "environment",
      "service",
    ]);
  });

  it("classifies ACP tool_result with kind=read as environment", () => {
    expect(categorizeInteraction("tool_result", null, { kind: "read" })).toEqual(["environment"]);
  });

  it("classifies ACP tool_result with kind=think as agent", () => {
    expect(categorizeInteraction("tool_result", null, { kind: "think" })).toEqual(["agent"]);
  });

  it("ignores ACP kind when toolName already matches an environment tool", () => {
    // Stable tool names always win over kind — kind is a fallback signal
    expect(categorizeInteraction("tool_use", "Bash", { kind: "think" })).toEqual(["environment"]);
  });

  it("ignores ACP kind when toolName already matches an agent tool", () => {
    expect(categorizeInteraction("tool_use", "TaskCreate", { kind: "execute" })).toEqual(["agent"]);
  });

  it("is case-insensitive for ACP kind", () => {
    expect(categorizeInteraction("tool_use", "x", { kind: "READ" })).toEqual(["environment"]);
    expect(categorizeInteraction("tool_use", "x", { kind: "Think" })).toEqual(["agent"]);
  });
});
