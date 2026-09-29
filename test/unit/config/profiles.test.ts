import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { loadConfig, applySuiteSelector } from "../../../src/config/loader.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Write an axis.config.json into a scratch dir and return its path. */
async function writeConfig(config: unknown): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-profiles-"));
  const configPath = path.join(tmpDir, "axis.config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

describe("applySuiteSelector", () => {
  const pool = [{ key: "ask-one" }, { key: "ask-two" }, { key: "create-one" }, { key: "questions-one" }];

  it("returns everything when neither selector is set", () => {
    expect(applySuiteSelector(pool)).toEqual(pool);
  });

  it("keeps only include matches", () => {
    expect(applySuiteSelector(pool, ["ask-*"]).map((s) => s.key)).toEqual(["ask-one", "ask-two"]);
  });

  it("drops exclude matches", () => {
    expect(applySuiteSelector(pool, undefined, ["ask-*", "questions-*"]).map((s) => s.key)).toEqual(["create-one"]);
  });

  it("applies exclude after include", () => {
    expect(applySuiteSelector(pool, ["ask-*"], ["ask-two"]).map((s) => s.key)).toEqual(["ask-one"]);
  });

  it("matches variant keys through their base key", () => {
    const variants = [{ key: "ask-one@baseline" }, { key: "create-one@baseline" }];
    expect(applySuiteSelector(variants, ["ask-*"]).map((s) => s.key)).toEqual(["ask-one@baseline"]);
  });

  it("selects nothing for an empty include", () => {
    // Only an omitted include means everything, matching the per-agent
    // `scenarios` filter where [] also selects nothing.
    expect(applySuiteSelector(pool, [])).toEqual([]);
  });

  it("drops nothing for an empty exclude", () => {
    expect(applySuiteSelector(pool, undefined, [])).toEqual(pool);
  });

  it("treats a bare * as every scenario, including namespaced keys", () => {
    // The glob `*` does not cross "/", so without the special case this would
    // silently drop cms/create-post.
    const nested = [...pool, { key: "cms/create-post" }];
    expect(applySuiteSelector(nested, ["*"])).toEqual(nested);
    expect(applySuiteSelector(nested, undefined, ["*"])).toEqual([]);
  });

  it("matches namespaced keys with an explicit namespace glob", () => {
    const nested = [{ key: "cms/create-post" }, { key: "top-level" }];
    expect(applySuiteSelector(nested, ["cms/*"]).map((s) => s.key)).toEqual(["cms/create-post"]);
  });
});

describe("loadConfig profiles", () => {
  it("leaves the config untouched when no profile is selected", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      exclude: ["ask-*"],
      profiles: { ask: { include: ["ask-*"], agents: ["other-agent"] } },
    });

    const { config } = await loadConfig(configPath);

    expect(config.agents).toEqual(["mock-agent"]);
    expect(config.exclude).toEqual(["ask-*"]);
    expect(config.include).toBeUndefined();
  });

  it("merges the selected profile over the base config", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      env: ["BASE_VAR"],
      exclude: ["ask-*"],
      profiles: { ask: { include: ["ask-*"], agents: ["other-agent"] } },
    });

    const { config } = await loadConfig(configPath, { profile: "ask" });

    expect(config.agents).toEqual(["other-agent"]);
    expect(config.include).toEqual(["ask-*"]);
    // Untouched keys survive the merge.
    expect(config.env).toEqual(["BASE_VAR"]);
  });

  it("drops the base exclude when the profile defines its own selector", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      exclude: ["ask-*"],
      profiles: { ask: { include: ["ask-*"] } },
    });

    const { config } = await loadConfig(configPath, { profile: "ask" });

    // Without the pair rule the inherited exclude would cancel the include
    // and the ask suite would be empty.
    expect(config.exclude).toBeUndefined();
    expect(config.include).toEqual(["ask-*"]);
  });

  it("keeps the base selector when the profile defines neither half", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      exclude: ["ask-*"],
      profiles: { create: {} },
    });

    const { config } = await loadConfig(configPath, { profile: "create" });

    expect(config.exclude).toEqual(["ask-*"]);
  });

  it("deep-merges plain objects and replaces arrays", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      settings: { concurrency: 20, limits: { scenario: { time_minutes: 30 } } },
      profiles: { fast: { settings: { limits: { scenario: { time_minutes: 5 } } } } },
    });

    const { config } = await loadConfig(configPath, { profile: "fast" });

    expect(config.settings?.concurrency).toBe(20);
    expect(config.settings?.limits?.scenario?.time_minutes).toBe(5);
  });

  it("throws on an unknown profile and lists the available ones", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      profiles: { ask: {}, questions: {} },
    });

    await expect(loadConfig(configPath, { profile: "asks" })).rejects.toThrow(
      /Unknown profile "asks".*Available: ask, questions/s,
    );
  });

  it("throws when a profile is requested but the config defines none", async () => {
    const configPath = await writeConfig({ agents: ["mock-agent"] });

    await expect(loadConfig(configPath, { profile: "ask" })).rejects.toThrow(/defines no "profiles"/);
  });

  it("validates the merged config, not just the base", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      profiles: { broken: { agents: [{ model: "no-agent-field" }] } },
    });

    await expect(loadConfig(configPath, { profile: "broken" })).rejects.toThrow(/must have an "agent" string/);
  });

  it("exposes the pre-merge config as baseConfig", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      exclude: ["ask-*"],
      profiles: { ask: { include: ["ask-*"], agents: ["other-agent"] } },
    });

    const { config, baseConfig } = await loadConfig(configPath, { profile: "ask" });

    expect(config.include).toEqual(["ask-*"]);
    expect(baseConfig.exclude).toEqual(["ask-*"]);
    expect(baseConfig.include).toBeUndefined();
    expect(baseConfig.agents).toEqual(["mock-agent"]);
  });

  it("drops the base include when the profile defines only an exclude", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      include: ["create-*"],
      profiles: { wide: { exclude: ["ask-*"] } },
    });

    const { config } = await loadConfig(configPath, { profile: "wide" });

    // The pair rule runs in both directions: setting either half replaces both.
    expect(config.include).toBeUndefined();
    expect(config.exclude).toEqual(["ask-*"]);
  });

  it("rejects an inherited object property as a profile name", async () => {
    const configPath = await writeConfig({ agents: ["mock-agent"], profiles: { ask: {} } });

    // A prototype key must not resolve to Object.prototype.constructor.
    await expect(loadConfig(configPath, { profile: "constructor" })).rejects.toThrow(
      /Unknown profile "constructor".*Available: ask/s,
    );
    await expect(loadConfig(configPath, { profile: "toString" })).rejects.toThrow(/Unknown profile "toString"/);
  });

  it("lets a profile replace the scenarios source", async () => {
    const configPath = await writeConfig({
      scenarios: "./base-scenarios",
      agents: ["mock-agent"],
      profiles: { alt: { scenarios: "./alt-scenarios" } },
    });

    const { config } = await loadConfig(configPath, { profile: "alt" });

    expect(config.scenarios).toBe("./alt-scenarios");
  });

  it("does not let the merge mutate the base config", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      settings: { concurrency: 20, limits: { scenario: { time_minutes: 30 } } },
      profiles: { fast: { settings: { limits: { scenario: { time_minutes: 5 } } } } },
    });

    const { config, baseConfig } = await loadConfig(configPath, { profile: "fast" });

    expect(config.settings?.limits?.scenario?.time_minutes).toBe(5);
    expect(baseConfig.settings?.limits?.scenario?.time_minutes).toBe(30);
    expect(baseConfig.agents).toEqual(["mock-agent"]);
  });

  it("applies an empty include from a profile as an empty suite", async () => {
    const configPath = await writeConfig({
      agents: ["mock-agent"],
      profiles: { none: { include: [] } },
    });

    const { config } = await loadConfig(configPath, { profile: "none" });

    expect(config.include).toEqual([]);
  });

  it("passes the selected profile to a function-style config", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-profiles-fn-"));
    const configPath = path.join(tmpDir, "axis.config.js");
    await fs.writeFile(
      configPath,
      `export default ({ profile }) => ({ name: profile ?? "none", agents: ["mock-agent"] });\n`,
    );

    const withProfile = await loadConfig(configPath, { profile: "ask" });
    expect(withProfile.config.name).toBe("ask");

    const without = await loadConfig(configPath);
    expect(without.config.name).toBe("none");
  });
});
