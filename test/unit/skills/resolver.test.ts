import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSkills, findSkillDir } from "../../../src/skills/resolver.js";
import { silentLogger } from "../../../src/types/output.js";

// Mock execFileSync for git clone tests
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
const mockExecFileSync = vi.mocked(execFileSync);

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-skills-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findSkillDir", () => {
  it("returns the directory when SKILL.md is at root", () => {
    const skillDir = path.join(tmpDir, "my-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# My Skill");

    expect(findSkillDir(skillDir)).toBe(skillDir);
  });

  it("returns the nested directory when SKILL.md is one level deep", () => {
    const repoDir = path.join(tmpDir, "repo");
    const nestedSkill = path.join(repoDir, "skill-subdir");
    fs.mkdirSync(nestedSkill, { recursive: true });
    fs.writeFileSync(path.join(nestedSkill, "SKILL.md"), "# Nested Skill");

    expect(findSkillDir(repoDir)).toBe(nestedSkill);
  });

  it("returns null when no SKILL.md is found", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);

    expect(findSkillDir(emptyDir)).toBeNull();
  });

  it("skips hidden directories and node_modules", () => {
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".hidden", "SKILL.md"), "# Hidden");
    fs.mkdirSync(path.join(repoDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "node_modules", "pkg", "SKILL.md"), "# NM");

    expect(findSkillDir(repoDir)).toBeNull();
  });

  it("returns null for non-existent directory", () => {
    expect(findSkillDir(path.join(tmpDir, "does-not-exist"))).toBeNull();
  });
});

describe("resolveSkills", () => {
  const configDir = "/fake/config";

  it("resolves an absolute local path", async () => {
    const skillDir = path.join(tmpDir, "local-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Local Skill");

    const results = await resolveSkills({
      sources: [skillDir],
      configDir,
      cacheDir: path.join(tmpDir, "cache"),
      logger: silentLogger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("local-skill");
    expect(results[0].path).toBe(skillDir);
  });

  it("resolves local path starting with ./", async () => {
    const testConfigDir = path.join(tmpDir, "project");
    fs.mkdirSync(testConfigDir);
    const skillDir = path.join(testConfigDir, "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# My Skill");

    const results = await resolveSkills({
      sources: ["./skills/my-skill"],
      configDir: testConfigDir,
      cacheDir: path.join(tmpDir, "cache"),
      logger: silentLogger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("my-skill");
    expect(results[0].path).toBe(skillDir);
  });

  it("parses GitHub shorthand and clones", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const targetDir = (args as string[])[5];
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "SKILL.md"), "# Cloned Skill");
      return Buffer.from("");
    });

    const results = await resolveSkills({
      sources: ["netlify/axis-skill-deploy"],
      configDir,
      cacheDir,
      logger: silentLogger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("netlify-axis-skill-deploy");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "https://github.com/netlify/axis-skill-deploy.git",
        expect.stringContaining("netlify"),
      ],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("parses GitHub URL and clones", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const targetDir = (args as string[])[5];
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "SKILL.md"), "# URL Skill");
      return Buffer.from("");
    });

    const results = await resolveSkills({
      sources: ["https://github.com/owner/my-skill"],
      configDir,
      cacheDir,
      logger: silentLogger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("owner-my-skill");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "--single-branch", "https://github.com/owner/my-skill.git", expect.any(String)],
      expect.any(Object),
    );
  });

  it("skips clone when cache directory exists", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const cachedDir = path.join(cacheDir, "netlify", "cached-skill");
    fs.mkdirSync(cachedDir, { recursive: true });
    fs.writeFileSync(path.join(cachedDir, "SKILL.md"), "# Cached");

    const results = await resolveSkills({
      sources: ["netlify/cached-skill"],
      configDir,
      cacheDir,
      logger: silentLogger,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("netlify-cached-skill");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("re-clones when refresh is true", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    const cachedDir = path.join(cacheDir, "netlify", "stale-skill");
    fs.mkdirSync(cachedDir, { recursive: true });
    fs.writeFileSync(path.join(cachedDir, "SKILL.md"), "# Stale");

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const targetDir = (args as string[])[5];
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "SKILL.md"), "# Refreshed");
      return Buffer.from("");
    });

    const results = await resolveSkills({
      sources: ["netlify/stale-skill"],
      configDir,
      cacheDir,
      logger: silentLogger,
      refresh: true,
    });

    expect(results).toHaveLength(1);
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it("throws for invalid source format", async () => {
    await expect(
      resolveSkills({
        sources: ["not a valid source!"],
        configDir,
        cacheDir: path.join(tmpDir, "cache"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("Invalid skill source");
  });

  it("throws when SKILL.md is missing from resolved directory", async () => {
    const emptySkill = path.join(tmpDir, "empty-skill");
    fs.mkdirSync(emptySkill);

    const testConfigDir = path.join(tmpDir, "cfg");
    fs.mkdirSync(testConfigDir);

    await expect(
      resolveSkills({
        sources: [emptySkill],
        configDir: testConfigDir,
        cacheDir: path.join(tmpDir, "cache"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("No SKILL.md found");
  });

  it("throws when clone fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("git clone failed: repository not found");
    });

    await expect(
      resolveSkills({
        sources: ["nonexistent/repo"],
        configDir,
        cacheDir: path.join(tmpDir, "cache"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("Failed to clone skill");
  });
});
