import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import {
  expandRemoteScenarios,
  isRemoteScenarioUrl,
  mergeRemoteConfig,
  parseRemoteUrl,
  remoteCloneDir,
  setCloneImplForTests,
} from "../../../src/config/remote-scenarios.js";
import type { AxisConfig } from "../../../src/types/config.js";

let tmpDir: string;
let restoreClone: (() => void) | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "axis-fed-"));
});

afterEach(async () => {
  if (restoreClone) {
    restoreClone();
    restoreClone = undefined;
  }
  if (tmpDir) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("isRemoteScenarioUrl", () => {
  it("accepts https/http github urls", () => {
    expect(isRemoteScenarioUrl("https://github.com/netlify/axis")).toBe(true);
    expect(isRemoteScenarioUrl("https://github.com/netlify/axis.git")).toBe(true);
    expect(isRemoteScenarioUrl("http://gitlab.com/team/repo")).toBe(true);
  });

  it("accepts git:// and ssh:// urls", () => {
    expect(isRemoteScenarioUrl("git://github.com/o/r")).toBe(true);
    expect(isRemoteScenarioUrl("ssh://git@github.com/o/r")).toBe(true);
  });

  it("rejects local paths and shorthand", () => {
    expect(isRemoteScenarioUrl("./scenarios")).toBe(false);
    expect(isRemoteScenarioUrl("../foo")).toBe(false);
    expect(isRemoteScenarioUrl("/abs/path")).toBe(false);
    expect(isRemoteScenarioUrl("netlify/axis")).toBe(false);
  });
});

describe("parseRemoteUrl", () => {
  it("extracts host/owner/repo", () => {
    const parsed = parseRemoteUrl("https://github.com/netlify/all-scenarios");
    expect(parsed).toEqual({
      url: "https://github.com/netlify/all-scenarios",
      host: "github.com",
      owner: "netlify",
      repo: "all-scenarios",
    });
  });

  it("strips trailing .git", () => {
    const parsed = parseRemoteUrl("https://github.com/netlify/axis.git");
    expect(parsed.repo).toBe("axis");
  });

  it("throws on malformed URLs", () => {
    expect(() => parseRemoteUrl("https://github.com/only-one-segment")).toThrow(/Invalid remote scenarios URL/);
  });
});

describe("remoteCloneDir", () => {
  it("uses reversed host segments", () => {
    const parsed = parseRemoteUrl("https://github.com/netlify/all-scenarios");
    const dir = remoteCloneDir("/parent", parsed);
    expect(dir).toBe(path.join("/parent", ".axis", "remotes", "com.github", "netlify", "all-scenarios"));
  });
});

/** Write an axis.config.json synchronously at the given dir. */
function writeConfig(dir: string, body: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "axis.config.json"), JSON.stringify(body));
}

function makeFakeClone(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

describe("expandRemoteScenarios", () => {
  it("passes through inputs with no URLs", async () => {
    const input = ["./scenarios", { key: "inline", name: "x", prompt: "y" }];
    const out = await expandRemoteScenarios(input as any, { configDir: tmpDir });
    expect(out).toBe(input);
  });

  it("passes through undefined", async () => {
    const out = await expandRemoteScenarios(undefined, { configDir: tmpDir });
    expect(out).toBeUndefined();
  });

  it("expands a URL entry using the remote config's scenarios list", async () => {
    const url = "https://github.com/netlify/all-scenarios";
    const cloneDir = path.join(tmpDir, ".axis", "remotes", "com.github", "netlify", "all-scenarios");

    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, { scenarios: ["./my-scenarios", "./other-stuff"], agents: ["claude-code"] });
    });

    const out = await expandRemoteScenarios(["./scenarios", url], { configDir: tmpDir });

    expect(out).toEqual([
      "./scenarios",
      path.resolve(cloneDir, "./my-scenarios"),
      path.resolve(cloneDir, "./other-stuff"),
    ]);
  });

  it("inlines a remote config's inline scenarios", async () => {
    const url = "https://github.com/netlify/all-scenarios";
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: [{ key: "inline-remote", name: "remote", prompt: "do thing", judge: "looks good" }],
        agents: ["claude-code"],
      });
    });

    const out = (await expandRemoteScenarios([url], { configDir: tmpDir })) as unknown[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "inline-remote", name: "remote", prompt: "do thing" });
  });

  it("falls back to repo root when the clone has no axis.config", async () => {
    const url = "https://github.com/netlify/no-config";
    const cloneDir = path.join(tmpDir, ".axis", "remotes", "com.github", "netlify", "no-config");

    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      // No axis.config.*; bare repo
    });

    const out = await expandRemoteScenarios([url], { configDir: tmpDir });
    expect(out).toEqual([cloneDir]);
  });

  it("defaults remote's scenarios to ./scenarios when omitted", async () => {
    const url = "https://github.com/netlify/has-config";
    const cloneDir = path.join(tmpDir, ".axis", "remotes", "com.github", "netlify", "has-config");

    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, { agents: ["claude-code"] });
    });

    const out = await expandRemoteScenarios([url], { configDir: tmpDir });
    expect(out).toEqual([path.resolve(cloneDir, "./scenarios")]);
  });

  it("throws when a remote config references another URL and maxDepth=1", async () => {
    const url = "https://github.com/netlify/parent";
    const nested = "https://github.com/netlify/child";

    restoreClone = setCloneImplForTests((cloneUrl, target) => {
      makeFakeClone(target);
      if (cloneUrl === url) {
        writeConfig(target, { scenarios: ["./local", nested], agents: ["claude-code"] });
      } else {
        writeConfig(target, { scenarios: ["./inner"], agents: ["claude-code"] });
      }
    });

    await expect(expandRemoteScenarios([url], { configDir: tmpDir, maxDepth: 1 })).rejects.toThrow(
      /Remote scenario depth limit reached/,
    );
  });

  it("recurses when maxDepth allows it", async () => {
    const url = "https://github.com/netlify/parent";
    const nested = "https://github.com/netlify/child";

    restoreClone = setCloneImplForTests((cloneUrl, target) => {
      makeFakeClone(target);
      if (cloneUrl === url) {
        writeConfig(target, { scenarios: [nested], agents: ["claude-code"] });
      } else {
        writeConfig(target, { scenarios: ["./inner"], agents: ["claude-code"] });
      }
    });

    const parentClone = path.join(tmpDir, ".axis", "remotes", "com.github", "netlify", "parent");
    const childClone = path.join(parentClone, ".axis", "remotes", "com.github", "netlify", "child");

    const out = await expandRemoteScenarios([url], { configDir: tmpDir, maxDepth: 2 });
    expect(out).toEqual([path.resolve(childClone, "./inner")]);
  });

  it("detects cycles", async () => {
    const a = "https://github.com/netlify/a";
    const b = "https://github.com/netlify/b";

    restoreClone = setCloneImplForTests((cloneUrl, target) => {
      makeFakeClone(target);
      if (cloneUrl === a) {
        writeConfig(target, { scenarios: [b], agents: ["claude-code"] });
      } else {
        writeConfig(target, { scenarios: [a], agents: ["claude-code"] });
      }
    });

    await expect(expandRemoteScenarios([a], { configDir: tmpDir, maxDepth: 5 })).rejects.toThrow(
      /Cyclic remote scenario reference/,
    );
  });

  it("rejects malformed URLs early", async () => {
    await expect(expandRemoteScenarios(["https://github.com/only-one-segment"], { configDir: tmpDir })).rejects.toThrow(
      /Invalid remote scenarios URL/,
    );
  });
});

describe("mergeRemoteConfig", () => {
  const NETLIFY_URL = "https://github.com/netlify/all-scenarios";
  let cloneDir: string;

  beforeEach(() => {
    cloneDir = path.join(tmpDir, ".axis", "remotes", "com.github", "netlify", "all-scenarios");
  });

  function baseParent(): AxisConfig {
    return { scenarios: [NETLIFY_URL], agents: ["claude-code"] };
  }

  it("returns config untouched when scenarios has no URL entries", async () => {
    const config: AxisConfig = { scenarios: ["./local"], agents: ["claude-code"] };
    restoreClone = setCloneImplForTests(() => {
      throw new Error("should not clone");
    });
    const out = await mergeRemoteConfig(config, tmpDir);
    expect(out).toBe(config);
    expect(out.scenarios).toEqual(["./local"]);
  });

  it("unions parent and remote env", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["claude-code"],
        env: ["REMOTE_VAR", "SHARED_VAR"],
      });
    });
    const config = { ...baseParent(), env: ["PARENT_VAR", "SHARED_VAR"] };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.env).toEqual(["PARENT_VAR", "SHARED_VAR", "REMOTE_VAR"]);
  });

  it("merges mcp_servers with parent winning on collision", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["claude-code"],
        mcp_servers: {
          remote_only: { type: "http", url: "https://remote.example" },
          shared: { type: "http", url: "https://remote-shared.example" },
        },
      });
    });
    const config: AxisConfig = {
      ...baseParent(),
      mcp_servers: { shared: { type: "http", url: "https://parent-shared.example" } },
    };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.mcp_servers).toEqual({
      remote_only: { type: "http", url: "https://remote.example" },
      shared: { type: "http", url: "https://parent-shared.example" },
    });
  });

  it("re-resolves local-path skills to absolute under cloneDir; URLs pass through; parent first", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["claude-code"],
        skills: ["./skills/local-skill", "https://github.com/some/skill", "owner/repo"],
      });
    });
    const config: AxisConfig = {
      ...baseParent(),
      skills: ["./parent-skill"],
    };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.skills).toEqual([
      "./parent-skill",
      path.resolve(cloneDir, "./skills/local-skill"),
      "https://github.com/some/skill",
      "owner/repo",
    ]);
  });

  it("concats and dedups artifacts, parent first", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["claude-code"],
        artifacts: ["**/*.log", "*.md"],
      });
    });
    const config: AxisConfig = { ...baseParent(), artifacts: ["*.md", "**/*.html"] };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.artifacts).toEqual(["*.md", "**/*.html", "**/*.log"]);
  });

  it("re-resolves adapter module paths and lets parent win on name collision", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["claude-code"],
        adapters: { my_agent: "./adapters/my-agent.ts", shared_agent: "./adapters/remote-shared.ts" },
      });
    });
    const config: AxisConfig = {
      ...baseParent(),
      adapters: { shared_agent: "./parent-shared.ts" },
    };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.adapters).toEqual({
      my_agent: path.resolve(cloneDir, "./adapters/my-agent.ts"),
      shared_agent: "./parent-shared.ts",
    });
  });

  it("ignores remote agents/settings/judging/beforeAll/afterAll/name", async () => {
    restoreClone = setCloneImplForTests((_url, target) => {
      makeFakeClone(target);
      writeConfig(target, {
        scenarios: ["./scenarios"],
        agents: ["codex", "gemini"],
        name: "remote project",
        settings: { concurrency: 999 },
        judging: { agents: ["claude-code"] },
        beforeAll: [{ action: "run_script", command: "echo remote-beforeAll" }],
        afterAll: [{ action: "run_script", command: "echo remote-afterAll" }],
      });
    });
    const config: AxisConfig = {
      scenarios: [NETLIFY_URL],
      agents: ["claude-code"],
      name: "parent project",
      settings: { concurrency: 4 },
    };
    await mergeRemoteConfig(config, tmpDir);
    expect(config.agents).toEqual(["claude-code"]);
    expect(config.name).toBe("parent project");
    expect(config.settings).toEqual({ concurrency: 4 });
    expect(config.judging).toBeUndefined();
    expect(config.beforeAll).toBeUndefined();
    expect(config.afterAll).toBeUndefined();
  });

  it("bubbles env up through nested remote references", async () => {
    const a = "https://github.com/netlify/a";
    const b = "https://github.com/netlify/b";
    restoreClone = setCloneImplForTests((url, target) => {
      makeFakeClone(target);
      if (url === a) {
        writeConfig(target, {
          scenarios: ["./scenarios", b],
          agents: ["claude-code"],
          env: ["FROM_A"],
        });
      } else {
        writeConfig(target, {
          scenarios: ["./scenarios"],
          agents: ["claude-code"],
          env: ["FROM_B"],
        });
      }
    });
    const config: AxisConfig = { scenarios: [a], agents: ["claude-code"], env: ["FROM_PARENT"] };
    await mergeRemoteConfig(config, tmpDir, { maxDepth: 2 });
    expect(config.env).toEqual(["FROM_PARENT", "FROM_A", "FROM_B"]);
  });
});
