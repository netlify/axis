import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  discoverScenarios,
  matchesScenarioFilter,
  matchesAgentFilter,
  applySuiteSelector,
} from "../config/loader.js";
import { mergeRemoteConfig } from "../config/remote-scenarios.js";
import { getAdapter, registerAdapter } from "../adapters/registry.js";
import { runLifecyclePhase } from "./lifecycle.js";
import { collectGitCopySources, defaultRepoCacheRoot, ensureRepo } from "./repo-cache.js";
import type { GitCopySource } from "./repo-cache.js";
import { captureArtifacts, resolveArtifactPatterns } from "./artifacts.js";
import { artifactsPath, runSiblingPath } from "../reports/paths.js";
import { assertValidRunCount, MAX_RUNS } from "../config/validator.js";
import { groupRunsByPair } from "../scoring/aggregate.js";
import type {
  ResolvedRunConfig,
  RunOutput,
  RunResult,
  Logger,
  JobState,
  JobStatus,
  ScenarioLoadFailure,
} from "../types/output.js";
import { silentLogger as defaultLogger, formatError, isFailedRun } from "../types/output.js";
import type { Scenario } from "../types/scenario.js";
import type { AgentConfig, AxisConfig, ResolvedSkill, ScenarioLimitsConfig } from "../types/config.js";
import { resolveSkills } from "../skills/resolver.js";
import { buildAgentBaseName } from "./agent-name.js";

// ---------------------------------------------------------------------------
// Limit resolution
// ---------------------------------------------------------------------------

/** Default per-scenario time limit when none is configured (15 minutes). */
const DEFAULT_SCENARIO_TIME_MINUTES = 15;

/** Default max parallel jobs when none is configured. */
const DEFAULT_CONCURRENCY = 15;

interface ResolvedJobLimits {
  timeoutMs?: number;
  tokenLimit?: number;
}

function resolveJobLimits(scenario: Scenario, defaultLimits?: ScenarioLimitsConfig): ResolvedJobLimits {
  const effective = scenario.limits ?? defaultLimits;
  const timeMinutes = effective?.time_minutes ?? DEFAULT_SCENARIO_TIME_MINUTES;
  return {
    timeoutMs: timeMinutes * 60 * 1000,
    tokenLimit: effective?.tokens,
  };
}

/** Default repeat count when none is configured. */
const DEFAULT_RUN_COUNT = 1;

/**
 * How many times one scenario runs against one agent.
 *
 * Precedence mirrors `concurrency`: an explicit CLI value beats the scenario,
 * which beats the suite default.
 *
 * Every source is validated before this runs: config values by
 * `validateConfig` / `validateScenario`, and a `--runs` or `run({ runs })`
 * override by `assertValidRunCount` at the top of `run()`. All of them are
 * therefore positive, odd, and within `MAX_RUNS`, and the clamp here is only
 * a floor against a non-finite value slipping through.
 *
 * Nothing is silently adjusted on the way in. Rounding an even count to an odd
 * one would change both the sample size and the bill without saying so, and
 * clamping a `0` would guess at an intent the caller never expressed, so both
 * are rejected upstream instead.
 */
function resolveRunCount(scenario: Scenario, axisConfig: AxisConfig, override?: number): number {
  const raw = override ?? scenario.runs ?? axisConfig.settings?.runs ?? DEFAULT_RUN_COUNT;
  if (!Number.isFinite(raw)) return DEFAULT_RUN_COUNT;
  return Math.max(1, Math.min(MAX_RUNS, Math.floor(raw)));
}

function formatLimitMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

/** Build the materialized configuration that was actually applied to a run, with defaults filled in. */
function buildResolvedRunConfig(
  scenario: Scenario,
  axisConfig: AxisConfig,
  agentConfig: AgentConfig,
): ResolvedRunConfig {
  // Limits: scenario-level overrides default; default time_minutes always applied.
  const limitsBase = scenario.limits ?? axisConfig.settings?.limits?.scenario;
  const limits: ScenarioLimitsConfig = {
    time_minutes: limitsBase?.time_minutes ?? DEFAULT_SCENARIO_TIME_MINUTES,
    ...(limitsBase?.tokens !== undefined ? { tokens: limitsBase.tokens } : {}),
  };

  // Skills merge axis → agent → scenario, dedup preserving order.
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const s of [...(axisConfig.skills ?? []), ...(agentConfig.skills ?? []), ...(scenario.skills ?? [])]) {
    if (!seen.has(s)) {
      seen.add(s);
      skills.push(s);
    }
  }

  // MCP: merge top-level + scenario; scenario keys override.
  const mcpServers = { ...(axisConfig.mcp_servers ?? {}), ...(scenario.mcp_servers ?? {}) };

  const artifactPatterns = resolveArtifactPatterns(axisConfig, scenario);

  return {
    limits,
    skills: skills.length > 0 ? skills : undefined,
    setup: scenario.setup && scenario.setup.length > 0 ? scenario.setup : undefined,
    teardown: scenario.teardown && scenario.teardown.length > 0 ? scenario.teardown : undefined,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    artifacts: artifactPatterns.length > 0 ? artifactPatterns : undefined,
  };
}

export type { RunOutput, RunResult };

export interface RunOptions {
  configPath?: string;
  /**
   * Name of a `profiles` entry in the config to merge over the base before
   * the run. Unknown names throw.
   */
  profile?: string;
  scenarioFilter?: string[];
  agentFilter?: string[];
  logger?: Logger;
  /**
   * Maximum number of jobs to run in parallel.
   * Defaults to 15.
   */
  concurrency?: number;
  /**
   * Called when an individual job completes (before all jobs finish).
   * If a Promise is returned, the runner awaits it before running
   * teardown — this allows scoring to verify results before cleanup.
   */
  onResult?: (result: RunResult) => void | Promise<void>;
  /**
   * Register a cleanup function that will be called on process signals
   * (SIGINT/SIGTERM). The runner uses this to register workspace cleanup
   * and child process termination so Ctrl-C doesn't leave orphans.
   */
  registerCleanup?: (fn: () => void) => void;
  /**
   * When true, adapters capture raw stdout lines in the output.
   * Used by --debug mode to write .raw.ndjson files alongside reports.
   */
  debug?: boolean;
  /** Force re-clone of remote skills from cache. */
  refreshSkills?: boolean;
  /** Force re-clone of repositories staged by `copy` actions pointed at a git URL. */
  refreshRepos?: boolean;
  /**
   * Report directory root. When provided and the scenario configures `artifacts`
   * patterns, captured files are copied to
   * `{reportDir}/scenarios/{scenarioKey}/{agentName}/artifacts/...` after teardown.
   */
  reportDir?: string;
  /**
   * How many times to run each scenario/agent pair, overriding
   * `settings.runs` and any per-scenario `runs`. Repeats reduce the volatility
   * of a result by sampling the agent several times; the report headlines one
   * representative run and records the spread across the rest.
   */
  runs?: number;
  /**
   * Explicit allowlist of scenario/agent pairs. When set, only jobs whose
   * (scenarioKey, agentName) appears in this list survive discovery — applied
   * AFTER `scenarioFilter` and `agentFilter`. Pairs not currently configured
   * (scenario removed, agent removed) are silently dropped.
   *
   * Filtering is per pair, never per run. A repeated pair's score is a property
   * of its whole sample, so re-running a subset of a pair's runs would produce
   * a report whose entry for that pair is built from an incomplete (and
   * possibly even-sized) sample, which is the case odd run counts exist to
   * rule out. Retrying the pair costs the runs that already passed and buys a
   * result that can actually be read.
   */
  jobFilter?: Array<{ scenarioKey: string; agentName: string }>;
  /**
   * External cancel signal (e.g. Ctrl-C). When aborted, in-flight jobs receive
   * SIGTERM and pending jobs are marked as failed so the report still finalizes.
   */
  signal?: AbortSignal;
}

interface Job {
  index: number;
  agentName: string;
  agentConfig: AgentConfig;
  scenario: Scenario;
  configDir: string;
  axisConfig: AxisConfig;
  /** 1-based run index within this scenario/agent pair. */
  runIndex: number;
  /** Total runs configured for this pair. */
  runCount: number;
}

/** System vars always passed through to isolated environments. */
const SYSTEM_VARS = ["PATH", "USER", "SHELL", "LANG", "TERM", "TMPDIR"];

/**
 * Default agent API keys always passed through, merged with any user-supplied
 * `config.env`. Without this, declaring `env: [...]` for lifecycle scripts
 * would silently strip the keys adapters need to authenticate.
 */
const DEFAULT_PASS_ENV = ["ANTHROPIC_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY"];

export async function run(options: RunOptions = {}): Promise<RunOutput> {
  const logger = options.logger ?? defaultLogger;
  const runStart = Date.now();

  // Check the caller's override before loading anything, so a bad `--runs`
  // fails immediately rather than after discovery and pre-flight.
  if (options.runs !== undefined) {
    assertValidRunCount(options.runs, "runs");
  }
  const { config, configDir, baseConfig } = await loadConfig(options.configPath, { profile: options.profile });

  // Remote scenarios: clone any remote URL entries once up front so the
  // per-agent discoverScenarios() calls below don't re-pull each time. Also
  // folds each remote repo's env/mcp_servers/skills/artifacts/adapters into
  // this config (parent wins on collisions) so remote scenarios bring their
  // supporting config with them. Runs BEFORE adapter loading so remote
  // adapters get registered too.
  await mergeRemoteConfig(config, configDir, {
    logger,
    maxDepth: config.settings?.remotes?.maxDepth,
  });

  // --- Load custom adapters from config ---
  if (config.adapters) {
    for (const [name, modulePath] of Object.entries(config.adapters)) {
      const absPath = path.resolve(configDir, modulePath);
      const mod = await import(absPath);
      const adapter = mod.default ?? mod.adapter;
      if (!adapter || typeof adapter.run !== "function") {
        throw new Error(
          `Custom adapter "${name}" at ${modulePath} must export a valid AgentAdapter ` +
            `(as default export or named "adapter" export).`,
        );
      }
      registerAdapter(name, adapter);
    }
  }

  // --- Discovery phase ---
  const jobs: Job[] = [];
  const agents = normalizeAgents(config.agents);
  const skippedKeys = new Set<string>();
  // Keyed by path so a file that fails to load is reported once, not once per
  // agent (discovery runs per agent to honour per-agent scenario filters).
  const loadFailures = new Map<string, ScenarioLoadFailure>();

  await assertEveryScenarioIsReachable(baseConfig, configDir, logger, loadFailures);

  for (const { name: agentName, config: agentConfig } of agents) {
    if (options.agentFilter?.length && !matchesAgentFilter(agentName, options.agentFilter)) {
      continue;
    }

    const allScenarios = await discoverScenarios(configDir, config.scenarios, agentConfig.scenarios, {
      logger,
      maxRemotesDepth: config.settings?.remotes?.maxDepth,
      onLoadFailure: (failure) => loadFailures.set(failure.path, failure),
      include: config.include,
      exclude: config.exclude,
    });

    // Partition into active and skipped
    const scenarios: Scenario[] = [];
    for (const s of allScenarios) {
      if (s.skip) {
        skippedKeys.add(s.key);
      } else {
        scenarios.push(s);
      }
    }

    const filteredScenarios = options.scenarioFilter?.length
      ? scenarios.filter((s) => matchesScenarioFilter(s.key, options.scenarioFilter!))
      : scenarios;

    for (const scenario of filteredScenarios) {
      // Scenario-level agent override: if set, only listed agents run this scenario.
      // Match either the full generated name or the base agent (so users can list
      // `claude-code` to target every claude-code|<model> instance).
      if (scenario.agents && !scenarioAgentFilterMatches(scenario.agents, agentName, agentConfig.agent)) {
        continue;
      }
      // One job per repeat. Pushed together so the run-major sort below can
      // keep pairs in discovery order while spreading their repeats apart.
      const runCount = resolveRunCount(scenario, config, options.runs);
      for (let runIndex = 1; runIndex <= runCount; runIndex++) {
        jobs.push({
          index: 0,
          agentName,
          agentConfig,
          scenario,
          configDir,
          axisConfig: config,
          runIndex,
          runCount,
        });
      }
    }
  }

  orderRunMajor(jobs);

  // Apply explicit job allowlist (e.g. --retry). Jobs not in the list are
  // dropped silently — handles the case where a previously-failed scenario
  // or agent has since been removed from the config.
  if (options.jobFilter?.length) {
    const allow = new Set(options.jobFilter.map((p) => `${p.scenarioKey}\x00${p.agentName}`));
    const before = jobs.length;
    // Every run of an allowed pair survives, so a retried pair produces a
    // complete sample rather than a partial one.
    const filtered = jobs.filter((j) => allow.has(`${j.scenario.key}\x00${j.agentName}`));
    // Reindex so JobState[].index aligns with array position
    filtered.forEach((j, i) => (j.index = i));
    jobs.length = 0;
    jobs.push(...filtered);
    if (jobs.length < before) {
      logger.verbose?.(`jobFilter: kept ${jobs.length} of ${before} discovered jobs`);
    }
  }

  const skippedCount = skippedKeys.size;
  const failedToLoad = [...loadFailures.values()];

  logDiscoverySummary(logger, jobs, skippedKeys, failedToLoad);
  logRepeatBudgetNote(logger, jobs, config);

  if (jobs.length === 0) {
    return buildOutput(runStart, [], skippedCount, failedToLoad);
  }

  // --- Initialize job state tracker ---
  const jobStates: JobState[] = jobs.map((job) => ({
    scenarioKey: job.scenario.key,
    agentName: job.agentName,
    ...(job.runCount > 1 ? { runIndex: job.runIndex, runCount: job.runCount } : {}),
    status: "pending" as JobStatus,
  }));
  const jobMeta = skippedCount > 0 ? { skipped: skippedCount } : undefined;

  const updateStatus = (index: number, status: JobStatus, durationMs?: number) => {
    const patch: Partial<JobState> = { status, durationMs };
    // Stamp the start time on the first transition into "starting"/"running"
    // so the live UI can tick an elapsed-duration counter that includes the
    // adapter's own startup (CLI cold start, ACP handshake, etc.).
    if ((status === "starting" || status === "running") && jobStates[index].runStartedAt === undefined) {
      patch.runStartedAt = Date.now();
    }
    jobStates[index] = { ...jobStates[index], ...patch };
    logger.onJobUpdate?.(jobStates, jobMeta);
  };

  const promoteToRunning = (index: number) => {
    if (jobStates[index].status === "starting") {
      updateStatus(index, "running");
    }
  };

  const setTeardown = (index: number, inTeardown: boolean) => {
    if (Boolean(jobStates[index].inTeardown) === inTeardown) return;
    jobStates[index] = { ...jobStates[index], inTeardown };
    logger.onJobUpdate?.(jobStates, jobMeta);
  };

  /**
   * Monotonic live-token bump — drops any non-increasing estimates. Setting
   * `final` true stamps `tokensFinal` so the UI knows the number is now the
   * authoritative total (from `metadata.tokenUsage`), not an estimate.
   */
  const updateTokens = (index: number, tokens: number, final = false) => {
    const prev = jobStates[index].liveTokens ?? 0;
    const grew = tokens > prev;
    const newlyFinal = final && !jobStates[index].tokensFinal;
    if (!grew && !newlyFinal) return;
    jobStates[index] = {
      ...jobStates[index],
      liveTokens: grew ? tokens : prev,
      ...(newlyFinal ? { tokensFinal: true } : {}),
    };
    logger.onJobUpdate?.(jobStates, jobMeta);
  };

  // Build filtered environment once for all jobs
  const jobEnv = buildJobEnv(config);

  // --- Validate required env vars and resolve CLI binaries for each adapter ---
  // This runs BEFORE the initial onJobUpdate so that any logger.info calls
  // from ensureInstalled (e.g. npx fallback messages) don't interfere with
  // ink's cursor tracking when it starts rendering the live display.
  const checkedAdapters = new Set<string>();
  const adapterNames = jobs.map((j) => j.agentConfig.agent);
  // Every configured judge runs as an LLM via its adapter too, so each one
  // needs the same env/binary checks. Surfacing missing creds here keeps
  // scoring failures from showing up only after every run has executed.
  for (const entry of config.judging?.agents ?? []) {
    if (typeof entry === "object") adapterNames.push(entry.agent);
  }

  for (const agentName of adapterNames) {
    if (checkedAdapters.has(agentName)) continue;
    checkedAdapters.add(agentName);

    const adapter = getAdapter(agentName);
    const required = adapter.requiredEnv?.() ?? [];
    const missing = required.filter((key) => !jobEnv[key]);
    if (missing.length > 0) {
      // No API key — fall back to a local CLI login if the adapter supports
      // detecting one (e.g. `claude login`, `codex login`). Explicit env vars
      // always win, so this only runs when they're missing.
      const hasLocal = (await adapter.hasLocalSession?.()) ?? false;
      if (!hasLocal) {
        throw new Error(
          `The "${agentName}" agent requires environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ` +
            `but ${missing.length > 1 ? "they are" : "it is"} not set, and no local CLI session was detected. ` +
            `Either log in (e.g. \`${agentName} login\`) or add ${missing.length > 1 ? "them" : "it"} to your shell environment or the "env" array in axis.config.json.`,
        );
      }
      logger.verbose?.(`[${agentName}] No ${missing.join(", ")} found — using local CLI session.`);
    }

    // Resolve CLI binary (direct or npx fallback)
    if (adapter.ensureInstalled) {
      await adapter.ensureInstalled(logger);
    }
  }

  // --- Resolve skills (once, before any jobs start) ---
  const allSkillSources = new Set<string>(config.skills ?? []);
  for (const job of jobs) {
    for (const s of job.agentConfig.skills ?? []) {
      allSkillSources.add(s);
    }
    for (const s of job.scenario.skills ?? []) {
      allSkillSources.add(s);
    }
  }

  const resolvedSkillMap = new Map<string, ResolvedSkill>();
  if (allSkillSources.size > 0) {
    const resolved = await resolveSkills({
      sources: [...allSkillSources],
      configDir,
      cacheDir: path.join(configDir, ".axis", "skills-cache"),
      logger,
      refresh: options.refreshSkills,
    });
    const sources = [...allSkillSources];
    for (let i = 0; i < sources.length; i++) {
      resolvedSkillMap.set(sources[i], resolved[i]);
    }
  }

  // --- Fetch repositories staged by `copy` actions (once, before any jobs) ---
  // Jobs run in parallel and many scenarios point at the same repo, so warming
  // the cache here means one clone per (repo, ref) instead of a race between
  // job setups. A failure is not fatal to the whole run: the jobs that need
  // that repo fail in setup (reusing this same cached error, so there's still
  // only one clone attempt) while unrelated jobs carry on.
  const repoCacheRoot = defaultRepoCacheRoot(configDir);
  const repoSources = new Map<string, GitCopySource>();
  for (const job of jobs) {
    collectGitCopySources(job.scenario.setup, repoCacheRoot, repoSources);
    collectGitCopySources(job.scenario.teardown, repoCacheRoot, repoSources);
  }
  for (const source of repoSources.values()) {
    try {
      await ensureRepo(source, { cacheRoot: repoCacheRoot, logger, refresh: options.refreshRepos });
    } catch (err) {
      logger.error(formatError(err));
    }
  }

  // Emit initial state after pre-flight so ink's first render is clean
  logger.onJobUpdate?.(jobStates, jobMeta);

  // --- Resolve overall limits ---
  const runLimits = config.settings?.limits?.run;
  const defaultScenarioLimits = config.settings?.limits?.scenario;

  const runAbortController = new AbortController();
  let runTimeLimitTimer: NodeJS.Timeout | undefined;

  // External cancel (e.g. CLI SIGINT) — propagate to the run-level controller
  // so pending jobs short-circuit to failure and in-flight jobs get SIGTERMed.
  // Existing finalize/report flow then runs to completion.
  if (options.signal) {
    const external = options.signal;
    const onExternalAbort = () => {
      if (!runAbortController.signal.aborted) {
        runAbortController.abort(external.reason ?? "Run aborted by signal");
      }
    };
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  // When the run is aborted, eagerly flip every still-pending job to "failed"
  // so the live display reflects the cancel immediately — workers will iterate
  // through them anyway, but in the meantime the UI would otherwise show them
  // as "pending" while in-flight jobs are still winding down.
  runAbortController.signal.addEventListener(
    "abort",
    () => {
      for (let i = 0; i < jobStates.length; i++) {
        if (jobStates[i].status === "pending") {
          updateStatus(i, "failed", 0);
        }
      }
    },
    { once: true },
  );

  // Start overall time limit timer
  if (runLimits?.time_minutes) {
    const runTimeMs = runLimits.time_minutes * 60 * 1000;
    runTimeLimitTimer = setTimeout(() => {
      if (!runAbortController.signal.aborted) {
        runAbortController.abort(`Overall time limit reached (${formatLimitMinutes(runTimeMs)})`);
      }
    }, runTimeMs);
  }

  // Overall token limit: check cumulative tokens on every update
  const runTokenLimit = runLimits?.tokens;
  const checkOverallTokenLimit = () => {
    if (!runTokenLimit || runAbortController.signal.aborted) return;
    const cumulative = jobStates.reduce((sum, s) => sum + (s.liveTokens ?? 0), 0);
    if (cumulative >= runTokenLimit) {
      runAbortController.abort(`Overall token limit reached (${runTokenLimit} tokens)`);
    }
  };

  // --- Execute jobs with concurrency control ---
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const tasks = jobs.map((job) => async () => {
    // If overall abort already fired, fail immediately
    if (runAbortController.signal.aborted) {
      const reason = String(runAbortController.signal.reason);
      updateStatus(job.index, "failed", 0);
      return buildFailedResult(job, reason);
    }

    // Per-job abort controller, linked to overall
    const jobAbortController = new AbortController();
    const onRunAbort = () => {
      jobAbortController.abort(runAbortController.signal.reason);
    };
    runAbortController.signal.addEventListener("abort", onRunAbort, { once: true });

    const jobLimits = resolveJobLimits(job.scenario, defaultScenarioLimits);

    try {
      const { result, cleanup } = await executeJob(
        job,
        jobEnv,
        logger,
        updateStatus,
        updateTokens,
        promoteToRunning,
        resolvedSkillMap,
        options.registerCleanup,
        options.debug ?? false,
        jobAbortController,
        jobLimits,
        checkOverallTokenLimit,
        options.reportDir,
      );

      try {
        // Allow external processing (e.g. scoring/verification) before teardown.
        // If onResult returns a Promise, we await it so the judge can verify
        // results before teardown scripts destroy resources.
        if (options.onResult) {
          await options.onResult(result);
        }
      } finally {
        setTeardown(job.index, true);
        try {
          await cleanup();
        } finally {
          setTeardown(job.index, false);
        }
      }
      return result;
    } finally {
      runAbortController.signal.removeEventListener("abort", onRunAbort);
    }
  });
  const results = await runWithConcurrency(tasks, concurrency);

  // Clean up overall time limit timer
  if (runTimeLimitTimer) clearTimeout(runTimeLimitTimer);

  return buildOutput(runStart, results, skippedCount, failedToLoad);
}

/** `1 scenario` / `3 scenarios`. */

/**
 * Fail when a scenario is excluded from the default suite and no profile
 * claims it, which means it can never run under any profile. Silent
 * unreachability is the failure mode that suite-level `exclude` introduces,
 * so it is a hard error rather than a warning.
 *
 * Only meaningful once `profiles` exist: without them, `exclude` is just
 * "never run this" and unreachability is the point.
 */
async function assertEveryScenarioIsReachable(
  baseConfig: AxisConfig,
  configDir: string,
  logger: Logger,
  loadFailures: Map<string, ScenarioLoadFailure>,
): Promise<void> {
  const profiles = baseConfig.profiles;
  if (!profiles) return;
  // With no base selector every scenario is in the default suite already.
  if (!baseConfig.include?.length && !baseConfig.exclude?.length) return;

  const pool = await discoverScenarios(configDir, baseConfig.scenarios, undefined, {
    logger,
    maxRemotesDepth: baseConfig.settings?.remotes?.maxDepth,
    onLoadFailure: (failure) => loadFailures.set(failure.path, failure),
  });

  const reachable = new Set<string>();
  const claim = (include?: string[], exclude?: string[]) => {
    for (const s of applySuiteSelector(pool, include, exclude)) reachable.add(s.key);
  };

  claim(baseConfig.include, baseConfig.exclude);
  for (const overlay of Object.values(profiles)) {
    // A profile with no selector of its own runs the default suite, already
    // claimed above.
    if (overlay.include === undefined && overlay.exclude === undefined) continue;
    claim(overlay.include, overlay.exclude);
  }

  // Scenarios disabled at the source are meant to be unreachable.
  const orphans = pool.filter((s) => !s.skip && !reachable.has(s.key)).map((s) => s.key);
  if (orphans.length === 0) return;

  const them = orphans.length === 1 ? "it" : "them";
  throw new Error(
    `${plural(orphans.length, "scenario")} excluded from the default suite with no profile to claim ${them}: ` +
      `${formatKeyList(orphans)}. Add ${them} to a profile's "include", or set "skip: true" on the scenario ` +
      `to disable ${them} outright.`,
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Comma-joined list, capped so a big suite doesn't flood the preamble. */
function formatKeyList(keys: string[], limit = 5): string {
  const sorted = [...keys].sort();
  if (sorted.length <= limit) return sorted.join(", ");
  return `${sorted.slice(0, limit).join(", ")}, and ${sorted.length - limit} more`;
}

/**
 * Report the denominator before anything runs: how many scenarios were found,
 * how many are opted out, and whether any file failed to load. Without this a
 * run that covers fewer scenarios than intended still prints a clean summary,
 * so a scenario that quietly stopped loading looks like a passing report.
 */
function logDiscoverySummary(
  logger: Logger,
  jobs: Job[],
  skippedKeys: Set<string>,
  loadFailures: ScenarioLoadFailure[],
): void {
  if (jobs.length === 0) {
    logger.info("No jobs discovered.");
  } else {
    const scenarioCount = new Set(jobs.map((j) => j.scenario.key)).size;
    const agentCount = new Set(jobs.map((j) => j.agentName)).size;
    const pairCount = new Set(jobs.map((j) => `${j.scenario.key}\x00${j.agentName}`)).size;
    const maxRuns = Math.max(...jobs.map((j) => j.runCount));
    // With repeats the job count is no longer the pair count, and the gap is
    // exactly the extra spend, so name both rather than just the larger one.
    const tail =
      maxRuns > 1
        ? `${plural(pairCount, "pair")}, ${plural(jobs.length, "job")} (up to ${maxRuns} runs each)`
        : plural(jobs.length, "job");
    logger.info(`Discovered ${plural(scenarioCount, "scenario")} across ${plural(agentCount, "agent")}: ${tail}`);
  }

  if (skippedKeys.size > 0) {
    logger.info(`Skipping ${plural(skippedKeys.size, "scenario")} marked skip: ${formatKeyList([...skippedKeys])}`);
  }

  // Each failure was already logged with its reason as the walk hit it; this is
  // the roll-up so the count is visible next to the discovery numbers.
  if (loadFailures.length > 0) {
    logger.error(
      `${plural(loadFailures.length, "file")} in the scenarios tree failed to load; ` +
        `${loadFailures.length === 1 ? "its" : "their"} scenarios did not run.`,
    );
  }
}

/**
 * Warn that run-level limits are shared by every repeat.
 *
 * `settings.limits.run` is a budget for the whole run, and
 * `checkOverallTokenLimit` sums live tokens across all jobs, so raising `runs`
 * to 3 exhausts the same budget roughly three times sooner. Without this note
 * the run aborts partway through and looks like the agents got slower.
 */
function logRepeatBudgetNote(logger: Logger, jobs: Job[], config: AxisConfig): void {
  const maxRuns = jobs.length > 0 ? Math.max(...jobs.map((j) => j.runCount)) : 1;
  if (maxRuns <= 1) return;

  const runLimits = config.settings?.limits?.run;
  if (!runLimits?.tokens && !runLimits?.time_minutes) return;

  const parts: string[] = [];
  if (runLimits.tokens) parts.push(`${runLimits.tokens} tokens`);
  if (runLimits.time_minutes) parts.push(`${runLimits.time_minutes}m`);
  logger.info(
    `Run limits (${parts.join(", ")}) are shared by all ${plural(jobs.length, "job")}; ` +
      `raise settings.limits.run if ${maxRuns} runs per pair should get ${maxRuns}x the budget.`,
  );
}

interface JobOutput {
  result: RunResult;
  /** Runs teardown actions and cleans up the workspace. */
  cleanup: () => Promise<void>;
}

async function executeJob(
  job: Job,
  env: Record<string, string>,
  logger: Logger,
  updateStatus: (index: number, status: JobStatus, durationMs?: number) => void,
  updateTokens: (index: number, tokens: number, final?: boolean) => void,
  promoteToRunning: (index: number) => void,
  resolvedSkillMap: Map<string, ResolvedSkill>,
  registerCleanup?: (fn: () => void) => void,
  debug?: boolean,
  jobAbortController?: AbortController,
  jobLimits?: ResolvedJobLimits,
  checkOverallTokenLimit?: () => void,
  reportDir?: string,
): Promise<JobOutput> {
  const { index, agentName, agentConfig, scenario, axisConfig, configDir, runIndex, runCount } = job;
  const isRepeated = runCount > 1;
  const label = isRepeated
    ? `${scenario.key} (${agentName}) run ${runIndex}/${runCount}`
    : `${scenario.key} (${agentName})`;
  /** Identifies this run's slot in the report tree. */
  const runRef = { scenarioKey: scenario.key, agentName, runIndex, runCount };
  const jobStart = Date.now();

  // Create isolated workspace + home as siblings under one parent. The agent's
  // cwd is `workspace/` (pristine) while HOME and adapter config dirs
  // (CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, QWEN_CODE_HOME) live under
  // `home/`. Keeping them separate means the agent never sees its own config
  // files when scanning the project.
  const { workspace, home, parent: workspaceParent } = createWorkspace();
  const adapter = getAdapter(agentConfig.agent);
  const adapterIsolation = adapter.isolationEnv?.({ workspace, home }) ?? {};
  const jobEnv = { ...adapterIsolation, ...env, HOME: home, AXIS_CONFIG_DIR: configDir };

  // Lifecycle scripts get scenario/agent context as AXIS_* env vars so they
  // can branch on what's running without encoding it into the command string.
  // Variant names match /^[a-zA-Z0-9_-]+$/, so splitting on the first `@` is unambiguous.
  const atIndex = scenario.key.indexOf("@");
  const lifecycleContext = {
    agent: agentConfig.agent,
    scenario: scenario.key,
    ...(agentConfig.model ? { model: agentConfig.model } : {}),
    ...(atIndex >= 0 ? { variant: scenario.key.slice(atIndex + 1) } : {}),
    // Always exposed, even for a single run, so a setup script can namespace
    // shared external resources by run without branching on whether repeats
    // are configured.
    runIndex,
    runCount,
  };
  logger.verbose?.(`[${label}] Workspace: ${workspace}`);
  logger.verbose?.(`[${label}] Home: ${home}`);

  // Register the parent dir for cleanup on process signal (Ctrl-C) — removing
  // it covers both `workspace/` and `home/` in one shot.
  registerCleanup?.(() => {
    try {
      fs.rmSync(workspaceParent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  const artifactPatterns = resolveArtifactPatterns(axisConfig, scenario);
  // The result reference is needed inside cleanup so we can attach the
  // captured artifacts before the function returns. It is assigned in the
  // try block below, before cleanup is invoked.
  let resultRef: RunResult | undefined;

  const cleanup = async () => {
    if (scenario.teardown?.length) {
      logger.verbose?.(`[${label}] Running teardown...`);
      const outcome = await runLifecyclePhase(scenario.teardown, workspace, jobEnv, "teardown", lifecycleContext, {
        sourceRoot: configDir,
        repoCacheRoot: defaultRepoCacheRoot(configDir),
        debug,
        logger,
      });
      if (outcome.error) {
        logger.error(`[${label}] Teardown failed: ${formatError(outcome.error)}`);
      }
      if (resultRef && outcome.output) {
        resultRef.teardownOutput = outcome.output;
      }
    }
    if (resultRef && reportDir && artifactPatterns.length > 0) {
      const destDir = path.join(reportDir, artifactsPath(runRef));
      try {
        const captured = captureArtifacts(workspace, artifactPatterns, destDir, logger);
        if (captured.length > 0) {
          resultRef.artifacts = captured;
          logger.verbose?.(`[${label}] Captured ${captured.length} artifact(s)`);
        }
      } catch (err) {
        logger.error(`[${label}] Artifact capture failed: ${formatError(err)}`);
      }
    }
    try {
      fs.rmSync(workspaceParent, { recursive: true, force: true });
      logger.verbose?.(`[${label}] Cleaned up workspace: ${workspaceParent}`);
    } catch {
      logger.verbose?.(`[${label}] Failed to clean up workspace: ${workspaceParent}`);
    }
  };

  // Setup
  let setupOutput: string | undefined;
  if (scenario.setup?.length) {
    updateStatus(index, "setup");
    logger.verbose?.(`[${label}] Running setup...`);
    const outcome = await runLifecyclePhase(scenario.setup, workspace, jobEnv, "setup", lifecycleContext, {
      sourceRoot: configDir,
      repoCacheRoot: defaultRepoCacheRoot(configDir),
      debug,
      logger,
    });
    setupOutput = outcome.output;
    if (outcome.error) throw outcome.error;
  }

  // Debug-mode tail files: when --debug is set and we have a report directory,
  // stream each captured raw stdout line and stderr chunk to disk while the
  // agent works, adjacent to where `writeScenarioRawData` will eventually emit
  // `{agent}.raw.ndjson`.
  let debugStream: fs.WriteStream | undefined;
  let debugStderrStream: fs.WriteStream | undefined;
  let onRawLine: ((line: string) => void) | undefined;
  let onStderr: ((chunk: string) => void) | undefined;
  if (debug && reportDir) {
    const debugPath = path.join(reportDir, runSiblingPath(runRef, "debug.ndjson"));
    const debugStderrPath = path.join(reportDir, runSiblingPath(runRef, "debug.stderr.log"));
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    debugStream = fs.createWriteStream(debugPath);
    debugStderrStream = fs.createWriteStream(debugStderrPath);
    onRawLine = (line) => {
      debugStream!.write(line + "\n");
    };
    onStderr = (chunk) => {
      debugStderrStream!.write(chunk);
    };
    logger.verbose?.(`[${label}] Debug stream: ${debugPath}`);
    logger.verbose?.(`[${label}] Debug stderr: ${debugStderrPath}`);
  }

  try {
    updateStatus(index, "starting");
    logger.verbose?.(`[${label}] Executing agent...`);

    // Merge top-level + per-agent + per-scenario skills, deduplicate by source
    const skillSources = [...(axisConfig.skills ?? []), ...(agentConfig.skills ?? []), ...(scenario.skills ?? [])];
    const seenSkills = new Set<string>();
    const agentSkills: ResolvedSkill[] = [];
    for (const source of skillSources) {
      if (seenSkills.has(source)) continue;
      seenSkills.add(source);
      const resolved = resolvedSkillMap.get(source);
      if (resolved) agentSkills.push(resolved);
    }

    const output = await adapter.run({
      prompt: scenario.prompt,
      config: agentConfig,
      scenario,
      workingDirectory: workspace,
      homeDirectory: home,
      env: jobEnv,
      registerCleanup,
      captureRawOutput: true,
      ...(onRawLine ? { onRawLine } : {}),
      ...(onStderr ? { onStderr } : {}),
      mcpServers: scenario.mcp_servers
        ? { ...axisConfig.mcp_servers, ...scenario.mcp_servers }
        : axisConfig.mcp_servers,
      resolvedSkills: agentSkills.length > 0 ? agentSkills : undefined,
      onTokenProgress: (tokens) => {
        // First token from the agent → it's past startup, into real work.
        promoteToRunning(index);
        updateTokens(index, tokens);
        // Per-scenario token limit
        if (jobLimits?.tokenLimit && tokens >= jobLimits.tokenLimit) {
          jobAbortController?.abort(`Scenario token limit reached (${jobLimits.tokenLimit} tokens)`);
        }
        // Overall token limit (checks cumulative across all jobs)
        checkOverallTokenLimit?.();
      },
      onAgentReady: () => promoteToRunning(index),
      ...(jobLimits?.timeoutMs ? { timeoutMs: jobLimits.timeoutMs } : {}),
      ...(jobAbortController ? { signal: jobAbortController.signal } : {}),
      debug,
    });

    // Rewrite adapter timeout error to scenario-specific message when a
    // per-scenario time limit was the cause.
    if (output.metadata.error?.startsWith("Agent timed out") && jobLimits?.timeoutMs) {
      output.metadata.error = `Scenario time limit reached (${formatLimitMinutes(jobLimits.timeoutMs)})`;
    }

    // If the abort signal fired during execution but the adapter didn't
    // handle it (e.g. mock adapters, custom adapters without signal support),
    // apply the abort reason as the error on the runner side.
    if (jobAbortController?.signal.aborted && !output.metadata.error) {
      output.metadata.error = String(jobAbortController.signal.reason);
      if (output.metadata.exitCode === 0) {
        output.metadata.exitCode = 1;
      }
    }

    // Snap the live counter up to the real total (input + output + cache).
    // The UI animates up to this value — it won't exceed it because
    // `updateTokens` is monotonic. Passing `final: true` marks `tokensFinal`
    // so the UI can drop the `~` approximation prefix once the animation
    // catches up.
    const usage = output.metadata.tokenUsage;
    if (usage) {
      const realTotal = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheReadInput ?? 0);
      updateTokens(index, realTotal, true);
      // Re-check overall token limit with the authoritative total
      checkOverallTokenLimit?.();
    }

    // Some adapters may never emit tokens nor signal readiness; ensure those
    // jobs still transition out of "starting" before final status.
    promoteToRunning(index);

    const durationMs = output.metadata.durationMs || Date.now() - jobStart;
    const failed = isFailedRun(output);
    updateStatus(index, failed ? "failed" : "done", durationMs);

    const result: RunResult = {
      scenarioKey: scenario.key,
      scenarioName: scenario.name,
      agentName,
      ...(isRepeated ? { runIndex, runCount } : {}),
      prompt: scenario.prompt,
      judge: scenario.judge,
      agentConfig,
      output,
      workingDirectory: workspace,
      resolvedConfig: buildResolvedRunConfig(scenario, axisConfig, agentConfig),
      ...(setupOutput ? { setupOutput } : {}),
    };
    resultRef = result;
    return { result, cleanup };
  } catch (err) {
    updateStatus(index, "failed", Date.now() - jobStart);
    // On unexpected errors, clean up immediately (nothing to verify)
    await cleanup();
    throw err;
  } finally {
    debugStream?.end();
    debugStderrStream?.end();
  }
}

/**
 * Reorder jobs run-major: every pair's run 1 before any pair's run 2, and so
 * on, preserving discovery order within each pass.
 *
 * Repeats exist to sample the agent, so they should not all execute at the
 * same instant. Left in discovery order, a pair's three runs sit adjacent in
 * the queue and start together, which maximizes contention on the same
 * provider rate limit and turns correlated 429s into what looks like variance
 * in the agent. Spreading them across passes is the cheap version of what
 * Lighthouse gets by serializing its runs outright.
 *
 * `Array.prototype.sort` is stable, so sorting on `runIndex` alone is enough.
 * Reassigns `index` so `jobStates[i]` still lines up with `jobs[i]`.
 */
function orderRunMajor(jobs: Job[]): void {
  jobs.sort((a, b) => a.runIndex - b.runIndex);
  jobs.forEach((job, i) => (job.index = i));
}

/**
 * Run async tasks with a concurrency limit.
 * Results are returned in the same order as the input tasks.
 * When limit is Infinity, all tasks run simultaneously (same as Promise.all).
 */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workerCount = Math.min(Number.isFinite(limit) ? limit : tasks.length, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Create the per-job temp layout:
 *
 *   parent/
 *     ├── work/   — agent cwd
 *     └── home/   — agent HOME (config dirs, MCP, user-scoped skills)
 *
 * Returning the parent path lets the caller wipe both children in one rmSync.
 */
function createWorkspace(): { workspace: string; home: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "axis-"));
  const workspace = path.join(parent, "work");
  const home = path.join(parent, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  return { workspace, home, parent };
}

export function buildJobEnv(config: AxisConfig): Record<string, string> {
  const allowedKeys = new Set<string>([...SYSTEM_VARS, ...DEFAULT_PASS_ENV, ...(config.env ?? [])]);

  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}

/**
 * Build the display name for each agent entry. Naming rules:
 *   - `{agent}|{model}` whenever a model is specified
 *   - `{agent}` otherwise
 *   - `-N` numeric suffix appended only as a tie-breaker if the rules above
 *     still produce duplicates (e.g. two entries with the same agent and no model)
 *
 * The model portion is sanitized (see `sanitizeModelForName`) so provider-prefixed
 * models like "anthropic/claude-3.5-sonnet" don't break report file paths. The raw
 * model is still passed verbatim to the agent CLI via `config.model`.
 */
function normalizeAgents(agents: (string | AgentConfig)[]): Array<{ name: string; config: AgentConfig }> {
  const result: Array<{ name: string; config: AgentConfig }> = [];
  const nameCounts = new Map<string, number>();
  // Every assigned name, explicit or derived. An agent name is a report path
  // segment and a baseline key, so two entries resolving to the same one would
  // silently overwrite each other's results instead of producing two rows.
  const used = new Set<string>();

  for (const entry of agents) {
    const config: AgentConfig = typeof entry === "string" ? { agent: entry } : entry;

    // An explicit name is the entry's identity verbatim: no counter suffix, so
    // it stays stable when entries are added or reordered around it. Renaming
    // one behind the user's back would be worse than failing.
    if (config.name) {
      if (used.has(config.name)) {
        throw new Error(
          `Duplicate agent name "${config.name}". Each agents[].name must be unique and must not ` +
            `collide with the "{agent}|{model}" name another entry derives.`,
        );
      }
      used.add(config.name);
      result.push({ name: config.name, config });
      continue;
    }

    const baseName = buildAgentBaseName(config.agent, config.model);
    const count = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, count);

    const name = count === 1 ? baseName : `${baseName}-${count}`;
    // The counter only tracks derived names, so a derived name can still land
    // on one an earlier entry claimed explicitly.
    if (used.has(name)) {
      throw new Error(
        `Agent entry "${config.agent}"${config.model ? ` (model "${config.model}")` : ""} derives the name ` +
          `"${name}", which another entry already claims via its "name" field. Rename one of them.`,
      );
    }
    used.add(name);
    result.push({ name, config });
  }

  return result;
}

/**
 * Per-scenario `agents: [...]` filter: an entry matches if it equals the
 * generated agent name OR its base agent (the part before `|model`).
 * This lets `agents: ["claude-code"]` apply to `claude-code|opus`,
 * `claude-code|sonnet`, etc. without enumerating every model.
 */
function scenarioAgentFilterMatches(filter: string[], generatedName: string, baseAgent: string): boolean {
  return filter.includes(generatedName) || filter.includes(baseAgent);
}

function buildFailedResult(job: Job, error: string): RunResult {
  const now = new Date().toISOString();
  return {
    scenarioKey: job.scenario.key,
    scenarioName: job.scenario.name,
    agentName: job.agentName,
    ...(job.runCount > 1 ? { runIndex: job.runIndex, runCount: job.runCount } : {}),
    prompt: job.scenario.prompt,
    judge: job.scenario.judge,
    agentConfig: job.agentConfig,
    resolvedConfig: buildResolvedRunConfig(job.scenario, job.axisConfig, job.agentConfig),
    output: {
      transcript: [],
      result: null,
      metadata: {
        startTime: now,
        endTime: now,
        durationMs: 0,
        exitCode: 1,
        error,
      },
    },
  };
}

/**
 * Roll per-run results up into pair-level totals.
 *
 * `total`/`completed`/`failed` count scenario/agent pairs so the headline
 * numbers keep their meaning when `runs` is raised: a pair counts as completed
 * if any of its runs produced usable output, and only a pair where every run
 * failed is a failure. Individual flaky runs surface through `runsFailed` and
 * the report's per-pair reliability, not by failing the suite.
 *
 * When every pair ran once, pairs and runs are the same thing and the run
 * counters are omitted so single-run output is unchanged.
 */
function buildOutput(
  runStart: number,
  results: RunResult[],
  skippedCount = 0,
  loadFailures: ScenarioLoadFailure[] = [],
): RunOutput {
  const pairs = groupRunsByPair(results);
  let completed = 0;
  for (const runs of pairs.values()) {
    if (runs.some((r) => !isFailedRun(r.output))) completed++;
  }
  const runsFailed = results.filter((r) => isFailedRun(r.output)).length;
  const repeated = results.length !== pairs.size;

  return {
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - runStart,
    results,
    summary: {
      total: pairs.size,
      completed,
      failed: pairs.size - completed,
      ...(repeated ? { runsTotal: results.length, runsFailed } : {}),
      ...(skippedCount > 0 ? { skipped: skippedCount } : {}),
      ...(loadFailures.length > 0 ? { loadFailed: loadFailures.length } : {}),
    },
    ...(loadFailures.length > 0 ? { loadFailures } : {}),
  };
}
