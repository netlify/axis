import { describe, it, expect } from "vitest";
import { extractFields, extractToolName } from "../../../src/transcript/extract.js";
import type { TranscriptEntry } from "../../../src/types/agent.js";

function entry(type: TranscriptEntry["type"], content: Record<string, unknown>): TranscriptEntry {
  return { type, timestamp: new Date().toISOString(), content };
}

describe("extractFields", () => {
  describe("assistant entries", () => {
    it("extracts text from Claude nested format", () => {
      const result = extractFields(
        entry("assistant", {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello world" }] },
        }),
      );
      expect(result.text).toBe("Hello world");
    });

    it("extracts text with tool_use blocks from Claude", () => {
      const result = extractFields(
        entry("assistant", {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me read that file." },
              { type: "tool_use", name: "Read", id: "toolu_123", input: { file_path: "/foo" } },
            ],
          },
        }),
      );
      expect(result.text).toBe("Let me read that file. [calls Read]");
      expect(result.toolName).toBe("Read");
      expect(result.toolInput).toEqual({ file_path: "/foo" });
      expect(result.toolId).toBe("toolu_123");
    });

    it("extracts tool fields from Claude assistant entry with only tool_use block", () => {
      const result = extractFields(
        entry("assistant", {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "WebFetch", id: "toolu_abc", input: { url: "https://example.com" } }],
          },
        }),
      );
      expect(result.toolName).toBe("WebFetch");
      expect(result.toolInput).toEqual({ url: "https://example.com" });
      expect(result.toolInputSummary).toContain("url: https://example.com");
      expect(result.toolId).toBe("toolu_abc");
      expect(result.text).toBe("[calls WebFetch]");
    });

    it("extracts text from Gemini format", () => {
      const result = extractFields(
        entry("assistant", {
          type: "message",
          role: "assistant",
          content: "I'll help you with that.",
        }),
      );
      expect(result.text).toBe("I'll help you with that.");
    });

    it("extracts text from Codex format", () => {
      const result = extractFields(
        entry("assistant", {
          type: "agent_message",
          text: "Working on it.",
        }),
      );
      expect(result.text).toBe("Working on it.");
    });

    it("returns null text for empty content", () => {
      const result = extractFields(entry("assistant", {}));
      expect(result.text).toBeNull();
    });
  });

  describe("tool_use entries", () => {
    it("extracts from Gemini format", () => {
      const result = extractFields(
        entry("tool_use", {
          type: "tool_use",
          tool_name: "Bash",
          tool_id: "bash-123",
          parameters: { command: "ls -la" },
        }),
      );
      expect(result.toolName).toBe("Bash");
      expect(result.toolId).toBe("bash-123");
      expect(result.toolInput).toEqual({ command: "ls -la" });
      expect(result.toolInputSummary).toBe("command: ls -la");
    });

    it("extracts from Codex command_execution format", () => {
      const result = extractFields(
        entry("tool_use", {
          type: "command_execution",
          command: "echo hello",
        }),
      );
      expect(result.toolName).toBe("shell");
      expect(result.toolInput).toEqual({ command: "echo hello" });
      expect(result.toolInputSummary).toBe("command: echo hello");
    });

    it("extracts from Claude nested format", () => {
      const result = extractFields(
        entry("tool_use", {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "WebFetch",
                id: "tool-abc",
                input: { url: "https://example.com", prompt: "get title" },
              },
            ],
          },
        }),
      );
      expect(result.toolName).toBe("WebFetch");
      expect(result.toolId).toBe("tool-abc");
      expect(result.toolInput).toEqual({ url: "https://example.com", prompt: "get title" });
      expect(result.toolInputSummary).toContain("url: https://example.com");
    });

    it("returns nulls for unrecognized content", () => {
      const result = extractFields(entry("tool_use", { something: "unknown" }));
      expect(result.toolName).toBeNull();
      expect(result.toolInput).toBeNull();
      expect(result.toolInputSummary).toBeNull();
    });
  });

  describe("tool_result entries", () => {
    it("extracts from Gemini format", () => {
      const result = extractFields(
        entry("tool_result", {
          type: "tool_result",
          tool_id: "bash-123",
          output: "file1.txt\nfile2.txt",
        }),
      );
      expect(result.toolResultText).toBe("file1.txt\nfile2.txt");
      expect(result.toolId).toBe("bash-123");
    });

    it("extracts from Codex format", () => {
      const result = extractFields(
        entry("tool_result", {
          type: "command_execution",
          command: "echo hello",
          output: "hello",
        }),
      );
      expect(result.toolResultText).toBe("hello");
    });

    it("extracts from Claude nested format", () => {
      const result = extractFields(
        entry("tool_result", {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-abc",
                content: "File contents here",
              },
            ],
          },
        }),
      );
      expect(result.toolResultText).toBe("File contents here");
      expect(result.toolId).toBe("tool-abc");
    });

    it("extracts from Claude nested format with array content", () => {
      const result = extractFields(
        entry("tool_result", {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-abc",
                content: [
                  { type: "text", text: "Line 1" },
                  { type: "text", text: "Line 2" },
                ],
              },
            ],
          },
        }),
      );
      expect(result.toolResultText).toBe("Line 1 | Line 2");
    });
  });

  describe("error entries", () => {
    it("extracts error string", () => {
      const result = extractFields(entry("error", { error: "Command failed with exit code 1" }));
      expect(result.errorMessage).toBe("Command failed with exit code 1");
    });

    it("extracts error from message field", () => {
      const result = extractFields(entry("error", { type: "error", message: "Rate limit exceeded" }));
      expect(result.errorMessage).toBe("Rate limit exceeded");
    });

    it("extracts nested error message (Gemini result error)", () => {
      const result = extractFields(
        entry("error", {
          type: "result",
          status: "error",
          error: { message: "API key invalid" },
        }),
      );
      expect(result.errorMessage).toBe("API key invalid");
    });

    it("falls back to text field", () => {
      const result = extractFields(entry("error", { text: "Something went wrong" }));
      expect(result.errorMessage).toBe("Something went wrong");
      expect(result.text).toBe("Something went wrong");
    });
  });

  describe("system and user entries", () => {
    it("extracts text from system entry", () => {
      const result = extractFields(entry("system", { text: "System initialized" }));
      expect(result.text).toBe("System initialized");
    });

    it("extracts text from user entry", () => {
      const result = extractFields(entry("user", { content: "User input here" }));
      expect(result.text).toBe("User input here");
    });
  });
});

describe("extractToolName", () => {
  it("extracts from tool_name (Gemini)", () => {
    expect(extractToolName({ tool_name: "WebFetch" })).toBe("WebFetch");
  });

  it("extracts from name (generic)", () => {
    expect(extractToolName({ name: "read_file" })).toBe("read_file");
  });

  it("maps command_execution to shell", () => {
    expect(extractToolName({ type: "command_execution", command: "ls" })).toBe("shell");
  });

  it("extracts from Claude nested format", () => {
    expect(
      extractToolName({
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      }),
    ).toBe("Bash");
  });

  it("returns null for unknown content", () => {
    expect(extractToolName({})).toBeNull();
  });
});
