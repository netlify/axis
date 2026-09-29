import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";

const E2E_DIR = path.resolve(import.meta.dirname, "../../e2e/agent-names");
const CONFIG = path.join(E2E_DIR, "axis.config.json");

describe("explicit agents[].name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the explicit name verbatim and leaves derived names uncounted by it", async () => {
    const output = await run({ configPath: CONFIG, logger: silentLogger });

    // The named entry sits between two identical derived entries. Its own name
    // is untouched, and it does not consume a slot in their counter, so the
    // derived pair stays echo|m1 and echo|m1-2 regardless of its position.
    expect(output.results.map((r) => r.agentName).sort()).toEqual(["echo|m1", "echo|m1-2", "echo|m1-control"]);
  });

  it("matches an explicit name with -a", async () => {
    const output = await run({
      configPath: CONFIG,
      agentFilter: ["echo|m1-control"],
      logger: silentLogger,
    });

    expect(output.results.map((r) => r.agentName)).toEqual(["echo|m1-control"]);
  });

  it("rejects two entries claiming the same explicit name", async () => {
    await expect(
      run({ configPath: path.join(E2E_DIR, "axis.dupe.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/Duplicate agent name "same"/);
  });
});
