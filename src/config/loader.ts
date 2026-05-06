import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { AxisConfig } from "../types/config.js";
import type { Scenario, ScenarioInput, ScenarioVariant } from "../types/scenario.js";
import { validateConfig, validateScenario } from "./validator.js";
import { formatError } from "../types/output.js";

/** Extensions probed when no explicit config path is given, in priority order. */
const DEFAULT_CONFIG_EXTENSIONS = [".ts", ".js", ".mjs", ".json"] as const;
const DEFAULT_CONFIG_BASENAME = "axis.config";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export async function loadConfig(configPath?: string): Promise<{ config: AxisConfig; configDir: string }> {
  const resolvedPath = await resolveConfigPath(configPath);
  const ext = path.extname(resolvedPath).toLowerCase();

  let parsed: unknown;
  if (ext === ".json" || ext === "") {
    parsed = await loadJsonConfig(resolvedPath);
  } else if (JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext)) {
    parsed = await loadModuleConfig(resolvedPath);
  } else {
    throw new Error(`Unsupported config file extension "${ext}" at ${resolvedPath}`);
  }

  // Support a default export that is either the config object or a (sync/async) function returning it.
  if (typeof parsed === "function") {
    parsed = await (parsed as () => unknown | Promise<unknown>)();
  }

  validateConfig(parsed, resolvedPath);
  normalizeConfigAgents(parsed);

  // Default the scenarios source when omitted; downstream code can assume it is set.
  if (parsed.scenarios === undefined) {
    parsed.scenarios = "./scenarios";
  }

  return {
    config: parsed,
    configDir: path.dirname(resolvedPath),
  };
}

async function resolveConfigPath(configPath: string | undefined): Promise<string> {
  if (configPath) {
    return path.resolve(configPath);
  }

  for (const ext of DEFAULT_CONFIG_EXTENSIONS) {
    const candidate = path.resolve(`${DEFAULT_CONFIG_BASENAME}${ext}`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  // Nothing found — fall back to .json so the existing "Could not read" error fires with the expected path.
  return path.resolve(`${DEFAULT_CONFIG_BASENAME}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function loadJsonConfig(resolvedPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read config file at ${resolvedPath}: ${formatError(err)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in ${resolvedPath}`);
  }
}

async function loadModuleConfig(resolvedPath: string): Promise<unknown> {
  if (!(await fileExists(resolvedPath))) {
    throw new Error(`Could not read config file at ${resolvedPath}: file not found`);
  }

  let mod: { default?: unknown };
  try {
    mod = await importModule(resolvedPath);
  } catch (err) {
    throw new Error(`Failed to load config at ${resolvedPath}: ${formatError(err)}`);
  }

  if (!mod || typeof mod !== "object" || !("default" in mod) || mod.default === undefined) {
    throw new Error(`Config at ${resolvedPath} must have a default export`);
  }
  return mod.default;
}

/**
 * Imports a JS or TS file by extension. Native dynamic import for `.js`/`.mjs`/`.cjs`,
 * jiti for `.ts`/`.mts`/`.cts`. Returns the module namespace; callers extract `default`.
 */
async function importModule(filePath: string): Promise<{ default?: unknown }> {
  const ext = path.extname(filePath).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) {
    return (await import(pathToFileURL(filePath).href)) as { default?: unknown };
  }
  if (TS_EXTENSIONS.has(ext)) {
    const jiti = createJiti(import.meta.url, { interopDefault: false });
    return (await jiti.import(filePath)) as { default?: unknown };
  }
  throw new Error(`Unsupported module extension "${ext}" at ${filePath}`);
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
  scenariosInput: string | (string | ScenarioInput)[] | undefined,
  filter?: string[],
): Promise<Scenario[]> {
  // When omitted, fall back to the default scenarios directory.
  const resolvedInput = scenariosInput ?? "./scenarios";
  const entries = Array.isArray(resolvedInput) ? resolvedInput : [resolvedInput];
  const scenarios: Scenario[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") {
      await collectFromPath(path.resolve(configDir, entry), scenarios);
    } else {
      // Inline scenarios are validated by validateConfig; here we just normalize and expand.
      scenarios.push(...expandInline(entry));
    }
  }

  // Check for duplicate keys (can happen when variant keys collide with other scenario keys
  // or when inline keys collide with on-disk keys)
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

/** File extensions recognized by the scenarios walker. */
const SCENARIO_EXTENSIONS = new Set([".json", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const SCENARIO_EXT_RE = /\.(json|js|mjs|cjs|ts|mts|cts)$/;

async function collectFromPath(absolutePath: string, scenarios: Scenario[]): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    throw new Error(`Could not read scenarios path at ${absolutePath}: ${formatError(err)}`);
  }

  if (stat.isDirectory()) {
    await walkDir(absolutePath, absolutePath, scenarios);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Scenarios path must be a directory or scenario file: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SCENARIO_EXTENSIONS.has(ext)) {
    throw new Error(
      `Scenario file must end in one of ${[...SCENARIO_EXTENSIONS].join(", ")}: ${absolutePath}`,
    );
  }
  // Single-file entry is explicit, so missing default exports are an error (not silent skip).
  const baseKey = path.basename(absolutePath, ext);
  const loaded = await loadScenarioFromPath(absolutePath, baseKey, false);
  if (loaded) scenarios.push(...loaded);
}

async function walkDir(dir: string, rootDir: string, scenarios: Scenario[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, scenarios);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!SCENARIO_EXTENSIONS.has(ext)) continue;

    // Derive key from path relative to the walk root: scenarios/cms/create-post.ts → "cms/create-post"
    const baseKey = path
      .relative(rootDir, fullPath)
      .replace(SCENARIO_EXT_RE, "")
      .split(path.sep)
      .join("/");
    // Walking a directory: silently skip module files that don't default-export a scenario object,
    // so user-authored helpers/utilities can live alongside scenarios without special handling.
    const loaded = await loadScenarioFromPath(fullPath, baseKey, true);
    if (loaded) scenarios.push(...loaded);
  }
}

/**
 * Loads a single scenario from disk, dispatching by extension.
 *
 * @param silentSkip  When true, JS/TS modules without a default object export return null
 *                    instead of throwing. Used when walking a directory so non-scenario
 *                    helper modules can coexist with scenario files.
 */
async function loadScenarioFromPath(
  filePath: string,
  baseKey: string,
  silentSkip: boolean,
): Promise<Scenario[] | null> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    return loadJsonScenario(filePath, baseKey);
  }

  if (JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext)) {
    return loadModuleScenario(filePath, baseKey, silentSkip);
  }

  if (silentSkip) return null;
  throw new Error(`Unsupported scenario file extension "${ext}" at ${filePath}`);
}

async function loadJsonScenario(filePath: string, baseKey: string): Promise<Scenario[]> {
  const raw = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in scenario file ${filePath}`);
  }

  return finalizeScenarioObject(parsed, filePath, baseKey);
}

async function loadModuleScenario(
  filePath: string,
  baseKey: string,
  silentSkip: boolean,
): Promise<Scenario[] | null> {
  let mod: { default?: unknown };
  try {
    mod = await importModule(filePath);
  } catch (err) {
    throw new Error(`Failed to load scenario module at ${filePath}: ${formatError(err)}`);
  }

  let def: unknown = mod && typeof mod === "object" ? mod.default : undefined;
  if (typeof def === "function") {
    def = await (def as () => unknown | Promise<unknown>)();
  }

  if (def === undefined || def === null || typeof def !== "object" || Array.isArray(def)) {
    if (silentSkip) return null;
    throw new Error(
      `Scenario module at ${filePath} must default-export an object (or function returning one)`,
    );
  }

  return finalizeScenarioObject(def, filePath, baseKey);
}

function finalizeScenarioObject(parsed: unknown, filePath: string, baseKey: string): Scenario[] {
  validateScenario(parsed, filePath, "file");
  normalizeScenarioAgents(parsed);

  const scenario = parsed as Scenario & { variants?: ScenarioVariant[] };

  // If the file declares a key, it must match the key derived from its path.
  // The path-derived key is always authoritative; this surfaces drift after a rename.
  if (scenario.key !== undefined && scenario.key !== baseKey) {
    throw new Error(
      `Scenario at ${filePath}: declared key "${scenario.key}" does not match path-derived key "${baseKey}". ` +
        `Either remove the "key" field or set it to "${baseKey}".`,
    );
  }

  if (!scenario.variants || scenario.variants.length === 0) {
    scenario.key = baseKey;
    return [scenario];
  }

  // Expand variants: each becomes a standalone Scenario, base does not run
  return scenario.variants.map((variant) => expandVariant(scenario, variant, baseKey));
}

function expandInline(input: ScenarioInput): Scenario[] {
  // Shallow clone so we don't mutate the caller's config object.
  const scenario = { ...input } as Scenario & { variants?: ScenarioVariant[] };
  normalizeScenarioAgents(scenario);

  if (!scenario.variants || scenario.variants.length === 0) {
    return [scenario];
  }

  return scenario.variants.map((variant) => expandVariant(scenario, variant, scenario.key));
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
