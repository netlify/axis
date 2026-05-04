import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AxisConfig } from "../types/config.js";
import type { Scenario, ScenarioVariant } from "../types/scenario.js";
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
  normalizeConfigAgents(parsed);

  return {
    config: parsed,
    configDir: path.dirname(resolvedPath),
  };
}

/** Lowercase all agent names in a validated config (mutates in place). */
function normalizeConfigAgents(config: AxisConfig): void {
  for (let i = 0; i < config.agents.length; i++) {
    const entry = config.agents[i];
    if (typeof entry === "string") {
      config.agents[i] = entry.toLowerCase();
    } else {
      entry.adapter = entry.adapter.toLowerCase();
    }
  }
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

  // Check for duplicate keys (can happen when variant keys collide with other scenario keys)
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.key)) {
      throw new Error(`Duplicate scenario key "${s.key}". Ensure variant names do not collide with other scenarios.`);
    }
    seen.add(s.key);
  }

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
      const loaded = await loadScenarioFile(fullPath, rootDir);
      scenarios.push(...loaded);
    }
  }
}

async function loadScenarioFile(filePath: string, rootDir: string): Promise<Scenario[]> {
  const raw = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in scenario file ${filePath}`);
  }

  validateScenario(parsed, filePath);
  normalizeScenarioAgents(parsed);

  // Derive key from relative path: scenarios/cms/create-post.json → "cms/create-post"
  const relativePath = path.relative(rootDir, filePath);
  const baseKey = relativePath
    .replace(/\.json$/, "")
    .split(path.sep)
    .join("/");

  const scenario = parsed as Scenario & { variants?: ScenarioVariant[] };

  if (!scenario.variants || scenario.variants.length === 0) {
    scenario.key = baseKey;
    return [scenario];
  }

  // Expand variants: each becomes a standalone Scenario, base does not run
  return scenario.variants.map((variant) => expandVariant(scenario, variant, baseKey));
}

/** Lowercase agent-name entries in a scenario and any variants (mutates in place). */
function normalizeScenarioAgents(scenario: Scenario & { variants?: ScenarioVariant[] }): void {
  if (scenario.agents) {
    scenario.agents = scenario.agents.map((a) => a.toLowerCase());
  }
  if (scenario.variants) {
    for (const v of scenario.variants) {
      if (v.agents) v.agents = v.agents.map((a) => a.toLowerCase());
    }
  }
}

function expandVariant(parent: Scenario, variant: ScenarioVariant, baseKey: string): Scenario {
  const expanded: Scenario = {
    key: `${baseKey}@${variant.name}`,
    name: `${parent.name} [${variant.name}]`,
    prompt: variant.prompt ?? parent.prompt,
    rubric: variant.rubric ?? parent.rubric,
    skip: variant.skip ?? parent.skip,
    setup: variant.setup ?? parent.setup,
    teardown: variant.teardown ?? parent.teardown,
    agents: variant.agents ?? parent.agents,
    skills: variant.skills !== undefined ? variant.skills : parent.skills,
    mcp_servers:
      variant.mcp_servers !== undefined
        ? { ...parent.mcp_servers, ...variant.mcp_servers }
        : parent.mcp_servers,
    limits: variant.limits ?? parent.limits,
  };

  // Strip undefined optional fields to keep objects clean
  if (expanded.skip === undefined) delete expanded.skip;
  if (expanded.setup === undefined) delete expanded.setup;
  if (expanded.teardown === undefined) delete expanded.teardown;
  if (expanded.agents === undefined) delete expanded.agents;
  if (expanded.skills === undefined) delete expanded.skills;
  if (expanded.mcp_servers === undefined) delete expanded.mcp_servers;
  if (expanded.limits === undefined) delete expanded.limits;

  return expanded;
}

function matchesFilter(key: string, filter: string[]): boolean {
  const baseKey = key.includes("@") ? key.split("@")[0] : key;

  return filter.some((pattern) => {
    // Exact match (full key including variant)
    if (pattern === key) return true;

    // Base key match: "cms/create-post" matches all its variants
    if (pattern === baseKey && pattern !== key) return true;

    // Simple glob: "cms/*" matches "cms/create-post" and "cms/create-post@variant"
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return baseKey.startsWith(prefix + "/");
    }

    // Prefix glob: "cms/**" matches any depth under cms/
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return baseKey.startsWith(prefix + "/");
    }

    return false;
  });
}
