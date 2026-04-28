import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

// Mock lifecycle but NOT the adapter registry — we want the real custom adapter loading
vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/adapters/custom");

describe("Custom adapter e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads custom adapter from config and runs scenario", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.results).toHaveLength(1);

    const result = output.results[0];
    expect(result.agentName).toBe("echo");
    expect(result.scenarioKey).toBe("echo-test");
    expect(result.output.metadata.exitCode).toBe(0);
    // echo outputs the prompt as the result
    expect(result.output.result).toBe("Hello from AXIS CLI adapter");
    expect(result.output.transcript).toHaveLength(1);
    expect(result.output.transcript[0].type).toBe("assistant");
    expect(result.output.transcript[0].content).toEqual({
      text: "Hello from AXIS CLI adapter",
    });
  });

  it("captures non-zero exit from custom adapter", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
  });

  it("verifies full pipeline: config → runner → custom adapter → result", async () => {
    const output = await run({
      configPath: path.join(E2E_DIR, "axis.config.json"),
      logger: silentLogger,
    });

    expect(output.version).toBe("0.1.0");
    expect(output.timestamp).toBeDefined();
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
    expect(output.results[0].agentConfig.adapter).toBe("echo");
  });
});
