import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/profiles");
const CONFIG = path.join(E2E_DIR, "axis.config.json");

const keysOf = (results: { scenarioKey: string }[]) => results.map((r) => r.scenarioKey).sort();

describe("suite selection via profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs only the unexcluded scenarios by default", async () => {
    const output = await run({ configPath: CONFIG, logger: silentLogger });

    expect(keysOf(output.results)).toEqual(["create-one"]);
  });

  it("runs the profile's own suite when one is selected", async () => {
    const output = await run({ configPath: CONFIG, profile: "ask", logger: silentLogger });

    expect(keysOf(output.results)).toEqual(["ask-one"]);
  });

  it("applies the profile's agent matrix", async () => {
    const output = await run({ configPath: CONFIG, profile: "ask", logger: silentLogger });

    expect(output.results.map((r) => r.agentName)).toEqual(["echo|ask-model"]);
  });

  it("inherits the base suite for a profile that sets no selector", async () => {
    const output = await run({ configPath: CONFIG, profile: "create", logger: silentLogger });

    expect(keysOf(output.results)).toEqual(["create-one"]);
  });

  it("keeps --scenario narrowing inside the active suite", async () => {
    // "create-one" is outside the ask suite, so an explicit -s cannot reach it.
    const output = await run({
      configPath: CONFIG,
      profile: "ask",
      scenarioFilter: ["create-one"],
      logger: silentLogger,
    });

    expect(output.results).toHaveLength(0);
  });

  it("throws on an unknown profile", async () => {
    await expect(run({ configPath: CONFIG, profile: "nope", logger: silentLogger })).rejects.toThrow(
      /Unknown profile "nope"/,
    );
  });

  it("fails when a scenario is excluded but no profile claims it", async () => {
    // The orphan config excludes questions-* without a profile including it.
    await expect(
      run({ configPath: path.join(E2E_DIR, "axis.orphan.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/questions-one.*Add it to a profile's "include"/s);
  });
});
