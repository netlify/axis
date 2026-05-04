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

  describe("variants", () => {
    let tmpDir: string;

    async function writeScenarioJson(relativePath: string, data: Record<string, unknown>) {
      const fullPath = path.join(tmpDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, JSON.stringify(data));
    }

    it("returns single scenario when no variants defined", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/simple.json", {
        name: "Simple",
        prompt: "test",
        rubric: "test rubric",
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("simple");
      expect(scenarios[0].name).toBe("Simple");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("returns single scenario when variants is empty array", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/simple.json", {
        name: "Simple",
        prompt: "test",
        rubric: "test rubric",
        variants: [],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("simple");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("expands variants into separate scenarios with @ keys", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Test",
        prompt: "base prompt",
        rubric: "base rubric",
        variants: [
          { name: "variant-a" },
          { name: "variant-b" },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(2);

      const keys = scenarios.map((s) => s.key);
      expect(keys).toContain("test@variant-a");
      expect(keys).toContain("test@variant-b");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("inherits parent fields when variant does not override", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "parent prompt",
        rubric: "parent rubric",
        skills: ["./base-skill"],
        variants: [{ name: "v1" }],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].prompt).toBe("parent prompt");
      expect(scenarios[0].rubric).toBe("parent rubric");
      expect(scenarios[0].skills).toEqual(["./base-skill"]);
      expect(scenarios[0].name).toBe("Parent [v1]");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("uses variant overrides when provided", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "parent prompt",
        rubric: "parent rubric",
        variants: [
          { name: "v1", prompt: "override prompt", rubric: "override rubric" },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].prompt).toBe("override prompt");
      expect(scenarios[0].rubric).toBe("override rubric");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant skills replace parent skills (not merge)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        skills: ["./parent-skill"],
        variants: [
          { name: "v1", skills: ["./variant-skill"] },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios[0].skills).toEqual(["./variant-skill"]);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant mcp_servers merge with parent (variant wins on conflict)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        mcp_servers: {
          shared: { type: "stdio", command: "parent-cmd" },
          parent_only: { type: "http", url: "https://parent.com" },
        },
        variants: [
          {
            name: "v1",
            mcp_servers: {
              shared: { type: "stdio", command: "variant-cmd" },
              variant_only: { type: "http", url: "https://variant.com" },
            },
          },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios[0].mcp_servers).toEqual({
        shared: { type: "stdio", command: "variant-cmd" },
        parent_only: { type: "http", url: "https://parent.com" },
        variant_only: { type: "http", url: "https://variant.com" },
      });

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant skip overrides parent skip", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        skip: true,
        variants: [
          { name: "active", skip: false },
          { name: "skipped" },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      const active = scenarios.find((s) => s.key === "test@active")!;
      const skipped = scenarios.find((s) => s.key === "test@skipped")!;

      expect(active.skip).toBe(false);
      expect(skipped.skip).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant setup/teardown replace parent (not merge)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        setup: [{ action: "run_script", command: "parent-setup" }],
        variants: [
          { name: "v1", setup: [{ action: "run_script", command: "variant-setup" }] },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios[0].setup).toEqual([{ action: "run_script", command: "variant-setup" }]);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("detects duplicate keys across variant and non-variant scenarios", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));

      // Create a scenario file whose variant key collides with another file
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        variants: [{ name: "other" }],
      });
      // This file has key "test@other" which collides with the variant above
      await writeScenarioJson("scenarios/test@other.json", {
        name: "Collider",
        prompt: "test",
        rubric: "test",
      });

      await expect(discoverScenarios(tmpDir, "./scenarios")).rejects.toThrow("Duplicate scenario key");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("filters by base key to match all variants", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Test",
        prompt: "test",
        rubric: "test",
        variants: [
          { name: "v1" },
          { name: "v2" },
        ],
      });
      await writeScenarioJson("scenarios/other.json", {
        name: "Other",
        prompt: "test",
        rubric: "test",
      });

      const filtered = await discoverScenarios(tmpDir, "./scenarios", ["test"]);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.key.startsWith("test@"))).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("filters by exact variant key", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Test",
        prompt: "test",
        rubric: "test",
        variants: [
          { name: "v1" },
          { name: "v2" },
        ],
      });

      const filtered = await discoverScenarios(tmpDir, "./scenarios", ["test@v1"]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].key).toBe("test@v1");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("glob filter matches variants by base key", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/cms/post.json", {
        name: "Post",
        prompt: "test",
        rubric: "test",
        variants: [
          { name: "v1" },
          { name: "v2" },
        ],
      });
      await writeScenarioJson("scenarios/other.json", {
        name: "Other",
        prompt: "test",
        rubric: "test",
      });

      const filtered = await discoverScenarios(tmpDir, "./scenarios", ["cms/*"]);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.key.startsWith("cms/post@"))).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant agents override parent agents", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Test",
        prompt: "test",
        rubric: "test",
        agents: ["claude-code"],
        variants: [
          { name: "gemini-only", agents: ["gemini"] },
          { name: "inherits" },
        ],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      const gemini = scenarios.find((s) => s.key === "test@gemini-only")!;
      const inherits = scenarios.find((s) => s.key === "test@inherits")!;

      expect(gemini.agents).toEqual(["gemini"]);
      expect(inherits.agents).toEqual(["claude-code"]);

      await fs.rm(tmpDir, { recursive: true });
    });
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
