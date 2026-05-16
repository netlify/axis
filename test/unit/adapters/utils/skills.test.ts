import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeClaudeSkills, writeCodexSkills, writeGeminiSkills } from "../../../../src/adapters/utils/skills.js";
import type { ResolvedSkill } from "../../../../src/types/config.js";

let tmpDir: string;
let skillSource: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-skills-writer-test-"));

  // Create a source skill directory with realistic structure
  skillSource = path.join(tmpDir, "source-skill");
  fs.mkdirSync(skillSource);
  fs.writeFileSync(path.join(skillSource, "SKILL.md"), "# Deploy Skill\nDeploy to Netlify");
  fs.mkdirSync(path.join(skillSource, "scripts"));
  fs.writeFileSync(path.join(skillSource, "scripts", "deploy.sh"), "#!/bin/bash\necho deploy");
  fs.mkdirSync(path.join(skillSource, "references"));
  fs.writeFileSync(path.join(skillSource, "references", "api.md"), "# API Reference");

  // Create dirs that should be skipped
  fs.mkdirSync(path.join(skillSource, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(skillSource, ".git", "HEAD"), "ref: refs/heads/main");
  fs.mkdirSync(path.join(skillSource, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(skillSource, ".github", "workflows", "ci.yml"), "name: CI");
  fs.mkdirSync(path.join(skillSource, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(skillSource, "node_modules", "pkg", "index.js"), "module.exports = {}");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: set the skill path and return the skills array
function skillsWithPath(): ResolvedSkill[] {
  return [{ name: "deploy-skill", path: skillSource }];
}

describe("writeClaudeSkills", () => {
  it("copies SKILL.md and supporting files to {configDir}/skills/{name}/", () => {
    const configDir = path.join(tmpDir, "claude-config");
    fs.mkdirSync(configDir);

    writeClaudeSkills(configDir, skillsWithPath());

    const target = path.join(configDir, "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toContain("Deploy Skill");
    expect(fs.existsSync(path.join(target, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.existsSync(path.join(target, "references", "api.md"))).toBe(true);
  });

  it("excludes .git, .github, and node_modules", () => {
    const configDir = path.join(tmpDir, "claude-config-2");
    fs.mkdirSync(configDir);

    writeClaudeSkills(configDir, skillsWithPath());

    const target = path.join(configDir, "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
  });

  it("handles multiple skills", () => {
    const configDir = path.join(tmpDir, "claude-config-multi");
    fs.mkdirSync(configDir);

    // Create a second skill source
    const skill2 = path.join(tmpDir, "source-skill-2");
    fs.mkdirSync(skill2);
    fs.writeFileSync(path.join(skill2, "SKILL.md"), "# Lint Skill");

    writeClaudeSkills(configDir, [
      { name: "deploy-skill", path: skillSource },
      { name: "lint-skill", path: skill2 },
    ]);

    expect(fs.existsSync(path.join(configDir, "skills", "deploy-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "skills", "lint-skill", "SKILL.md"))).toBe(true);
  });
});

describe("writeCodexSkills", () => {
  it("copies SKILL.md and supporting files to .agents/skills/{name}/", () => {
    const workspace = path.join(tmpDir, "codex-workspace");
    fs.mkdirSync(workspace);

    writeCodexSkills(workspace, skillsWithPath());

    const target = path.join(workspace, ".agents", "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toContain("Deploy Skill");
    expect(fs.existsSync(path.join(target, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.existsSync(path.join(target, "references", "api.md"))).toBe(true);
  });

  it("excludes .git, .github, and node_modules", () => {
    const workspace = path.join(tmpDir, "codex-workspace-2");
    fs.mkdirSync(workspace);

    writeCodexSkills(workspace, skillsWithPath());

    const target = path.join(workspace, ".agents", "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
  });
});

describe("writeGeminiSkills", () => {
  it("copies SKILL.md and supporting files to {geminiHome}/skills/{name}/", () => {
    const geminiHome = path.join(tmpDir, "gemini-home");
    fs.mkdirSync(geminiHome);

    writeGeminiSkills(geminiHome, skillsWithPath());

    const target = path.join(geminiHome, "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toContain("Deploy Skill");
    expect(fs.existsSync(path.join(target, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.existsSync(path.join(target, "references", "api.md"))).toBe(true);
  });

  it("excludes .git, .github, and node_modules", () => {
    const geminiHome = path.join(tmpDir, "gemini-home-2");
    fs.mkdirSync(geminiHome);

    writeGeminiSkills(geminiHome, skillsWithPath());

    const target = path.join(geminiHome, "skills", "deploy-skill");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
  });
});
