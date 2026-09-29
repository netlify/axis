import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import { silentLogger } from "../../../src/types/output.js";

vi.mock("../../../src/runner/lifecycle.js", () => ({
  executeLifecycleActions: vi.fn().mockResolvedValue([]),
}));

import { run } from "../../../src/runner/runner.js";

const PROFILES_DIR = path.resolve(import.meta.dirname, "../../e2e/profiles");
const NAMES_DIR = path.resolve(import.meta.dirname, "../../e2e/agent-names");

const cfg = (dir: string, file: string) => path.join(dir, file);
const keysOf = (results: { scenarioKey: string }[]) => results.map((r) => r.scenarioKey).sort();

describe("unreachable-scenario check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exempts scenarios disabled at the source", async () => {
    // skipped-one is excluded from the default suite and claimed by no
    // profile, but it carries skip: true, so being unreachable is the point.
    const output = await run({ configPath: cfg(PROFILES_DIR, "axis.skipped.config.json"), logger: silentLogger });

    expect(keysOf(output.results)).toEqual(["create-one"]);
  });

  it("fires regardless of which profile is active", async () => {
    // The check reads the base config, so selecting a profile must not mask a
    // scenario that the default suite orphaned.
    await expect(
      run({ configPath: cfg(PROFILES_DIR, "axis.orphans.config.json"), profile: "ask", logger: silentLogger }),
    ).rejects.toThrow(/excluded from the default suite/);
  });

  it("names every orphan and pluralizes the message", async () => {
    await expect(
      run({ configPath: cfg(PROFILES_DIR, "axis.orphans.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/2 scenarios excluded from the default suite with no profile to claim them/);

    await expect(
      run({ configPath: cfg(PROFILES_DIR, "axis.orphans.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/nested\/deep-one/);
  });

  it("does not run when the base config has no suite selector", async () => {
    // Profiles exist but nothing is excluded, so every scenario is reachable
    // and the extra discovery pass is skipped.
    const output = await run({ configPath: cfg(PROFILES_DIR, "axis.noselector.config.json"), logger: silentLogger });

    expect(keysOf(output.results)).toEqual(["ask-one", "create-one", "nested/deep-one", "questions-one"]);
  });

  it("claims namespaced keys through a profile include", async () => {
    const output = await run({
      configPath: cfg(PROFILES_DIR, "axis.skipped.config.json"),
      profile: "nested",
      logger: silentLogger,
    });

    expect(keysOf(output.results)).toEqual(["nested/deep-one"]);
  });
});

describe("selector layering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a per-agent filter narrow inside the suite but not escape it", async () => {
    const output = await run({ configPath: cfg(PROFILES_DIR, "axis.agent-filter.config.json"), logger: silentLogger });

    // "reaches" asks for create-one, which the suite includes. "blocked" asks
    // for ask-one, which the suite excluded, so it contributes no jobs.
    expect(output.results.map((r) => [r.scenarioKey, r.agentName])).toEqual([["create-one", "echo|reaches"]]);
  });

  it("allows exclude without profiles as a permanent opt-out", async () => {
    // No profiles map, so the reachability check does not run and ask-one is
    // simply never run.
    const output = await run({ configPath: cfg(PROFILES_DIR, "axis.agent-filter.config.json"), logger: silentLogger });

    expect(keysOf(output.results)).not.toContain("ask-one");
  });
});

describe("jobFilter (--failed) under a profile", () => {
  // The main fixture deliberately renames the agent per profile: the default
  // suite runs "echo", the ask profile runs "echo|ask-model". A retry pair
  // recorded under one suite therefore cannot address the other, which is the
  // behavior `--failed --profile <name>` depends on.
  const MAIN = cfg(PROFILES_DIR, "axis.config.json");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a pair from the default suite", async () => {
    const first = await run({ configPath: MAIN, logger: silentLogger });
    const target = first.results[0];
    expect([target.scenarioKey, target.agentName]).toEqual(["create-one", "echo"]);

    const retry = await run({
      configPath: MAIN,
      jobFilter: [{ scenarioKey: target.scenarioKey, agentName: target.agentName }],
      logger: silentLogger,
    });

    expect(retry.results.map((r) => [r.scenarioKey, r.agentName])).toEqual([["create-one", "echo"]]);
  });

  it("retries a pair from a profile's suite when the same profile is selected", async () => {
    const first = await run({ configPath: MAIN, profile: "ask", logger: silentLogger });
    const target = first.results[0];
    expect([target.scenarioKey, target.agentName]).toEqual(["ask-one", "echo|ask-model"]);

    const retry = await run({
      configPath: MAIN,
      profile: "ask",
      jobFilter: [{ scenarioKey: target.scenarioKey, agentName: target.agentName }],
      logger: silentLogger,
    });

    expect(retry.results.map((r) => [r.scenarioKey, r.agentName])).toEqual([["ask-one", "echo|ask-model"]]);
  });

  it("drops a default-suite pair when a profile narrows the suite away from it", async () => {
    // Retrying a report from the default run while passing --profile ask: the
    // scenario is outside the ask suite and the agent name does not exist in
    // its matrix, so nothing matches and no job runs under the wrong flags.
    const retry = await run({
      configPath: MAIN,
      profile: "ask",
      jobFilter: [{ scenarioKey: "create-one", agentName: "echo" }],
      logger: silentLogger,
    });

    expect(retry.results).toHaveLength(0);
  });

  it("drops a profile-suite pair when no profile is selected", async () => {
    const retry = await run({
      configPath: MAIN,
      jobFilter: [{ scenarioKey: "ask-one", agentName: "echo|ask-model" }],
      logger: silentLogger,
    });

    expect(retry.results).toHaveLength(0);
  });

  it("keeps in-suite pairs and drops out-of-suite ones from the same filter", async () => {
    // A mixed allowlist must not fail the run; unmatched pairs are dropped the
    // same way a removed scenario or agent is.
    const retry = await run({
      configPath: MAIN,
      profile: "ask",
      jobFilter: [
        { scenarioKey: "ask-one", agentName: "echo|ask-model" },
        { scenarioKey: "create-one", agentName: "echo" },
      ],
      logger: silentLogger,
    });

    expect(retry.results.map((r) => [r.scenarioKey, r.agentName])).toEqual([["ask-one", "echo|ask-model"]]);
  });

  it("still enforces the unreachable-scenario check before applying the filter", async () => {
    // A misconfigured suite must fail even on a narrow retry, otherwise
    // --failed would be a way to run against a config that cannot be right.
    await expect(
      run({
        configPath: cfg(PROFILES_DIR, "axis.orphans.config.json"),
        jobFilter: [{ scenarioKey: "create-one", agentName: "echo" }],
        logger: silentLogger,
      }),
    ).rejects.toThrow(/excluded from the default suite/);
  });
});

describe("agent name collisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an explicit name that shadows an earlier derived name", async () => {
    await expect(
      run({ configPath: cfg(NAMES_DIR, "axis.shadow-derived.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/Duplicate agent name "echo\|m1"/);
  });

  it("rejects a derived name that lands on an earlier explicit name", async () => {
    await expect(
      run({ configPath: cfg(NAMES_DIR, "axis.shadow-explicit.config.json"), logger: silentLogger }),
    ).rejects.toThrow(/derives the name "echo\|m1", which another entry already claims/);
  });

  it("treats a name without a pipe as its own base agent", async () => {
    // matchesAgentFilter recovers the base agent by splitting on "|", so a
    // bare name is no longer reachable via -a <adapter>.
    const byName = await run({
      configPath: cfg(NAMES_DIR, "axis.bare-name.config.json"),
      agentFilter: ["control"],
      logger: silentLogger,
    });
    expect(byName.results.map((r) => r.agentName)).toEqual(["control"]);

    const byAdapter = await run({
      configPath: cfg(NAMES_DIR, "axis.bare-name.config.json"),
      agentFilter: ["echo"],
      logger: silentLogger,
    });
    expect(byAdapter.results).toHaveLength(0);
  });
});
