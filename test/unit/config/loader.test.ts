import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  loadConfig,
  discoverScenarios,
  matchesScenarioFilter,
  matchesAgentFilter,
} from "../../../src/config/loader.js";

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

  describe("JS/TS configs", () => {
    let tmpDir: string;
    const originalCwd = process.cwd();

    afterEach(async () => {
      process.chdir(originalCwd);
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("loads a .js config with an object default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-js-cfg-"));
      const configPath = path.join(tmpDir, "axis.config.js");
      await fs.writeFile(configPath, `export default { scenarios: "./scenarios", agents: ["mock-agent"] };\n`);

      const { config, configDir } = await loadConfig(configPath);
      expect(config.scenarios).toBe("./scenarios");
      expect(config.agents).toEqual(["mock-agent"]);
      expect(configDir).toBe(tmpDir);
    });

    it("loads a .js config with a sync function default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-js-cfg-"));
      const configPath = path.join(tmpDir, "axis.config.js");
      await fs.writeFile(configPath, `export default () => ({ scenarios: "./scenarios", agents: ["mock-agent"] });\n`);

      const { config } = await loadConfig(configPath);
      expect(config.agents).toEqual(["mock-agent"]);
    });

    it("loads a .js config with an async function default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-js-cfg-"));
      const configPath = path.join(tmpDir, "axis.config.js");
      await fs.writeFile(
        configPath,
        `export default async () => ({ scenarios: "./scenarios", agents: ["mock-agent"] });\n`,
      );

      const { config } = await loadConfig(configPath);
      expect(config.agents).toEqual(["mock-agent"]);
    });

    it("loads a .ts config via jiti", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-ts-cfg-"));
      const configPath = path.join(tmpDir, "axis.config.ts");
      await fs.writeFile(
        configPath,
        `import type { AxisConfig } from "${path.resolve(import.meta.dirname, "../../../src/types/config.js")}";\n` +
          `const config: AxisConfig = { scenarios: "./scenarios", agents: ["mock-agent"] };\n` +
          `export default config;\n`,
      );

      const { config } = await loadConfig(configPath);
      expect(config.scenarios).toBe("./scenarios");
      expect(config.agents).toEqual(["mock-agent"]);
    });

    it("throws when JS config has no default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-js-cfg-"));
      const configPath = path.join(tmpDir, "axis.config.js");
      await fs.writeFile(configPath, `export const config = { scenarios: "./scenarios", agents: ["mock-agent"] };\n`);

      await expect(loadConfig(configPath)).rejects.toThrow("must have a default export");
    });

    it("defaults scenarios to './scenarios' when the field is omitted", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-default-"));
      const configPath = path.join(tmpDir, "axis.config.json");
      await fs.writeFile(configPath, JSON.stringify({ agents: ["mock-agent"] }));

      const { config } = await loadConfig(configPath);
      expect(config.scenarios).toBe("./scenarios");
    });

    it("probes default config extensions in priority order (.ts > .js > .json)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-probe-"));
      // Write all three — .ts should win
      await fs.writeFile(
        path.join(tmpDir, "axis.config.json"),
        JSON.stringify({ scenarios: "./from-json", agents: ["mock-agent"] }),
      );
      await fs.writeFile(
        path.join(tmpDir, "axis.config.js"),
        `export default { scenarios: "./from-js", agents: ["mock-agent"] };\n`,
      );
      await fs.writeFile(
        path.join(tmpDir, "axis.config.ts"),
        `export default { scenarios: "./from-ts", agents: ["mock-agent"] };\n`,
      );

      process.chdir(tmpDir);
      const { config } = await loadConfig();
      expect(config.scenarios).toBe("./from-ts");
    });

    it("falls back to .json default error when no config file exists", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-probe-"));
      process.chdir(tmpDir);
      await expect(loadConfig()).rejects.toThrow(/Could not read config file.*axis\.config\.json/);
    });
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
    await expect(discoverScenarios(FIXTURES_DIR, "./nonexistent")).rejects.toThrow("Could not read scenarios path");
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
        variants: [{ name: "variant-a" }, { name: "variant-b" }],
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
        variants: [{ name: "v1", prompt: "override prompt", rubric: "override rubric" }],
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
        variants: [{ name: "v1", skills: ["./variant-skill"] }],
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
        variants: [{ name: "active", skip: false }, { name: "skipped" }],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      const active = scenarios.find((s) => s.key === "test@active")!;
      const skipped = scenarios.find((s) => s.key === "test@skipped")!;

      expect(active.skip).toBe(false);
      expect(skipped.skip).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant artifacts replace parent (not merge)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        artifacts: ["parent.log", "shared.log"],
        variants: [{ name: "with-override", artifacts: ["variant.log"] }, { name: "inherits" }],
      });

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      const overridden = scenarios.find((s) => s.key === "test@with-override")!;
      const inherited = scenarios.find((s) => s.key === "test@inherits")!;

      expect(overridden.artifacts).toEqual(["variant.log"]);
      expect(inherited.artifacts).toEqual(["parent.log", "shared.log"]);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("variant setup/teardown replace parent (not merge)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-test-"));
      await writeScenarioJson("scenarios/test.json", {
        name: "Parent",
        prompt: "test",
        rubric: "test",
        setup: [{ action: "run_script", command: "parent-setup" }],
        variants: [{ name: "v1", setup: [{ action: "run_script", command: "variant-setup" }] }],
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
        variants: [{ name: "v1" }, { name: "v2" }],
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
        variants: [{ name: "v1" }, { name: "v2" }],
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
        variants: [{ name: "v1" }, { name: "v2" }],
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
        variants: [{ name: "gemini-only", agents: ["gemini"] }, { name: "inherits" }],
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

  describe("array input", () => {
    let tmpDir: string;

    async function writeScenario(relativePath: string, name: string, extra: Record<string, unknown> = {}) {
      const fullPath = path.join(tmpDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(
        fullPath,
        JSON.stringify({
          name,
          prompt: "test",
          rubric: [{ check: "test", weight: 1.0 }],
          ...extra,
        }),
      );
    }

    afterEach(async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("accepts an array with a single directory entry (equivalent to legacy string form)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));
      await writeScenario("scenarios/foo.json", "Foo");
      await writeScenario("scenarios/bar.json", "Bar");

      const scenarios = await discoverScenarios(tmpDir, ["./scenarios"]);
      expect(scenarios.map((s) => s.key).sort()).toEqual(["bar", "foo"]);
    });

    it("accepts a string pointing at a single .json file", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));
      await writeScenario("special.json", "Special");

      const scenarios = await discoverScenarios(tmpDir, "./special.json");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("special");
    });

    it("merges scenarios from multiple directory entries", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));
      await writeScenario("a/foo.json", "A Foo");
      await writeScenario("b/bar.json", "B Bar");

      const scenarios = await discoverScenarios(tmpDir, ["./a", "./b"]);
      expect(scenarios.map((s) => s.key).sort()).toEqual(["bar", "foo"]);
    });

    it("accepts inline scenario objects with a key", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));

      const scenarios = await discoverScenarios(tmpDir, [
        { key: "inline-1", name: "Inline 1", prompt: "p", rubric: "r" },
        { key: "inline-2", name: "Inline 2", prompt: "p", rubric: "r" },
      ]);

      expect(scenarios.map((s) => s.key).sort()).toEqual(["inline-1", "inline-2"]);
    });

    it("mixes path strings and inline scenarios", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));
      await writeScenario("scenarios/on-disk.json", "On Disk");

      const scenarios = await discoverScenarios(tmpDir, [
        "./scenarios",
        { key: "inline", name: "Inline", prompt: "p", rubric: "r" },
      ]);

      expect(scenarios.map((s) => s.key).sort()).toEqual(["inline", "on-disk"]);
    });

    it("expands variants on inline scenarios using inline key as base", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));

      const scenarios = await discoverScenarios(tmpDir, [
        {
          key: "params",
          name: "Params",
          prompt: "p",
          rubric: "r",
          variants: [{ name: "a" }, { name: "b" }],
        },
      ]);

      expect(scenarios.map((s) => s.key).sort()).toEqual(["params@a", "params@b"]);
    });

    it("detects duplicate keys across inline and on-disk scenarios", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-arr-"));
      await writeScenario("scenarios/clash.json", "On Disk Clash");

      await expect(
        discoverScenarios(tmpDir, ["./scenarios", { key: "clash", name: "Inline Clash", prompt: "p", rubric: "r" }]),
      ).rejects.toThrow("Duplicate scenario key");
    });
  });

  describe("module-based scenario files (.js/.ts)", () => {
    let tmpDir: string;

    afterEach(async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function writeFile(relativePath: string, content: string) {
      const fullPath = path.join(tmpDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    it("discovers .js scenarios with path-derived keys", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/foo.js", `export default { name: "Foo", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("foo");
      expect(scenarios[0].name).toBe("Foo");
    });

    it("discovers .ts scenarios via jiti", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile(
        "scenarios/typed.ts",
        `const s = { name: "Typed", prompt: "p", rubric: "r" };\nexport default s;\n`,
      );

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("typed");
    });

    it("derives keys from nested subdirectories for module files", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/cms/post.ts", `export default { name: "Post", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key)).toEqual(["cms/post"]);
    });

    it("calls a function default export and uses the resolved object", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/dyn.js", `export default async () => ({ name: "Dyn", prompt: "p", rubric: "r" });\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].name).toBe("Dyn");
    });

    it("silently skips module files with no default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/helper.ts", `export const util = () => 42;\n`);
      await writeFile("scenarios/real.ts", `export default { name: "Real", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key)).toEqual(["real"]);
    });

    it("silently skips module files whose default is not an object", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/string-default.ts", `export default "not a scenario";\n`);
      await writeFile("scenarios/array-default.ts", `export default [1, 2, 3];\n`);
      await writeFile("scenarios/real.ts", `export default { name: "Real", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key)).toEqual(["real"]);
    });

    it("discovers .json and .ts side-by-side in the same directory", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/json-one.json", JSON.stringify({ name: "JSON One", prompt: "p", rubric: "r" }));
      await writeFile("scenarios/ts-one.ts", `export default { name: "TS One", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key).sort()).toEqual(["json-one", "ts-one"]);
    });

    it("accepts a module scenario whose declared key matches the path-derived key", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile(
        "scenarios/has-key.ts",
        `export default { key: "has-key", name: "X", prompt: "p", rubric: "r" };\n`,
      );

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key)).toEqual(["has-key"]);
    });

    it("rejects a module scenario whose declared key does not match the path", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("scenarios/foo.ts", `export default { key: "bar", name: "X", prompt: "p", rubric: "r" };\n`);

      await expect(discoverScenarios(tmpDir, "./scenarios")).rejects.toThrow(
        `declared key "bar" does not match path-derived key "foo"`,
      );
    });

    it("expands variants from a module-defined scenario using path-derived base key", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile(
        "scenarios/with-variants.ts",
        `export default {
          name: "Variants",
          prompt: "p",
          rubric: "r",
          variants: [{ name: "a" }, { name: "b" }],
        };\n`,
      );

      const scenarios = await discoverScenarios(tmpDir, "./scenarios");
      expect(scenarios.map((s) => s.key).sort()).toEqual(["with-variants@a", "with-variants@b"]);
    });

    it("loads a single .ts file as a string entry (strict — throws on missing default)", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("lone.ts", `export default { name: "Lone", prompt: "p", rubric: "r" };\n`);

      const scenarios = await discoverScenarios(tmpDir, "./lone.ts");
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].key).toBe("lone");
    });

    it("throws when a single-file string entry has no default export", async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-mod-"));
      await writeFile("lone.ts", `export const x = 1;\n`);

      await expect(discoverScenarios(tmpDir, "./lone.ts")).rejects.toThrow("must default-export an object");
    });
  });
});

describe("matchesScenarioFilter", () => {
  it("matches exact full key including @variant", () => {
    expect(matchesScenarioFilter("cms/create-post@fastify", ["cms/create-post@fastify"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post@fastify", ["cms/create-post@express"])).toBe(false);
  });

  it("matches base key against all its variants", () => {
    expect(matchesScenarioFilter("cms/create-post@fastify", ["cms/create-post"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post", ["cms/create-post"])).toBe(true);
  });

  it("supports `dir/*` glob", () => {
    expect(matchesScenarioFilter("cms/create-post", ["cms/*"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post@v", ["cms/*"])).toBe(true);
    expect(matchesScenarioFilter("auth/login", ["cms/*"])).toBe(false);
  });

  it("supports `dir/**` recursive glob", () => {
    expect(matchesScenarioFilter("cms/posts/create", ["cms/**"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post@v", ["cms/**"])).toBe(true);
  });

  it("supports embedded glob with `**/` for cross-directory matches", () => {
    expect(matchesScenarioFilter("cms/create-post", ["**/*post*"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post@v", ["**/*post*"])).toBe(true);
    expect(matchesScenarioFilter("cms/list-users", ["**/*post*"])).toBe(false);
  });

  it("single-star glob does not cross `/` (standard glob semantics)", () => {
    // `*post*` matches `create-post` (no slash) but not `cms/create-post`.
    expect(matchesScenarioFilter("create-post", ["*post*"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post", ["*post*"])).toBe(false);
  });

  it("matches against full key (including @variant) for explicit variant globs", () => {
    expect(matchesScenarioFilter("cms/create-post@fastify", ["cms/create-post@*"])).toBe(true);
    expect(matchesScenarioFilter("cms/create-post", ["cms/create-post@*"])).toBe(false);
  });

  it("returns true if any pattern in the list matches", () => {
    expect(matchesScenarioFilter("cms/create-post", ["auth/*", "cms/*"])).toBe(true);
    expect(matchesScenarioFilter("billing/checkout", ["auth/*", "cms/*"])).toBe(false);
  });
});

describe("matchesAgentFilter", () => {
  it("matches exact agent name", () => {
    expect(matchesAgentFilter("claude-code|opus", ["claude-code|opus"])).toBe(true);
    expect(matchesAgentFilter("claude-code|opus", ["claude-code|sonnet"])).toBe(false);
  });

  it("supports glob across model suffix", () => {
    expect(matchesAgentFilter("claude-code|opus", ["claude-code|*"])).toBe(true);
    expect(matchesAgentFilter("claude-code|sonnet", ["claude-code|*"])).toBe(true);
    expect(matchesAgentFilter("codex|gpt", ["claude-code|*"])).toBe(false);
  });

  it("matches any pattern in the list", () => {
    expect(matchesAgentFilter("codex|gpt", ["claude-code|*", "codex*"])).toBe(true);
  });
});
