import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AxisConfig, InlineScenario, McpServerConfig } from "../types/config.js";
import { silentLogger, formatError } from "../types/output.js";
import type { Logger } from "../types/output.js";
import { loadConfig } from "./loader.js";

/** Matches `https://github.com/o/r`, `https://gitlab.com/o/r`, `git://…`, `ssh://…`. */
const GIT_URL_RE = /^(https?|git|ssh):\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/;

const REMOTES_SUBDIR = path.join(".axis", "remotes");
const DEFAULT_MAX_DEPTH = 1;

const CONFIG_BASENAMES = ["axis.config.ts", "axis.config.js", "axis.config.mjs", "axis.config.json"] as const;

export interface ExpandRemoteScenariosOptions {
  /** Directory the parent config lives in. Resolves the `.axis/remotes/` root. */
  configDir: string;
  /** Logger for clone/pull progress. Defaults to silent. */
  logger?: Logger;
  /**
   * How many levels of remote → remote references to follow. `1` (the
   * default) means the parent may include URL entries, but their configs
   * may not include further URL entries.
   */
  maxDepth?: number;
  /** URLs already followed on this expansion chain. Used for cycle detection. */
  visited?: Set<string>;
  /** Current recursion depth (internal). */
  depth?: number;
}

/** True if `entry` looks like a remote git URL. */
export function isRemoteScenarioUrl(entry: string): boolean {
  return GIT_URL_RE.test(entry);
}

interface ParsedRemoteUrl {
  url: string;
  host: string;
  owner: string;
  repo: string;
}

/** Parse a remote scenarios URL into its components. */
export function parseRemoteUrl(entry: string): ParsedRemoteUrl {
  const match = entry.match(GIT_URL_RE);
  if (!match) {
    throw new Error(`Invalid remote scenarios URL "${entry}"`);
  }
  const [, , host, rest] = match;
  const segments = rest.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid remote scenarios URL "${entry}": expected <host>/<owner>/<repo>`);
  }
  const repo = segments[segments.length - 1].replace(/\.git$/, "");
  const owner = segments.slice(0, -1).join("/");
  return { url: entry, host, owner, repo };
}

/** `.axis/remotes/<reversedHost>/<owner>/<repo>` relative to `configDir`. */
export function remoteCloneDir(configDir: string, parsed: ParsedRemoteUrl): string {
  const reversedHost = parsed.host.split(".").reverse().join(".");
  return path.join(configDir, REMOTES_SUBDIR, reversedHost, parsed.owner, parsed.repo);
}

/**
 * Injection point for tests so they don't have to shell out to real git.
 * Default implementation clones or pulls via `git`.
 */
export type CloneImpl = (url: string, targetDir: string, logger: Logger) => void;

let cloneImpl: CloneImpl = defaultEnsureClone;

/** Override the clone implementation. Returns a function that restores the default. */
export function setCloneImplForTests(impl: CloneImpl): () => void {
  cloneImpl = impl;
  return () => {
    cloneImpl = defaultEnsureClone;
  };
}

/**
 * Detect the package manager for a cloned repo from its lockfile, then run
 * `<pm> install` if `node_modules/` is missing. Remote repos that author
 * scenarios as `.ts` files often import workspace helpers or external deps.
 * Without their dependencies installed, those modules fail to load and the
 * walker silently skips them.
 *
 * Best-effort: failures are logged but do not abort the run. Re-running with
 * `.axis/remotes/<clone>/node_modules` already present skips this step.
 */
function ensureRemoteDeps(targetDir: string, logger: Logger): void {
  const pkgJsonPath = path.join(targetDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return;
  if (fs.existsSync(path.join(targetDir, "node_modules"))) return;

  const { manager, args } = detectPackageManager(targetDir);
  logger.info(`Installing remote scenario dependencies (${manager} install)`);
  try {
    execFileSync(manager, args, {
      cwd: targetDir,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5 * 60_000,
    });
  } catch (err) {
    logger.error(
      `Dependency install failed in ${targetDir}: ${formatError(err)}. ` +
        `Remote scenarios that import missing modules will be skipped.`,
    );
  }
}

function detectPackageManager(dir: string): { manager: string; args: string[] } {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
    return { manager: "pnpm", args: ["install", "--prefer-offline"] };
  }
  if (fs.existsSync(path.join(dir, "yarn.lock"))) {
    return { manager: "yarn", args: ["install", "--prefer-offline"] };
  }
  return { manager: "npm", args: ["install", "--prefer-offline", "--no-audit", "--no-fund"] };
}

/**
 * A clone is considered valid when `.git/HEAD` exists. That is git's marker
 * for "this directory has a real repository state." A bare `.git/` directory
 * (e.g., left over from an interrupted clone or a unit-test stub) tricks
 * `git pull` into exiting 0 with no actual repo content, so we explicitly
 * gate on `HEAD` and re-clone if it's missing.
 */
function isValidClone(targetDir: string): boolean {
  return fs.existsSync(path.join(targetDir, ".git", "HEAD"));
}

function defaultEnsureClone(url: string, targetDir: string, logger: Logger): void {
  if (isValidClone(targetDir)) {
    logger.info(`Pulling remote scenarios: ${url}`);
    try {
      execFileSync("git", ["-C", targetDir, "pull", "--ff-only", "--quiet"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
    } catch (err) {
      throw new Error(`Failed to pull remote scenarios from ${url}: ${formatError(err)}`);
    }
    ensureRemoteDeps(targetDir, logger);
    return;
  }
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  logger.info(`Cloning remote scenarios: ${url}`);
  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", url, targetDir], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
  } catch (err) {
    throw new Error(`Failed to clone remote scenarios from ${url}: ${formatError(err)}`);
  }
  ensureRemoteDeps(targetDir, logger);
}

/**
 * Aggregated additions a remote repo contributes to the parent config.
 * `scenarios` is the input scenarios list with URL entries replaced by their
 * resolved absolute paths (non-URL parent entries pass through unchanged).
 * The other fields are values pulled from remote `axis.config.*` files,
 * with skills and adapter paths re-resolved to be absolute under their
 * clone directory so the parent runner can use them as-is.
 */
export interface RemoteContribution {
  scenarios: (string | InlineScenario)[];
  env: string[];
  mcpServers: Record<string, McpServerConfig>;
  skills: string[];
  artifacts: string[];
  adapters: Record<string, string>;
}

function emptyContribution(): RemoteContribution {
  return { scenarios: [], env: [], mcpServers: {}, skills: [], artifacts: [], adapters: {} };
}

/**
 * Walk a scenarios input. For every URL entry, clone the remote repo, load
 * its `axis.config.*`, and roll up the fields it contributes into a single
 * {@link RemoteContribution}. Non-URL strings and inline scenarios pass
 * through into `contribution.scenarios` unchanged.
 *
 * Recursion follows nested remote references up to `maxDepth`; cycles throw via the
 * `visited` set.
 */
export async function collectRemoteContributions(
  input: string | (string | InlineScenario)[] | undefined,
  options: ExpandRemoteScenariosOptions,
): Promise<RemoteContribution> {
  const result = emptyContribution();
  if (input === undefined) return result;

  const logger = options.logger ?? silentLogger;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const depth = options.depth ?? 0;
  const visited = options.visited ?? new Set<string>();

  const asArray = Array.isArray(input) ? input : [input];

  for (const entry of asArray) {
    if (typeof entry !== "string" || !isRemoteScenarioUrl(entry)) {
      // Non-URL parent entry. Pass through to scenarios; other contribution
      // fields stay empty for this iteration.
      result.scenarios.push(entry);
      continue;
    }

    const parsed = parseRemoteUrl(entry);

    if (visited.has(parsed.url)) {
      throw new Error(`Cyclic remote scenario reference detected: ${parsed.url}`);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(parsed.url);

    const cloneDir = remoteCloneDir(options.configDir, parsed);
    cloneImpl(parsed.url, cloneDir, logger);

    // Load the remote repo's config. Falls back to "scenarios is just the
    // clone root" when no axis.config.* exists.
    const { remoteScenarios, remoteConfig } = await loadRemoteRepo(parsed.url, cloneDir);

    // Start this remote's contribution from its own config fields. Recursion
    // (below) merges in anything its own nested remote children contributed.
    const remoteContribution: RemoteContribution = {
      scenarios: [],
      env: remoteConfig?.env ? [...remoteConfig.env] : [],
      mcpServers: remoteConfig?.mcp_servers ? { ...remoteConfig.mcp_servers } : {},
      skills: resolveSkillPathsForClone(remoteConfig?.skills ?? [], cloneDir),
      artifacts: remoteConfig?.artifacts ? [...remoteConfig.artifacts] : [],
      adapters: resolveAdapterPathsForClone(remoteConfig?.adapters ?? {}, cloneDir),
    };

    if (depth + 1 < maxDepth) {
      // Recurse: nested URLs in the remote's scenarios contribute too.
      const nested = await collectRemoteContributions(remoteScenarios, {
        configDir: cloneDir,
        logger,
        maxDepth,
        visited: nextVisited,
        depth: depth + 1,
      });
      // Nested contribution rolls into THIS remote's contribution: its
      // scenarios become absolute paths under the clone dir below, and its
      // env/mcp/skills/artifacts/adapters bubble up.
      for (const s of nested.scenarios) {
        remoteContribution.scenarios.push(typeof s === "string" ? path.resolve(cloneDir, s) : s);
      }
      mergeIntoContribution(remoteContribution, {
        ...nested,
        scenarios: [], // already handled above
      });
    } else {
      // No recursion allowed: ensure the remote doesn't carry further URLs.
      const nestedUrl = findFirstUrlEntry(remoteScenarios);
      if (nestedUrl) {
        throw new Error(
          `Remote scenario depth limit reached (maxDepth=${maxDepth}): ` +
            `${parsed.url} references another remote URL "${nestedUrl}". ` +
            `Increase settings.remotes.maxDepth to allow nested remote references.`,
        );
      }
      for (const e of toScenarioArray(remoteScenarios)) {
        remoteContribution.scenarios.push(typeof e === "string" ? path.resolve(cloneDir, e) : e);
      }
    }

    // Roll this remote's contribution into the accumulator. Sibling URL
    // entries listed later in the parent override earlier ones on key
    // collisions (deterministic by config order).
    mergeIntoContribution(result, remoteContribution);
  }

  return result;
}

/**
 * Replace any remote-URL entries in a `scenarios` list with absolute local
 * paths produced by cloning the remote repo and reading its own config.
 *
 * Non-URL strings and inline scenario objects pass through untouched. The
 * returned shape matches the input shape: if `input` was a single string and
 * not a URL, it is returned as-is. Used by `discoverScenarios` for callers
 * outside the runner pipeline; the runner uses {@link mergeRemoteConfig}
 * to also fold in env/mcp_servers/skills/artifacts/adapters.
 */
export async function expandRemoteScenarios(
  input: string | (string | InlineScenario)[] | undefined,
  options: ExpandRemoteScenariosOptions,
): Promise<string | (string | InlineScenario)[] | undefined> {
  if (input === undefined) return input;
  const asArray = Array.isArray(input) ? input : [input];
  const hasUrl = asArray.some((entry) => typeof entry === "string" && isRemoteScenarioUrl(entry));
  if (!hasUrl) return input;
  const contribution = await collectRemoteContributions(input, options);
  return contribution.scenarios;
}

/**
 * Resolve remote scenarios AND merge each remote repo's supporting config
 * (env, mcp_servers, skills, artifacts, adapters) into the parent. The parent
 * wins on key collisions for mcp_servers and adapters; env/skills/artifacts
 * become an ordered union with the parent's entries first.
 *
 * Mutates and returns the same `config` object (consistent with how the
 * runner threads the config through later stages).
 */
export async function mergeRemoteConfig(
  config: AxisConfig,
  configDir: string,
  options: Omit<ExpandRemoteScenariosOptions, "configDir"> = {},
): Promise<AxisConfig> {
  if (config.scenarios === undefined) return config;
  const asArray = Array.isArray(config.scenarios) ? config.scenarios : [config.scenarios];
  if (!asArray.some((e) => typeof e === "string" && isRemoteScenarioUrl(e))) return config;

  const contribution = await collectRemoteContributions(config.scenarios, { ...options, configDir });

  config.scenarios = contribution.scenarios;
  if (contribution.env.length > 0) {
    config.env = uniqueOrdered([...(config.env ?? []), ...contribution.env]);
  }
  if (Object.keys(contribution.mcpServers).length > 0) {
    config.mcp_servers = { ...contribution.mcpServers, ...(config.mcp_servers ?? {}) };
  }
  if (contribution.skills.length > 0) {
    config.skills = uniqueOrdered([...(config.skills ?? []), ...contribution.skills]);
  }
  if (contribution.artifacts.length > 0) {
    config.artifacts = uniqueOrdered([...(config.artifacts ?? []), ...contribution.artifacts]);
  }
  if (Object.keys(contribution.adapters).length > 0) {
    config.adapters = { ...contribution.adapters, ...(config.adapters ?? {}) };
  }
  return config;
}

/**
 * Load a remote clone's `axis.config.*`. Returns the config and its
 * `scenarios` field for downstream expansion. If no config file exists at
 * the clone root, scenarios fall back to "treat the clone root as a scenarios
 * directory" (matching Phase 1 behaviour), and the config is null so no
 * supporting fields are contributed.
 */
async function loadRemoteRepo(
  url: string,
  cloneDir: string,
): Promise<{ remoteScenarios: string | (string | InlineScenario)[] | undefined; remoteConfig: AxisConfig | null }> {
  const configPath = findRemoteConfigPath(cloneDir);
  if (configPath === null) {
    return { remoteScenarios: [cloneDir], remoteConfig: null };
  }
  let loaded: { config: AxisConfig; configDir: string };
  try {
    loaded = await loadConfig(configPath);
  } catch (err) {
    throw new Error(`Failed to load remote config from ${url} (${configPath}): ${formatError(err)}`);
  }
  return { remoteScenarios: loaded.config.scenarios, remoteConfig: loaded.config };
}

function findRemoteConfigPath(cloneDir: string): string | null {
  for (const basename of CONFIG_BASENAMES) {
    const candidate = path.join(cloneDir, basename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findFirstUrlEntry(entries: string | (string | InlineScenario)[] | undefined): string | null {
  if (entries === undefined) return null;
  for (const entry of toScenarioArray(entries)) {
    if (typeof entry === "string" && isRemoteScenarioUrl(entry)) return entry;
  }
  return null;
}

function toScenarioArray(entries: string | (string | InlineScenario)[] | undefined): (string | InlineScenario)[] {
  if (entries === undefined) return [];
  return Array.isArray(entries) ? entries : [entries];
}

/**
 * Resolve a `skills` list as it appears in a remote repo's config so that
 * local-path entries become absolute under the clone directory. URL entries
 * (`https://…`) and `owner/repo` shorthand pass through unchanged: the
 * skills resolver handles them directly and doesn't need a cwd. Detection
 * mirrors src/skills/resolver.ts.
 */
function resolveSkillPathsForClone(skills: string[], cloneDir: string): string[] {
  return skills.map((s) => {
    if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
      return path.resolve(cloneDir, s);
    }
    return s;
  });
}

/**
 * Re-resolve adapter module paths so the runner's `path.resolve(configDir, …)`
 * pass becomes a no-op for remote adapters. Adapter values are always
 * module paths (never URLs), so every entry is absolutised.
 */
function resolveAdapterPathsForClone(adapters: Record<string, string>, cloneDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, modulePath] of Object.entries(adapters)) {
    out[name] = path.resolve(cloneDir, modulePath);
  }
  return out;
}

function uniqueOrdered<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Fold `src`'s contribution into `dest`, applying the same merge policy used
 * when applying a contribution to the parent: later entries win for keyed
 * maps (mcp_servers, adapters); ordered union with first-seen-wins for the
 * arrays (env, skills, artifacts).
 */
function mergeIntoContribution(dest: RemoteContribution, src: RemoteContribution): void {
  for (const s of src.scenarios) dest.scenarios.push(s);
  if (src.env.length > 0) dest.env = uniqueOrdered([...dest.env, ...src.env]);
  if (Object.keys(src.mcpServers).length > 0) dest.mcpServers = { ...dest.mcpServers, ...src.mcpServers };
  if (src.skills.length > 0) dest.skills = uniqueOrdered([...dest.skills, ...src.skills]);
  if (src.artifacts.length > 0) dest.artifacts = uniqueOrdered([...dest.artifacts, ...src.artifacts]);
  if (Object.keys(src.adapters).length > 0) dest.adapters = { ...dest.adapters, ...src.adapters };
}
