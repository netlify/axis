import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, discoverScenarios } from "../config/loader.js";
import { getAdapter, registerAdapter } from "../adapters/registry.js";
import { executeLifecycleActions } from "./lifecycle.js";
import type { RunOutput, RunResult, Logger, JobState, JobStatus } from "../types/output.js";
import { silentLogger as defaultLogger, formatError } from "../types/output.js";
import type { Scenario } from "../types/scenario.js";
import type { AgentConfig, AxisConfig, ResolvedSkill } from "../types/config.js";
import { resolveSkills } from "../skills/resolver.js";

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

/** Default env when not specified in config. */
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
    if (options.agentFilter?.length && !options.agentFilter.includes(agentName)) {
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
      ? scenarios.filter((s) =>
          options.scenarioFilter!.some((f) => f === s.key || (s.key.includes("@") && f === s.key.split("@")[0])),
        )
      : scenarios;

    for (const scenario of filteredScenarios) {
      // Scenario-level agent override: if set, only listed agents run this scenario
      if (scenario.agents && !scenario.agents.includes(agentName)) {
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
    if (checkedAdapters.has(job.agentConfig.adapter)) continue;
    checkedAdapters.add(job.agentConfig.adapter);

    const adapter = getAdapter(job.agentConfig.adapter);
    const required = adapter.requiredEnv?.() ?? [];
    const missing = required.filter((key) => !jobEnv[key]);
    if (missing.length > 0) {
      throw new Error(
        `The "${job.agentConfig.adapter}" adapter requires environment variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ` +
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

  // --- Execute jobs with concurrency control ---
  const concurrency = options.concurrency ?? Infinity;
  const tasks = jobs.map((job) => async () => {
    const { result, cleanup } = await executeJob(
      job,
      jobEnv,
      logger,
      updateStatus,
      updateTokens,
      resolvedSkillMap,
      options.registerCleanup,
      options.debug,
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
  });
  const results = await runWithConcurrency(tasks, concurrency);

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
  _debug?: boolean,
): Promise<JobOutput> {
  const { index, agentName, agentConfig, scenario, axisConfig } = job;
  const label = `${scenario.key} (${agentName})`;
  const jobStart = Date.now();

  // Create isolated workspace and point HOME there so agents
  // don't pick up the user's global settings (e.g. ~/.claude/).
  const workspace = createWorkspace();
  const adapter = getAdapter(agentConfig.adapter);
  const adapterIsolation = adapter.isolationEnv?.(workspace) ?? {};
  const jobEnv = { ...adapterIsolation, ...env, HOME: workspace };
  logger.verbose?.(`[${label}] Workspace: ${workspace}`);

  // Register workspace for cleanup on process signal (Ctrl-C)
  registerCleanup?.(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  const cleanup = async () => {
    if (scenario.teardown?.length) {
      logger.verbose?.(`[${label}] Running teardown...`);
      await executeLifecycleActions(scenario.teardown, workspace, jobEnv).catch((teardownErr) => {
        logger.error(`[${label}] Teardown failed: ${formatError(teardownErr)}`);
      });
    }
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      logger.verbose?.(`[${label}] Cleaned up workspace: ${workspace}`);
    } catch {
      logger.verbose?.(`[${label}] Failed to clean up workspace: ${workspace}`);
    }
  };

  // Setup
  if (scenario.setup?.length) {
    updateStatus(index, "setup");
    logger.verbose?.(`[${label}] Running setup...`);
    await executeLifecycleActions(scenario.setup, workspace, jobEnv);
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
      mcpServers: scenario.mcp_servers
        ? { ...axisConfig.mcp_servers, ...scenario.mcp_servers }
        : axisConfig.mcp_servers,
      resolvedSkills: agentSkills.length > 0 ? agentSkills : undefined,
      onTokenProgress: (tokens) => updateTokens(index, tokens),
    });

    // Snap the live counter up to the real total (input + output + cache).
    // The UI animates up to this value — it won't exceed it because
    // `updateTokens` is monotonic. Passing `final: true` marks `tokensFinal`
    // so the UI can drop the `~` approximation prefix once the animation
    // catches up.
    const usage = output.metadata.tokenUsage;
    if (usage) {
      const realTotal = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheReadInput ?? 0);
      updateTokens(index, realTotal, true);
    }

    const durationMs = output.metadata.durationMs || Date.now() - jobStart;
    const failed = output.metadata.exitCode !== 0 || !!output.metadata.error;
    updateStatus(index, failed ? "failed" : "done", durationMs);

    return {
      result: {
        scenarioKey: scenario.key,
        scenarioName: scenario.name,
        agentName,
        prompt: scenario.prompt,
        rubric: scenario.rubric,
        agentConfig,
        output,
        workingDirectory: workspace,
      },
      cleanup,
    };
  } catch (err) {
    updateStatus(index, "failed", Date.now() - jobStart);
    // On unexpected errors, clean up immediately (nothing to verify)
    await cleanup();
    throw err;
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

function buildJobEnv(config: AxisConfig): Record<string, string> {
  const passthrough = config.env ?? DEFAULT_PASS_ENV;
  const allowedKeys = [...SYSTEM_VARS, ...passthrough];

  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}

function normalizeAgents(agents: (string | AgentConfig)[]): Array<{ name: string; config: AgentConfig }> {
  const nameCounts = new Map<string, number>();
  const result: Array<{ name: string; config: AgentConfig }> = [];

  for (const entry of agents) {
    const config: AgentConfig = typeof entry === "string" ? { adapter: entry } : entry;

    const baseName = config.adapter;
    const count = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, count);

    const name = count === 1 ? baseName : `${baseName}-${count}`;
    result.push({ name, config });
  }

  return result;
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
