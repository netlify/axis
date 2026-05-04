import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";
import { getBaseKey, getVariantName, renderSummaryTable } from "../../../src/ui/format.js";
import type { RunOutput } from "../../../src/types/output.js";

vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/custom");

describe("Variant scenario e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands variants into separate jobs with @-suffixed keys", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
      scenarioFilter: ["variant-test"],
    });

    // 1 scenario × 2 variants × 1 agent = 2 results
    expect(output.results).toHaveLength(2);

    const keys = output.results.map((r) => r.scenarioKey).sort();
    expect(keys).toEqual(["variant-test@alt-prompt", "variant-test@baseline"]);
  });

  it("inherits parent prompt when variant does not override", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
      scenarioFilter: ["variant-test"],
    });

    const baseline = output.results.find((r) => r.scenarioKey === "variant-test@baseline")!;
    expect(baseline.output.result).toBe("Hello from variant");
  });

  it("uses overridden prompt for variant that specifies one", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
      scenarioFilter: ["variant-test"],
    });

    const alt = output.results.find((r) => r.scenarioKey === "variant-test@alt-prompt")!;
    expect(alt.output.result).toBe("Hello from alt variant");
  });

  it("sets scenario name with [variant] suffix", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
      scenarioFilter: ["variant-test"],
    });

    const baseline = output.results.find((r) => r.scenarioKey === "variant-test@baseline")!;
    expect(baseline.scenarioName).toBe("Variant echo test [baseline]");

    const alt = output.results.find((r) => r.scenarioKey === "variant-test@alt-prompt")!;
    expect(alt.scenarioName).toBe("Variant echo test [alt-prompt]");
  });

  it("groups variants under base key in summary table", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
      scenarioFilter: ["variant-test"],
    });

    const table = renderSummaryTable(output);

    // Scenario column should show the base key, not the full @-suffixed key
    expect(table).toContain("variant-test");
    expect(table).not.toContain("variant-test@");

    // Agent column should show agent @variant
    expect(table).toContain("echo @baseline");
    expect(table).toContain("echo @alt-prompt");
  });
});

describe("variant display helpers", () => {
  it("getBaseKey strips @variant suffix", () => {
    expect(getBaseKey("create-post@baseline")).toBe("create-post");
    expect(getBaseKey("cms/create-post@with-mcp")).toBe("cms/create-post");
  });

  it("getBaseKey returns key unchanged when no variant", () => {
    expect(getBaseKey("create-post")).toBe("create-post");
    expect(getBaseKey("cms/create-post")).toBe("cms/create-post");
  });

  it("getVariantName extracts variant name", () => {
    expect(getVariantName("create-post@baseline")).toBe("baseline");
    expect(getVariantName("cms/create-post@with-mcp")).toBe("with-mcp");
  });

  it("getVariantName returns null when no variant", () => {
    expect(getVariantName("create-post")).toBeNull();
    expect(getVariantName("cms/create-post")).toBeNull();
  });
});

describe("renderSummaryTable variant display", () => {
  function makeVariantOutput(): RunOutput {
    return {
      version: "1.0",
      timestamp: "2026-01-01T00:00:00Z",
      durationMs: 10000,
      results: [
        {
          scenarioKey: "deploy@baseline",
          scenarioName: "Deploy [baseline]",
          agentName: "claude-code",
          prompt: "deploy",
          rubric: "check",
          agentConfig: { adapter: "claude-code" },
          output: {
            transcript: [],
            result: null,
            metadata: { startTime: "", endTime: "", durationMs: 5000, exitCode: 0 },
          },
        },
        {
          scenarioKey: "deploy@with-mcp",
          scenarioName: "Deploy [with-mcp]",
          agentName: "claude-code",
          prompt: "deploy",
          rubric: "check",
          agentConfig: { adapter: "claude-code" },
          output: {
            transcript: [],
            result: null,
            metadata: { startTime: "", endTime: "", durationMs: 6000, exitCode: 0 },
          },
        },
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "claude-code",
          prompt: "hello",
          rubric: "check",
          agentConfig: { adapter: "claude-code" },
          output: {
            transcript: [],
            result: null,
            metadata: { startTime: "", endTime: "", durationMs: 3000, exitCode: 0 },
          },
        },
      ],
      summary: { total: 3, completed: 3, failed: 0 },
    };
  }

  it("shows base key in scenario column for variant results", () => {
    const table = renderSummaryTable(makeVariantOutput());
    // "deploy" should appear (base key), not "deploy@baseline"
    expect(table).toContain("deploy");
    expect(table).not.toMatch(/deploy@/);
  });

  it("shows agent @variant in agent column", () => {
    const table = renderSummaryTable(makeVariantOutput());
    expect(table).toContain("claude-code @baseline");
    expect(table).toContain("claude-code @with-mcp");
  });

  it("shows plain agent name for non-variant scenarios", () => {
    const table = renderSummaryTable(makeVariantOutput());
    // The hello-world row should just have "claude-code", not "claude-code @"
    const lines = table.split("\n");
    const helloLine = lines.find((l) => l.includes("hello-world"))!;
    expect(helloLine).toContain("claude-code");
    expect(helloLine).not.toContain("claude-code @");
  });
});
