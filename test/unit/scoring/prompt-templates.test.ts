import { describe, it, expect } from "vitest";
import { getPromptTemplates, interpolate } from "../../../src/scoring/prompt-templates.js";

describe("interpolate", () => {
  it("replaces a single variable", () => {
    expect(interpolate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("replaces multiple variables", () => {
    expect(interpolate("{{a}} and {{b}}", { a: "one", b: "two" })).toBe("one and two");
  });

  it("coerces numbers to strings", () => {
    expect(interpolate("Count: {{n}}", { n: 42 })).toBe("Count: 42");
  });

  it("throws on missing variable", () => {
    expect(() => interpolate("Hello {{missing}}", {})).toThrow("Missing template variable: {{missing}}");
  });

  it("handles adjacent placeholders", () => {
    expect(interpolate("{{a}}{{b}}", { a: "x", b: "y" })).toBe("xy");
  });

  it("handles repeated placeholders", () => {
    expect(interpolate("{{x}} then {{x}}", { x: "v" })).toBe("v then v");
  });

  it("passes through strings with no placeholders", () => {
    expect(interpolate("no vars here", {})).toBe("no vars here");
  });

  it("handles empty string template", () => {
    expect(interpolate("", {})).toBe("");
  });

  it("handles empty string variable value", () => {
    expect(interpolate("before{{gap}}after", { gap: "" })).toBe("beforeafter");
  });
});

describe("getPromptTemplates", () => {
  const templates = getPromptTemplates();

  it("returns exactly 3 templates", () => {
    expect(Object.keys(templates)).toEqual(["category_eval", "goal_string_rubric", "goal_array_rubric"]);
  });

  it("each template has required fields", () => {
    for (const [key, tmpl] of Object.entries(templates)) {
      expect(tmpl.name).toBe(key);
      expect(typeof tmpl.description).toBe("string");
      expect(tmpl.description.length).toBeGreaterThan(0);
      expect(["deep_eval", "goal_achievement"]).toContain(tmpl.stage);
      expect(typeof tmpl.template).toBe("string");
      expect(tmpl.template.length).toBeGreaterThan(0);
      expect(Array.isArray(tmpl.variables)).toBe(true);
      expect(tmpl.variables.length).toBeGreaterThan(0);
    }
  });

  it("every {{placeholder}} in a template has a matching variable entry", () => {
    for (const tmpl of Object.values(templates)) {
      const placeholders = [...tmpl.template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      const varNames = new Set(tmpl.variables.map((v) => v.name));
      for (const p of placeholders) {
        expect(varNames.has(p), `template "${tmpl.name}" uses {{${p}}} but has no matching variable`).toBe(true);
      }
    }
  });

  it("every variable appears at least once in the template", () => {
    for (const tmpl of Object.values(templates)) {
      for (const v of tmpl.variables) {
        expect(
          tmpl.template.includes(`{{${v.name}}}`),
          `template "${tmpl.name}" declares variable "${v.name}" but never uses it`,
        ).toBe(true);
      }
    }
  });

  it("returns a new object on each call", () => {
    expect(getPromptTemplates()).not.toBe(getPromptTemplates());
  });
});

describe("template content regression", () => {
  const templates = getPromptTemplates();

  it("category_eval template contains expected sections", () => {
    const t = templates.category_eval.template;
    expect(t).toContain("SCENARIO: {{scenarioName}}");
    expect(t).toContain("COMPLETE SPARSE INDEX");
    expect(t).toContain("INTERACTION DETAILS");
    expect(t).toContain("EVALUATION DIMENSIONS");
    expect(t).toContain("{{evaluationDimensions}}");
    expect(t).toContain("{{necessitySection}}");
    expect(t).toContain("{{responseFormat}}");
    expect(t).toContain("Include an audit for EVERY");
    expect(t).toContain("CATEGORY GUIDANCE");
    expect(t).toContain("{{categoryName}}");
  });

  it("goal_string_rubric template contains expected sections", () => {
    const t = templates.goal_string_rubric.template;
    expect(t).toContain("SCENARIO: {{scenarioName}}");
    expect(t).toContain("AGENT TRANSCRIPT (condensed):");
    expect(t).toContain("AGENT'S FINAL RESULT:");
    expect(t).toContain("RUBRIC:");
    expect(t).toContain("Score guide: 0 = not met at all");
    expect(t).toContain("You are an expert evaluator for an AI agent testing framework called AXIS");
  });

  it("goal_array_rubric template contains expected sections", () => {
    const t = templates.goal_array_rubric.template;
    expect(t).toContain("SCENARIO: {{scenarioName}}");
    expect(t).toContain("AGENT TRANSCRIPT (condensed):");
    expect(t).toContain("RUBRIC CRITERIA:");
    expect(t).toContain("Score guide: 0 = not met at all");
    expect(t).toContain('"grades"');
  });

  it("category_eval template can be interpolated with representative values (env)", () => {
    const result = interpolate(templates.category_eval.template, {
      scenarioName: "Eval Scenario",
      prompt: "Build a site",
      categoryName: "environment",
      totalInteractions: 5,
      categoryInteractionCount: 2,
      sparseLines: "#1 env Write ...",
      categoryGuidance: "Evaluate file ops and shell commands",
      interactionContent: "---\n#1 | Category: environment\ncontent\n---",
      dataDir: "/tmp/axis/reports/2025-01-01/scenarios/test/agent",
      evaluationDimensions: "- success: Did the operation complete without errors?",
      necessitySection: "",
      responseFormat: 'Respond with ONLY valid JSON:\n{"audits": [...], "patterns": [...]}',
    });
    expect(result).toContain("SCENARIO: Eval Scenario");
    expect(result).toContain("Build a site");
    expect(result).toContain("environment");
    expect(result).not.toContain("{{");
  });

  it("category_eval template can be interpolated with representative values (agent)", () => {
    const result = interpolate(templates.category_eval.template, {
      scenarioName: "Eval Scenario",
      prompt: "Build a site",
      categoryName: "agent",
      totalInteractions: 5,
      categoryInteractionCount: 3,
      sparseLines: "#1 agent Assistant ...",
      categoryGuidance: "Evaluate reasoning and planning",
      interactionContent: "---\n#1 | Category: agent\ncontent\n---",
      dataDir: "/tmp/axis/reports/2025-01-01/scenarios/test/agent",
      evaluationDimensions: "- success: ...\n- weight: ...\n- contextRelevance: ...",
      necessitySection: "Also evaluate NECESSITY for the agent's overall execution...",
      responseFormat: 'Respond with ONLY valid JSON:\n{"audits": [...], "necessity": {...}, "patterns": [...]}',
    });
    expect(result).toContain("SCENARIO: Eval Scenario");
    expect(result).toContain("agent");
    expect(result).toContain("NECESSITY");
    expect(result).not.toContain("{{");
  });

  it("goal templates can be interpolated with representative values", () => {
    const stringResult = interpolate(templates.goal_string_rubric.template, {
      scenarioName: "Goal Scenario",
      prompt: "Deploy app",
      transcript: "[1] ASSISTANT: I deployed the app",
      finalResult: "App deployed",
      rubric: "The app should be deployed",
    });
    expect(stringResult).toContain("SCENARIO: Goal Scenario");
    expect(stringResult).toContain("Deploy app");
    expect(stringResult).not.toContain("{{");

    const arrayResult = interpolate(templates.goal_array_rubric.template, {
      scenarioName: "Goal Scenario",
      prompt: "Deploy app",
      transcript: "[1] ASSISTANT: I deployed the app",
      finalResult: "App deployed",
      rubricText: '0. "App is deployed" (weight: 1.0)',
    });
    expect(arrayResult).toContain("RUBRIC CRITERIA:");
    expect(arrayResult).not.toContain("{{");
  });
});
