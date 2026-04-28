import { describe, it, expect } from "vitest";
import { parseTriageResponse } from "../../../src/scoring/triage.js";

describe("parseTriageResponse", () => {
  describe("valid responses", () => {
    it("parses a complete valid response", () => {
      const response = JSON.stringify({
        flaggedInteractions: [
          { id: 1, reason: "Failed file read", concerns: ["success", "relevance"] },
          { id: 5, reason: "Slow API call", concerns: ["speed"] },
        ],
        patterns: [{ description: "Repeated retries on deployment", interactionIds: [3, 4, 5], severity: "high" }],
        categoryNotes: {
          environment: "Good file operations",
          service: "Slow API responses",
          agent: "Efficient reasoning",
        },
      });

      const result = parseTriageResponse(response);

      expect(result.flaggedInteractions).toHaveLength(2);
      expect(result.flaggedInteractions[0]).toEqual({
        id: 1,
        reason: "Failed file read",
        concerns: ["success", "relevance"],
      });
      expect(result.flaggedInteractions[1]).toEqual({
        id: 5,
        reason: "Slow API call",
        concerns: ["speed"],
      });

      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0]).toEqual({
        description: "Repeated retries on deployment",
        interactionIds: [3, 4, 5],
        severity: "high",
      });

      expect(result.categoryNotes).toEqual({
        environment: "Good file operations",
        service: "Slow API responses",
        agent: "Efficient reasoning",
      });
    });

    it("parses JSON wrapped in markdown fences", () => {
      const response = `\`\`\`json
{
  "flaggedInteractions": [{"id": 1, "reason": "Error detected", "concerns": ["success"]}],
  "patterns": [],
  "categoryNotes": {"environment": "", "service": "", "agent": ""}
}
\`\`\``;

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(1);
      expect(result.flaggedInteractions[0].id).toBe(1);
    });
  });

  describe("invalid/empty responses", () => {
    it("returns empty result for empty string", () => {
      const result = parseTriageResponse("");
      expect(result).toEqual({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: { environment: "", service: "", agent: "" },
      });
    });

    it("returns empty result for invalid JSON", () => {
      const result = parseTriageResponse("This is not JSON at all.");
      expect(result).toEqual({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: { environment: "", service: "", agent: "" },
      });
    });

    it("returns empty result for JSON that fails to parse", () => {
      const result = parseTriageResponse("{broken json!!!}");
      expect(result).toEqual({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: { environment: "", service: "", agent: "" },
      });
    });
  });

  describe("flaggedInteractions parsing", () => {
    it("caps flags at MAX_FLAGS=30", () => {
      const flags = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        reason: `Reason ${i + 1}`,
        concerns: ["success"],
      }));
      const response = JSON.stringify({
        flaggedInteractions: flags,
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(30);
      expect(result.flaggedInteractions[29].id).toBe(30);
    });

    it("skips entries missing id", () => {
      const response = JSON.stringify({
        flaggedInteractions: [
          { reason: "No id", concerns: ["success"] },
          { id: 2, reason: "Has id", concerns: ["speed"] },
        ],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(1);
      expect(result.flaggedInteractions[0].id).toBe(2);
    });

    it("skips entries missing reason", () => {
      const response = JSON.stringify({
        flaggedInteractions: [
          { id: 1, concerns: ["success"] },
          { id: 2, reason: "Valid", concerns: ["speed"] },
        ],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(1);
      expect(result.flaggedInteractions[0].id).toBe(2);
    });

    it("skips entries where id is a string", () => {
      const response = JSON.stringify({
        flaggedInteractions: [{ id: "one", reason: "Bad type", concerns: ["success"] }],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(0);
    });

    it("skips null and primitive entries in array", () => {
      const response = JSON.stringify({
        flaggedInteractions: [null, 42, "string", { id: 3, reason: "Valid", concerns: ["success"] }],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(1);
      expect(result.flaggedInteractions[0].id).toBe(3);
    });

    it("returns empty array when flaggedInteractions is not an array", () => {
      const response = JSON.stringify({
        flaggedInteractions: "not an array",
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions).toHaveLength(0);
    });
  });

  describe("concerns filtering", () => {
    it("filters concerns to valid values only", () => {
      const response = JSON.stringify({
        flaggedInteractions: [
          { id: 1, reason: "Mixed concerns", concerns: ["success", "invalid", "speed", "banana", "weight"] },
        ],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions[0].concerns).toEqual(["success", "speed", "weight"]);
    });

    it("accepts all five valid concern types", () => {
      const response = JSON.stringify({
        flaggedInteractions: [
          { id: 1, reason: "All concerns", concerns: ["success", "speed", "weight", "relevance", "necessity"] },
        ],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions[0].concerns).toEqual(["success", "speed", "weight", "relevance", "necessity"]);
    });

    it("defaults to ['success', 'relevance'] when no valid concerns remain", () => {
      const response = JSON.stringify({
        flaggedInteractions: [{ id: 1, reason: "No valid concerns", concerns: ["invalid", "bogus"] }],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions[0].concerns).toEqual(["success", "relevance"]);
    });

    it("defaults to ['success', 'relevance'] when concerns is not an array", () => {
      const response = JSON.stringify({
        flaggedInteractions: [{ id: 1, reason: "Missing concerns", concerns: "not an array" }],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions[0].concerns).toEqual(["success", "relevance"]);
    });

    it("defaults to ['success', 'relevance'] when concerns is absent", () => {
      const response = JSON.stringify({
        flaggedInteractions: [{ id: 1, reason: "No concerns field" }],
        patterns: [],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.flaggedInteractions[0].concerns).toEqual(["success", "relevance"]);
    });
  });

  describe("patterns parsing", () => {
    it("parses valid patterns", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [
          { description: "Redundant API calls", interactionIds: [1, 2], severity: "low" },
          { description: "Excessive retries", interactionIds: [5, 6, 7], severity: "high" },
        ],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns).toHaveLength(2);
      expect(result.patterns[0]).toEqual({
        description: "Redundant API calls",
        interactionIds: [1, 2],
        severity: "low",
      });
      expect(result.patterns[1].severity).toBe("high");
    });

    it("skips pattern entries missing description", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [
          { interactionIds: [1], severity: "low" },
          { description: "Valid", interactionIds: [2], severity: "medium" },
        ],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].description).toBe("Valid");
    });

    it("defaults severity to 'medium' for invalid severity values", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [
          { description: "Pattern A", interactionIds: [1], severity: "critical" },
          { description: "Pattern B", interactionIds: [2], severity: 42 },
          { description: "Pattern C", interactionIds: [3] },
        ],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns).toHaveLength(3);
      expect(result.patterns[0].severity).toBe("medium");
      expect(result.patterns[1].severity).toBe("medium");
      expect(result.patterns[2].severity).toBe("medium");
    });

    it("filters non-number interaction IDs from patterns", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [{ description: "Mixed IDs", interactionIds: [1, "two", 3, null, 5], severity: "low" }],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns[0].interactionIds).toEqual([1, 3, 5]);
    });

    it("defaults interactionIds to empty array when not an array", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [{ description: "No IDs", interactionIds: "not-array", severity: "low" }],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns[0].interactionIds).toEqual([]);
    });

    it("returns empty array when patterns is not an array", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: "not-an-array",
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns).toHaveLength(0);
    });

    it("skips null and primitive entries in patterns array", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [null, 42, { description: "Valid", interactionIds: [], severity: "low" }],
        categoryNotes: {},
      });

      const result = parseTriageResponse(response);
      expect(result.patterns).toHaveLength(1);
    });
  });

  describe("categoryNotes parsing", () => {
    it("parses all three categories", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: {
          environment: "Env note",
          service: "Service note",
          agent: "Agent note",
        },
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "Env note",
        service: "Service note",
        agent: "Agent note",
      });
    });

    it("defaults missing categories to empty string", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: { environment: "Only env" },
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "Only env",
        service: "",
        agent: "",
      });
    });

    it("defaults non-string category values to empty string", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: {
          environment: 42,
          service: null,
          agent: ["array"],
        },
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "",
        service: "",
        agent: "",
      });
    });

    it("returns all empty strings when categoryNotes is not an object", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: "not-an-object",
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "",
        service: "",
        agent: "",
      });
    });

    it("returns all empty strings when categoryNotes is null", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
        categoryNotes: null,
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "",
        service: "",
        agent: "",
      });
    });

    it("returns all empty strings when categoryNotes is missing", () => {
      const response = JSON.stringify({
        flaggedInteractions: [],
        patterns: [],
      });

      const result = parseTriageResponse(response);
      expect(result.categoryNotes).toEqual({
        environment: "",
        service: "",
        agent: "",
      });
    });
  });
});
