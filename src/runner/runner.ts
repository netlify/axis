import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, discoverScenarios, matchesScenarioFilter, matchesAgentFilter } from "../config/loader.js";
import { getAdapter, registerAdapter } from "../adapters/registry.js";
import { runLifecyclePhase } from "./lifecycle.js";
import { captureArtifacts, resolveArtifactPatterns } from "./artifacts.js";
import type { ResolvedRunConfig, RunOutput, RunResult, Logger, JobState, JobStatus } from "../types/output.js";
import { silentLogger as defaultLogger, formatError } from "../types/output.js";
import type { Scenario } from "../types/scenario.js";
import type { AgentConfig, AxisConfig, ResolvedSkill, ScenarioLimitsConfig } from "../types/config.js";
import { resolveSkills } from "../skills/resolver.js";

// ---------------------------------------------------------------------------
// Limit resolution
// ---------------------------------------------------------------------------

/** Default per-scenario time limit when none is configured (15 minutes). */
const DEFAULT_SCENARIO_TIME_MINUTES = 15;

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
  scenarioFilter?: string[];
  agentFilter?: string[];
  logger?: Logger;
  /**
   * Maximum number of jobs to run in parallel.
   * Defaults to unlimited (all jobs start simultaneously).
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
  /**
   * Report directory root. When provided and the scenario configures `artifacts`
   * patterns, captured files are copied to
   * `{reportDir}/scenarios/{scenarioKey}/{agentName}/artifacts/...` after teardown.
   */
  reportDir?: string;
}

interface Job {
  index: number;
  agentName: string;
  agentConfig: AgentConfig;
  scenario: Scenario;
  configDir: string;
  axisConfig: AxisConfig;
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
  const { config, configDir } = await loadConfig(options.configPath);

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

  for (const { name: agentName, config: agentConfig } of agents) {
    if (options.agentFilter?.length && !matchesAgentFilter(agentName, options.agentFilter)) {
      continue;
    }

    const allScenarios = await discoverScenarios(configDir, config.scenarios, agentConfig.scenarios);

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
      jobs.push({ index: jobs.length, agentName, agentConfig, scenario, configDir, axisConfig: config });
    }
  }

  const skippedCount = skippedKeys.size;

  if (jobs.length === 0) {
    logger.info("No jobs discovered.");
    return buildOutput(runStart, [], skippedCount);
  }

  // --- Initialize job state tracker ---
  const jobStates: JobState[] = jobs.map((job) => ({
    scenarioKey: job.scenario.key,
    agentName: job.agentName,
    status: "pending" as JobStatus,
  }));
  const jobMeta = skippedCount > 0 ? { skipped: skippedCount } : undefined;

  const updateStatus = (index: number, status: JobStatus, durationMs?: number) => {
    const patch: Partial<JobState> = { status, durationMs };
    // Stamp the start time on the first transition into "running" so the
    // live UI can tick an elapsed-duration counter.
    if (status === "running" && jobStates[index].runStartedAt === undefined) {
      patch.runStartedAt = Date.now();
    }
    jobStates[index] = { ...jobStates[index], ...patch };
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
  for (const job of jobs) {
    if (checkedAdapters.has(job.agentConfig.agent)) continue;
    checkedAdapters.add(job.agentConfig.agent);

    const adapter = getAdapter(job.agentConfig.agent);
    const required = adapter.requiredEnv?.() ?? [];
    const missing = required.filter((key) => !jobEnv[key]);
    if (missing.length > 0) {
      throw new Error(
        `The "${job.agentConfig.agent}" agent requires environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ` +
          `but ${missing.length > 1 ? "they are" : "it is"} not set. ` +
          `Add ${missing.length > 1 ? "them" : "it"} to your shell environment or to the "env" array in axis.config.json.`,
      );
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

  // Emit initial state after pre-flight so ink's first render is clean
  logger.onJobUpdate?.(jobStates, jobMeta);

  // --- Resolve overall limits ---
  const runLimits = config.settings?.limits?.run;
  const defaultScenarioLimits = config.settings?.limits?.scenario;

  const runAbortController = new AbortController();
  let runTimeLimitTimer: NodeJS.Timeout | undefined;

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
  const concurrency = options.concurrency ?? Infinity;
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
        await cleanup();
      }
      return result;
    } finally {
      runAbortController.signal.removeEventListener("abort", onRunAbort);
    }
  });
  const results = await runWithConcurrency(tasks, concurrency);

  // Clean up overall time limit timer
  if (runTimeLimitTimer) clearTimeout(runTimeLimitTimer);

  return buildOutput(runStart, results, skippedCount);
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
  resolvedSkillMap: Map<string, ResolvedSkill>,
  registerCleanup?: (fn: () => void) => void,
  debug?: boolean,
  jobAbortController?: AbortController,
  jobLimits?: ResolvedJobLimits,
  checkOverallTokenLimit?: () => void,
  reportDir?: string,
): Promise<JobOutput> {
  const { index, agentName, agentConfig, scenario, axisConfig, configDir } = job;
  const label = `${scenario.key} (${agentName})`;
  const jobStart = Date.now();

  // Create isolated workspace and point HOME there so agents
  // don't pick up the user's global settings (e.g. ~/.claude/).
  const workspace = createWorkspace();
  const adapter = getAdapter(agentConfig.agent);
  const adapterIsolation = adapter.isolationEnv?.(workspace) ?? {};
  const jobEnv = { ...adapterIsolation, ...env, HOME: workspace, AXIS_CONFIG_DIR: configDir };

  // Lifecycle scripts get scenario/agent context as AXIS_* env vars so they
  // can branch on what's running without encoding it into the command string.
  // Variant names match /^[a-zA-Z0-9_-]+$/, so splitting on the first `@` is unambiguous.
  const atIndex = scenario.key.indexOf("@");
  const lifecycleContext = {
    agent: agentConfig.agent,
    scenario: scenario.key,
    ...(agentConfig.model ? { model: agentConfig.model } : {}),
    ...(atIndex >= 0 ? { variant: scenario.key.slice(atIndex + 1) } : {}),
  };
  logger.verbose?.(`[${label}] Workspace: ${workspace}`);

  // Register workspace for cleanup on process signal (Ctrl-C)
  registerCleanup?.(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
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
      const destDir = path.join(reportDir, "scenarios", scenario.key, agentName, "artifacts");
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
      fs.rmSync(workspace, { recursive: true, force: true });
      logger.verbose?.(`[${label}] Cleaned up workspace: ${workspace}`);
    } catch {
      logger.verbose?.(`[${label}] Failed to clean up workspace: ${workspace}`);
    }
  };

  // Setup
  let setupOutput: string | undefined;
  if (scenario.setup?.length) {
    updateStatus(index, "setup");
    logger.verbose?.(`[${label}] Running setup...`);
    const outcome = await runLifecyclePhase(scenario.setup, workspace, jobEnv, "setup", lifecycleContext, {
      sourceRoot: configDir,
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
    const scenarioDir = path.join(reportDir, "scenarios", scenario.key);
    fs.mkdirSync(scenarioDir, { recursive: true });
    const debugPath = path.join(scenarioDir, `${agentName}.debug.ndjson`);
    const debugStderrPath = path.join(scenarioDir, `${agentName}.debug.stderr.log`);
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
    updateStatus(index, "running");
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
        updateTokens(index, tokens);
        // Per-scenario token limit
        if (jobLimits?.tokenLimit && tokens >= jobLimits.tokenLimit) {
          jobAbortController?.abort(`Scenario token limit reached (${jobLimits.tokenLimit} tokens)`);
        }
        // Overall token limit (checks cumulative across all jobs)
        checkOverallTokenLimit?.();
      },
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

    const durationMs = output.metadata.durationMs || Date.now() - jobStart;
    const failed = output.metadata.exitCode !== 0 || !!output.metadata.error;
    updateStatus(index, failed ? "failed" : "done", durationMs);

    const result: RunResult = {
      scenarioKey: scenario.key,
      scenarioName: scenario.name,
      agentName,
      prompt: scenario.prompt,
      rubric: scenario.rubric,
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

function createWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axis-"));
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
 */
function normalizeAgents(agents: (string | AgentConfig)[]): Array<{ name: string; config: AgentConfig }> {
  const result: Array<{ name: string; config: AgentConfig }> = [];
  const nameCounts = new Map<string, number>();

  for (const entry of agents) {
    const config: AgentConfig = typeof entry === "string" ? { agent: entry } : entry;

    const baseName = config.model ? `${config.agent}|${config.model}` : config.agent;
    const count = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, count);

    const name = count === 1 ? baseName : `${baseName}-${count}`;
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
    prompt: job.scenario.prompt,
    rubric: job.scenario.rubric,
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

function buildOutput(runStart: number, results: RunResult[], skippedCount = 0): RunOutput {
  const completed = results.filter((r) => r.output.metadata.exitCode === 0 && !r.output.metadata.error).length;

  return {
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - runStart,
    results,
    summary: {
      total: results.length,
      completed,
      failed: results.length - completed,
      ...(skippedCount > 0 ? { skipped: skippedCount } : {}),
    },
  };
}
