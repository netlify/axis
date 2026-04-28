import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { loadConfig, discoverScenarios } from "../../../src/config/loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../e2e/fixtures/basic");

describe("loadConfig", () => {
  it("loads a valid config file", async () => {
    const configPath = path.join(FIXTURES_DIR, "axis.config.json");
    const { config, configDir } = await loadConfig(configPath);

    expect(config.scenarios).toBe("./scenarios");
    expect(config.agents).toBeDefined();
    expect(config.agents).toEqual(["mock-agent"]);
    expect(configDir).toBe(FIXTURES_DIR);
  });

  it("throws on missing config file", async () => {
    await expect(loadConfig("/nonexistent/axis.config.json")).rejects.toThrow("Could not read config file");
  });
});

describe("discoverScenarios", () => {
  it("discovers scenario files and assigns key from filename", async () => {
    const scenarios = await discoverScenarios(FIXTURES_DIR, "./scenarios");

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios[0].key).toBe("hello-world");
    expect(scenarios[0].name).toBeDefined();
    expect(scenarios[0].prompt).toBeDefined();
    expect(scenarios[0].rubric).toBeDefined();
  });

  it("filters scenarios by key", async () => {
    const filtered = await discoverScenarios(FIXTURES_DIR, "./scenarios", ["hello-world"]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].key).toBe("hello-world");
  });

  it("returns empty when filter matches nothing", async () => {
    const filtered = await discoverScenarios(FIXTURES_DIR, "./scenarios", ["nonexistent"]);
    expect(filtered).toHaveLength(0);
  });

  it("returns all scenarios when filter is ['*']", async () => {
    const all = await discoverScenarios(FIXTURES_DIR, "./scenarios");
    const wildcard = await discoverScenarios(FIXTURES_DIR, "./scenarios", ["*"]);

    expect(wildcard.length).toBe(all.length);
  });

  it("preserves agents field from scenario JSON", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
    const scenariosDir = path.join(tmpDir, "scenarios");
    await fs.mkdir(scenariosDir, { recursive: true });
    await fs.writeFile(
      path.join(scenariosDir, "gemini-only.json"),
      JSON.stringify({
        name: "Gemini Only",
        prompt: "test",
        rubric: "test",
        agents: ["gemini"],
      }),
    );

    const scenarios = await discoverScenarios(tmpDir, "./scenarios");
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].agents).toEqual(["gemini"]);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws on nonexistent directory", async () => {
    await expect(discoverScenarios(FIXTURES_DIR, "./nonexistent")).rejects.toThrow(
      "Could not read scenarios directory",
    );
  });

  describe("nested directories", () => {
    let tmpDir: string;

    async function writeScenario(relativePath: string, name: string) {
      const fullPath = path.join(tmpDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(
        fullPath,
        JSON.stringify({
          name,
          prompt: "test",
          rubric: [{ check: "test", weight: 1.0 }],
        }),
      );
    }

    it("walks subdirectories and derives keys from relative paths", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));

      await writeScenario("scenarios/simple.json", "Simple");
      await writeScenario("scenarios/cms/create-post.json", "Create Post");
      await writeScenario("scenarios/cms/delete-post.json", "Delete Post");
      await writeScenario("scenarios/auth/login/basic.json", "Basic Login");

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");

      const keys = scenarios.map((s) => s.key);
      expect(keys).toContain("simple");
      expect(keys).toContain("cms/create-post");
      expect(keys).toContain("cms/delete-post");
      expect(keys).toContain("auth/login/basic");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("filters with glob prefix pattern (cms/*)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));

      await writeScenario("scenarios/simple.json", "Simple");
      await writeScenario("scenarios/cms/create-post.json", "Create Post");
      await writeScenario("scenarios/cms/delete-post.json", "Delete Post");

      const filtered = await discoverScenarios(tmpDir, "./scenarios", ["cms/*"]);

      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.key.startsWith("cms/"))).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("filters with deep glob pattern (auth/**)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));

      await writeScenario("scenarios/simple.json", "Simple");
      await writeScenario("scenarios/auth/login/basic.json", "Basic Login");
      await writeScenario("scenarios/auth/logout.json", "Logout");

      const filtered = await discoverScenarios(tmpDir, "./scenarios", ["auth/**"]);

      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.key.startsWith("auth/"))).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
