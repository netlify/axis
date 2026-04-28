import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedSkill } from "../../types/config.js";

/** Directories to skip when copying skill directories. */
const SKIP_DIRS = new Set([".git", ".github", "node_modules"]);

/**
 * Write skills for Claude Code.
 * Copies each skill directory to {workspace}/.claude/skills/{name}/
 */
export function writeClaudeSkills(workspace: string, skills: ResolvedSkill[]): void {
  for (const skill of skills) {
    const target = path.join(workspace, ".claude", "skills", skill.name);
    copyDirRecursive(skill.path, target);
  }
}

/**
 * Write skills for Codex.
 * Copies each skill directory to {workspace}/.agents/skills/{name}/
 */
export function writeCodexSkills(workspace: string, skills: ResolvedSkill[]): void {
  for (const skill of skills) {
    const target = path.join(workspace, ".agents", "skills", skill.name);
    copyDirRecursive(skill.path, target);
  }
}

/**
 * Write skills for Gemini CLI.
 * Copies each skill directory to {geminiHome}/skills/{name}/
 */
export function writeGeminiSkills(geminiHome: string, skills: ResolvedSkill[]): void {
  for (const skill of skills) {
    const target = path.join(geminiHome, "skills", skill.name);
    copyDirRecursive(skill.path, target);
  }
}

/** Recursively copy a directory, skipping .git, .github, and node_modules. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
