import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedSkill } from "../types/config.js";
import type { Logger } from "../types/output.js";

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const GITHUB_SHORTHAND_RE = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

export interface ResolveSkillsOptions {
  sources: string[];
  configDir: string;
  cacheDir: string;
  logger: Logger;
  refresh?: boolean;
}

export async function resolveSkills(options: ResolveSkillsOptions): Promise<ResolvedSkill[]> {
  const results: ResolvedSkill[] = [];
  for (const source of options.sources) {
    results.push(resolveSkill(source, options));
  }
  return results;
}

function resolveSkill(source: string, options: ResolveSkillsOptions): ResolvedSkill {
  const { configDir, cacheDir, logger, refresh } = options;
  let dir: string;
  let name: string;

  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    // Local path — resolve relative to config directory
    dir = path.resolve(configDir, source);
    name = path.basename(dir);
  } else if (GITHUB_URL_RE.test(source)) {
    const match = source.match(GITHUB_URL_RE)!;
    const [, owner, repo] = match;
    name = `${owner}-${repo}`;
    dir = path.join(cacheDir, owner, repo);
    cloneIfNeeded(source.replace(/\.git$/, "") + ".git", dir, logger, refresh);
  } else if (GITHUB_SHORTHAND_RE.test(source)) {
    const [owner, repo] = source.split("/");
    name = `${owner}-${repo}`;
    dir = path.join(cacheDir, owner, repo);
    cloneIfNeeded(`https://github.com/${owner}/${repo}.git`, dir, logger, refresh);
  } else {
    throw new Error(
      `Invalid skill source: "${source}". Expected a local path (./...), GitHub shorthand (owner/repo), or GitHub URL.`,
    );
  }

  const skillDir = findSkillDir(dir);
  if (!skillDir) {
    throw new Error(`No SKILL.md found in skill "${source}" (looked in ${dir})`);
  }

  return { name, path: skillDir };
}

/**
 * Find the directory containing SKILL.md.
 * Checks the root directory first, then one level of subdirectories
 * (for repos where the skill lives in a subdirectory).
 */
export function findSkillDir(dir: string): string | null {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    return dir;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const nested = path.join(dir, entry.name);
      if (fs.existsSync(path.join(nested, "SKILL.md"))) {
        return nested;
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return null;
}

function cloneIfNeeded(url: string, targetDir: string, logger: Logger, refresh?: boolean): void {
  if (fs.existsSync(targetDir) && !refresh) {
    return;
  }

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  logger.info(`Cloning skill: ${url}`);

  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", url, targetDir], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(`Failed to clone skill from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
