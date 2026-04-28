import type { TranscriptEntry } from "../types/agent.js";
import type { InteractionCategory } from "../types/scoring.js";

/**
 * Tool names that represent environment interactions —
 * OS, filesystem, shell, dev tooling, package managers, version control.
 * All entries are lowercase; lookup is case-insensitive.
 */
const ENVIRONMENT_TOOL_NAMES = new Set([
  // Shell / execution
  "bash",
  "shell",
  "terminal",
  "exec",
  "command_execution",
  // File operations
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "notebookedit",
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
  "find",
  "ls",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "chown",
  // Version control
  "git",
  // Package managers
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "cargo",
  "go",
  "bundle",
  "gem",
  "composer",
  "brew",
  "apt",
  "apt-get",
  // Build / test tools
  "make",
  "cmake",
  "tsc",
  "node",
  "python",
  "python3",
  "ruby",
  "java",
  "javac",
  "docker",
  "kubectl",
  // File system navigation
  "cd",
  "pwd",
  "which",
  "whereis",
  "file",
  "stat",
  "du",
  "df",
  // Text processing
  "sort",
  "uniq",
  "wc",
  "diff",
  "patch",
  "tr",
  "cut",
  "xargs",
]);

/**
 * Prefixes for tool names that indicate environment interactions.
 * Shell commands invoked via adapters often use these prefixes.
 */
const ENVIRONMENT_TOOL_PREFIXES = ["file_", "fs_", "dir_", "mcp__filesystem__"];

/**
 * Tool names that represent agent-internal operations —
 * metacognition, planning, task management, tool discovery.
 * These are the agent orchestrating itself, not interacting with external services.
 * All entries are lowercase; lookup is case-insensitive.
 */
const AGENT_TOOL_NAMES = new Set([
  // Tool discovery / selection
  "toolsearch",
  "tool_search",
  "listtoolsets",
  "list_tools",
  // Task management
  "task",
  "taskcreate",
  "taskupdate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskstop",
  "todoread",
  "todowrite",
  "todo_read",
  "todo_write",
  // Planning / mode control
  "enterplanmode",
  "exitplanmode",
  "enter_plan_mode",
  "exit_plan_mode",
  // User interaction
  "askuserquestion",
  "askfollowupquestion",
  "ask_user_question",
  "ask_followup_question",
  // Skill invocation
  "skill",
]);

/**
 * Path patterns that indicate agent-internal file operations.
 * When an environment tool (Read, Write, etc.) targets one of these paths,
 * it's the agent configuring itself — not a meaningful environment interaction.
 */
const AGENT_INTERNAL_PATH_PATTERNS = [".claude/", ".codex/", ".gemini/", "CLAUDE.md", "AGENTS.md"];

/** Optional context for richer classification of tool_use entries. */
export interface CategorizationContext {
  /** Summarized tool input (e.g. "file_path: src/index.ts"). */
  toolInputSummary?: string | null;
  /** Whether this entry was detected as a network call during normalization. */
  isNetworkCall?: boolean;
}

/**
 * Classify a transcript entry into one or more interaction categories.
 *
 * - **environment**: OS, filesystem, shell, dev tooling
 * - **agent**: assistant reasoning, system messages, self-configuration
 * - **service**: external APIs, MCP tools, network calls
 *
 * An interaction can belong to multiple categories (e.g. `Bash(curl ...)` is both
 * environment and service). Classification is deterministic from tool name, entry type,
 * and optional context.
 */
export function categorizeInteraction(
  entryType: TranscriptEntry["type"],
  toolName: string | null,
  context?: CategorizationContext,
): InteractionCategory[] {
  // Agent-internal: assistant reasoning and system messages
  if (entryType === "assistant" || entryType === "system" || entryType === "user") {
    return ["agent"];
  }

  // Error entries default to agent (agent encountered an error)
  if (entryType === "error") {
    return ["agent"];
  }

  // Tool-based entries: classify by tool name
  if (toolName) {
    if (isAgentTool(toolName)) {
      return ["agent"];
    }
    if (isEnvironmentTool(toolName)) {
      // Environment tools targeting agent-internal paths are agent operations
      if (context?.toolInputSummary && isAgentInternalPath(context.toolInputSummary)) {
        return ["agent"];
      }
      // Environment tools that also make network calls belong to both categories
      if (context?.isNetworkCall) {
        return ["environment", "service"];
      }
      return ["environment"];
    }
    // Everything else is a service interaction
    return ["service"];
  }

  // tool_result without a tool name — follow the pair's category
  // (will be resolved during sparse index building via the paired tool_use)
  // Default to service as the safest assumption for unknown tools
  if (entryType === "tool_result") {
    return ["service"];
  }

  return ["agent"];
}

/**
 * Check if the tool input summary references an agent-internal path.
 * These are paths used for agent self-configuration (skills, settings, instructions).
 */
function isAgentInternalPath(inputSummary: string): boolean {
  const lower = inputSummary.toLowerCase();
  return AGENT_INTERNAL_PATH_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Check if a tool name represents an environment tool.
 * Case-insensitive: all entries in ENVIRONMENT_TOOL_NAMES are lowercase.
 */
function isEnvironmentTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (ENVIRONMENT_TOOL_NAMES.has(lower)) return true;

  for (const prefix of ENVIRONMENT_TOOL_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Check if a tool name represents an agent-internal operation.
 * Case-insensitive: all entries in AGENT_TOOL_NAMES are lowercase.
 */
function isAgentTool(toolName: string): boolean {
  return AGENT_TOOL_NAMES.has(toolName.toLowerCase());
}
