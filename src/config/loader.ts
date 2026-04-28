import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AxisConfig } from "../types/config.js";
import type { Scenario } from "../types/scenario.js";
import { validateConfig, validateScenario } from "./validator.js";
import { formatError } from "../types/output.js";

export async function loadConfig(configPath?: string): Promise<{ config: AxisConfig; configDir: string }> {
  const resolvedPath = path.resolve(configPath ?? "axis.config.json");

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read config file at ${resolvedPath}: ${formatError(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in ${resolvedPath}`);
  }

  validateConfig(parsed, resolvedPath);

  return {
    config: parsed,
    configDir: path.dirname(resolvedPath),
  };
}

export async function discoverScenarios(
  configDir: string,
  scenariosPath: string,
  filter?: string[],
): Promise<Scenario[]> {
  const rootDir = path.resolve(configDir, scenariosPath);

  let stat;
  try {
    stat = await fs.stat(rootDir);
  } catch (err) {
    throw new Error(`Could not read scenarios directory at ${rootDir}: ${formatError(err)}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Scenarios path is not a directory: ${rootDir}`);
  }

  const scenarios: Scenario[] = [];
  await walkDir(rootDir, rootDir, scenarios);

  // Sort by key for deterministic ordering
  scenarios.sort((a, b) => a.key.localeCompare(b.key));

  // Filter scenarios if agent specifies a subset
  if (filter && !filter.includes("*")) {
    return scenarios.filter((s) => matchesFilter(s.key, filter));
  }

  return scenarios;
}

async function walkDir(dir: string, rootDir: string, scenarios: Scenario[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, scenarios);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const scenario = await loadScenarioFile(fullPath, rootDir);
      scenarios.push(scenario);
    }
  }
}

async function loadScenarioFile(filePath: string, rootDir: string): Promise<Scenario> {
  const raw = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in scenario file ${filePath}`);
  }

  validateScenario(parsed, filePath);

  // Derive key from relative path: scenarios/cms/create-post.json → "cms/create-post"
  const relativePath = path.relative(rootDir, filePath);
  const key = relativePath
    .replace(/\.json$/, "")
    .split(path.sep)
    .join("/");

  parsed.key = key;

  return parsed;
}

function matchesFilter(key: string, filter: string[]): boolean {
  return filter.some((pattern) => {
    // Exact match
    if (pattern === key) return true;

    // Simple glob: "cms/*" matches "cms/create-post" and "cms/delete-post"
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return key.startsWith(prefix + "/");
    }

    // Prefix glob: "cms/**" matches any depth under cms/
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return key.startsWith(prefix + "/");
    }

    return false;
  });
}
