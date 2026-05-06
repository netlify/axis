import type { TranscriptEntry } from "../types/agent.js";

export interface ExtractedFields {
  text: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolInputSummary: string | null;
  toolResultText: string | null;
  errorMessage: string | null;
  toolId: string | null;
}

/**
 * Extract adapter-agnostic fields from a raw transcript entry.
 * Tries known adapter content shapes in priority order, with graceful fallbacks.
 */
export function extractFields(entry: TranscriptEntry): ExtractedFields {
  const { content } = entry;

  switch (entry.type) {
    case "assistant": {
      // Claude Code embeds tool_use blocks inside assistant messages.
      // When present, extract tool fields alongside text.
      const toolName = extractToolName(content);
      if (toolName) {
        const toolInput = extractToolInput(content);
        return {
          text: extractAssistantText(content),
          toolName,
          toolInput,
          toolInputSummary: summarizeInput(toolInput),
          toolResultText: null,
          errorMessage: null,
          toolId: extractToolId(content),
        };
      }
      return {
        text: extractAssistantText(content),
        toolName: null,
        toolInput: null,
        toolInputSummary: null,
        toolResultText: null,
        errorMessage: null,
        toolId: null,
      };
    }

    case "tool_use":
      return {
        text: null,
        toolName: extractToolName(content),
        toolInput: extractToolInput(content),
        toolInputSummary: summarizeInput(extractToolInput(content)),
        toolResultText: null,
        errorMessage: null,
        toolId: extractToolId(content),
      };

    case "tool_result": {
      // Some adapters (e.g. codex web_search) emit the tool_use BEFORE the input
      // is finalized — the populated input arrives on the tool_result. Extract it
      // so downstream logic can recover the input from the completed entry.
      const toolInput = extractToolInput(content);
      return {
        text: null,
        toolName: extractToolName(content),
        toolInput,
        toolInputSummary: summarizeInput(toolInput),
        toolResultText: extractToolResultText(content),
        errorMessage: null,
        toolId: extractToolId(content),
      };
    }

    case "error":
      return {
        text: extractGenericText(content),
        toolName: null,
        toolInput: null,
        toolInputSummary: null,
        toolResultText: null,
        errorMessage: extractErrorMessage(content),
        toolId: null,
      };

    default:
      return {
        text: extractGenericText(content),
        toolName: null,
        toolInput: null,
        toolInputSummary: null,
        toolResultText: null,
        errorMessage: null,
        toolId: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Tool name extraction
// ---------------------------------------------------------------------------

/**
 * Extract tool name from content, trying adapter-specific shapes in priority order:
 * 1. content.tool_name (Gemini)
 * 2. content.name (Codex items, some custom adapters)
 * 3. content.type for Codex item types (command_execution, mcp_tool_calls, etc.)
 * 4. Nested message.content[].name (Claude Code)
 */
export function extractToolName(content: Record<string, unknown>): string | null {
  // Gemini: { tool_name: "Bash" }
  if (typeof content.tool_name === "string") return content.tool_name;

  // Codex / generic: { name: "read_file" }
  if (typeof content.name === "string") return content.name;

  // Codex item types: { type: "command_execution", command: "..." }
  if (typeof content.type === "string" && content.type === "command_execution") {
    return "shell";
  }
  if (typeof content.type === "string" && content.type === "mcp_tool_calls") {
    return "mcp";
  }
  if (typeof content.type === "string" && content.type === "web_search") {
    return "web_search";
  }
  if (typeof content.type === "string" && content.type === "file_change") {
    return "file_change";
  }

  // Claude Code nested: { message: { content: [{ type: "tool_use", name: "..." }] } }
  const nested = extractNestedBlock(content, "tool_use");
  if (nested && typeof nested.name === "string") return nested.name;

  return null;
}

// ---------------------------------------------------------------------------
// Tool input extraction
// ---------------------------------------------------------------------------

function extractToolInput(content: Record<string, unknown>): Record<string, unknown> | null {
  // Gemini: { parameters: { command: "ls" } }
  if (content.parameters && typeof content.parameters === "object") {
    return content.parameters as Record<string, unknown>;
  }

  // Claude Code nested: { message: { content: [{ type: "tool_use", input: {...} }] } }
  const nested = extractNestedBlock(content, "tool_use");
  if (nested?.input && typeof nested.input === "object") {
    return nested.input as Record<string, unknown>;
  }

  // Codex command_execution: { command: "echo hello" }
  if (typeof content.command === "string") {
    return { command: content.command };
  }

  // Codex web_search: { type: "web_search", query: "..." }
  if (typeof content.query === "string" && content.query.length > 0) {
    return { query: content.query };
  }

  // Codex generic args field: { arguments: "..." } (function_call payloads)
  if (typeof content.arguments === "string") {
    return { arguments: content.arguments };
  }

  // Codex file_change: { changes: [{ path, kind }, ...] }
  if (Array.isArray(content.changes) && content.changes.length > 0) {
    const summary = (content.changes as Array<Record<string, unknown>>)
      .map((c) => {
        const kind = typeof c.kind === "string" ? c.kind : "change";
        const p = typeof c.path === "string" ? c.path : "(unknown)";
        return `${kind}: ${p}`;
      })
      .join("; ");
    return { changes: summary };
  }

  return null;
}

function summarizeInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      parts.push(`${key}: ${value.length > 100 ? value.slice(0, 100) + "..." : value}`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      parts.push(`${key}: ${value}`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Tool result text extraction
// ---------------------------------------------------------------------------

function extractToolResultText(content: Record<string, unknown>): string | null {
  // Claude Code nested: { message: { content: [{ type: "tool_result", content: "..." }] } }
  const nested = extractNestedBlock(content, "tool_result");
  if (nested) {
    const resultContent = nested.content;
    if (typeof resultContent === "string") return resultContent;
    if (Array.isArray(resultContent)) {
      const parts: string[] = [];
      for (const item of resultContent) {
        const r = item as Record<string, unknown>;
        if (typeof r.text === "string") parts.push(r.text);
      }
      if (parts.length > 0) return parts.join(" | ");
    }
  }

  // Codex command_execution: { aggregated_output: "..." }
  if (typeof content.aggregated_output === "string") return content.aggregated_output;

  // Gemini / Codex: { output: "..." }
  if (typeof content.output === "string") return content.output;

  // Generic: { content: "..." }
  if (typeof content.content === "string") return content.content;

  // Generic: { text: "..." }
  if (typeof content.text === "string") return content.text;

  return null;
}

// ---------------------------------------------------------------------------
// Text extraction (assistant and generic)
// ---------------------------------------------------------------------------

function extractAssistantText(content: Record<string, unknown>): string | null {
  // Claude Code nested: { message: { content: [{ type: "text", text: "..." }] } }
  const message = content.message as Record<string, unknown> | undefined;
  if (message) {
    const blocks = message.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(blocks)) {
      const parts: string[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "tool_use") {
          parts.push(`[calls ${block.name}]`);
        }
      }
      if (parts.length > 0) return parts.join(" ");
    }
  }

  // Gemini: { content: "assistant text" }
  if (typeof content.content === "string") return content.content;

  // Codex / generic: { text: "..." }
  if (typeof content.text === "string") return content.text;

  return null;
}

function extractGenericText(content: Record<string, unknown>): string | null {
  if (typeof content.text === "string") return content.text;
  if (typeof content.message === "string") return content.message;
  if (typeof content.content === "string") return content.content;
  if (typeof content.error === "string") return content.error;
  return null;
}

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

function extractErrorMessage(content: Record<string, unknown>): string | null {
  // Direct: { error: "message" }
  if (typeof content.error === "string") return content.error;

  // Gemini error events: { message: "..." }
  if (typeof content.message === "string") return content.message;

  // Gemini result error: { error: { message: "..." } }
  const errObj = content.error as Record<string, unknown> | undefined;
  if (errObj && typeof errObj.message === "string") return errObj.message;

  // Text fallback
  if (typeof content.text === "string") return content.text;

  return null;
}

// ---------------------------------------------------------------------------
// Tool ID extraction
// ---------------------------------------------------------------------------

function extractToolId(content: Record<string, unknown>): string | null {
  // Gemini: { tool_id: "bash-123" }
  if (typeof content.tool_id === "string") return content.tool_id;

  // Generic: { id: "..." }
  if (typeof content.id === "string") return content.id;

  // Claude nested: tool_use_id on tool_result blocks
  const nested = extractNestedBlock(content, "tool_result");
  if (nested && typeof nested.tool_use_id === "string") return nested.tool_use_id;

  const nestedUse = extractNestedBlock(content, "tool_use");
  if (nestedUse && typeof nestedUse.id === "string") return nestedUse.id;

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first block of a given type from Claude's nested message.content[] structure. */
function extractNestedBlock(content: Record<string, unknown>, blockType: string): Record<string, unknown> | null {
  const message = content.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const blocks = message.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return null;

  return blocks.find((b) => b.type === blockType) ?? null;
}
