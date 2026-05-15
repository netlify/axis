#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { run, buildJobEnv } from "./runner/runner.js";
import { runLifecyclePhase } from "./runner/lifecycle.js";
import { loadConfig } from "./config/loader.js";
import { scoreRunResult, buildScoredOutput } from "./scoring/index.js";
import { initReport, finalizeReport } from "./reports/writer.js";
import { listReports, readReport, readScenarioResults } from "./reports/reader.js";
import { setBaseline, readBaseline, listBaselines, deleteBaseline, DEFAULT_BASELINE_NAME } from "./baselines/store.js";
import { compareBaseline } from "./baselines/compare.js";
import { getBuiltinAdapterNames } from "./adapters/registry.js";
import {
  renderReportList,
  renderReportDetail,
  renderScenarioDetail,
  renderBaselineList,
  renderBaselineShow,
  renderBaselineComparison,
} from "./ui/format.js";
import { formatError } from "./types/output.js";
import type { Logger, JobState, RunResult, RunOutput } from "./types/output.js";
import type { ScoredRunResult, ScoredOutput } from "./types/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program.name("axis").description("AXIS — Agent Experience Index Score").version(pkg.version);

// --- Signal handling: kill child processes and clean up on Ctrl-C ---

const cleanupHandlers: Array<() => void> = [];

function registerCleanup(fn: () => void): void {
  cleanupHandlers.push(fn);
}

function handleSignal(signal: NodeJS.Signals): void {
  for (const fn of cleanupHandlers) {
    try {
      fn();
    } catch {
      /* best-effort cleanup */
    }
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

// --- axis init command ---

const BUILT_IN_AGENTS = ["claude-code", "codex", "gemini"];

function prompt(rl: readline.Interface, question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

type ConfigFormat = "json" | "js" | "ts";
const CONFIG_FORMATS: ConfigFormat[] = ["json", "js", "ts"];

function renderConfigFile(format: ConfigFormat, config: { scenarios: string; agents: string[] }): string {
  const body = JSON.stringify(config, null, 2);
  if (format === "json") return body + "\n";
  if (format === "js") return `export default ${body};\n`;
  return (
    `import type { AxisConfig } from "@netlify/axis";\n\n` +
    `const config: AxisConfig = ${body};\n\n` +
    `export default config;\n`
  );
}

program
  .command("init")
  .description("Initialize a new AXIS configuration and sample scenario")
  .option("-s, --scenarios <path>", "path to scenarios directory", "./scenarios")
  .option("-a, --agent <names>", "agent(s) to include (comma-separated, e.g. claude-code,codex)")
  .option("--format <format>", `config file format (${CONFIG_FORMATS.join(", ")})`, "json")
  .option("-f, --force", "overwrite existing files")
  .action(async (opts) => {
    let scenariosPath: string = opts.scenarios;
    let agents: string[] = opts.agent
      ? opts.agent
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((a: string) => a.toLowerCase())
      : [];
    let format: ConfigFormat = opts.format;

    const hasExplicitFlags = opts.agent || opts.scenarios !== "./scenarios" || opts.format !== "json";
    const interactive = process.stdin.isTTY && !hasExplicitFlags;

    if (interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      scenariosPath = await prompt(rl, `  Scenarios directory (${scenariosPath}): `, scenariosPath);
      const agentAnswer = await prompt(rl, `  Agents [${BUILT_IN_AGENTS.join(", ")}] (claude-code): `, "claude-code");
      agents = agentAnswer
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((a) => a.toLowerCase());
      const formatAnswer = await prompt(rl, `  Config format [${CONFIG_FORMATS.join(", ")}] (${format}): `, format);
      format = formatAnswer.toLowerCase() as ConfigFormat;
      rl.close();
    }

    if (!CONFIG_FORMATS.includes(format)) {
      process.stderr.write(`\n  Invalid --format "${format}". Must be one of: ${CONFIG_FORMATS.join(", ")}.\n\n`);
      process.exit(1);
    }

    // Filter out unknown agents (warn the user about which were ignored)
    const knownAgents = new Set(getBuiltinAdapterNames());
    const ignored = agents.filter((a) => !knownAgents.has(a));
    agents = agents.filter((a) => knownAgents.has(a));

    if (ignored.length > 0) {
      process.stderr.write(
        `\n  Warning: ignoring unknown agent${ignored.length > 1 ? "s" : ""}: ${ignored.join(", ")}\n` +
          `  Built-in agents: ${getBuiltinAdapterNames().join(", ")}\n`,
      );
    }

    if (agents.length === 0) agents = ["claude-code"];

    const configFilename = `axis.config.${format}`;
    const configPath = path.resolve(configFilename);
    const scenariosDir = path.resolve(scenariosPath);
    const scenarioFile = path.join(scenariosDir, "hello-world.json");

    // Check for existing files
    if (!opts.force) {
      if (fs.existsSync(configPath)) {
        process.stderr.write(`\n  ${configFilename} already exists. Use --force to overwrite.\n\n`);
        process.exit(1);
      }
      if (fs.existsSync(scenarioFile)) {
        process.stderr.write(`\n  ${path.relative(".", scenarioFile)} already exists. Use --force to overwrite.\n\n`);
        process.exit(1);
      }
    }

    const config = {
      scenarios: scenariosPath,
      agents,
    };

    const scenario = {
      name: "Hello World",
      prompt: "Create a file called hello.txt with the content 'Hello, World!'",
      judge: [{ check: "A file named hello.txt was created" }, { check: "The file contains the text 'Hello, World!'" }],
    };

    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.writeFileSync(configPath, renderConfigFile(format, config));
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2) + "\n");

    process.stdout.write(`\n  Created ${configFilename}\n`);
    process.stdout.write(`  Created ${path.relative(".", scenarioFile)}\n\n`);
    process.stdout.write(`  Run \`axis run\` to execute your first scenario.\n\n`);
  });

// --- Shared run pipeline ---

interface RunPipelineOptions {
  configPath?: string;
  scenarios?: string[];
  agents?: string[];
  concurrency?: number;
  score: boolean;
  verbose: boolean;
  debug: boolean;
  outputDir?: string;
  json: boolean;
  refreshSkills: boolean;
  jobFilter?: Array<{ scenarioKey: string; agentName: string }>;
}

/**
 * Split a comma-separated CLI value (e.g. `--scenario foo,bar`) into a trimmed
 * non-empty list. Returns undefined when the input is missing or empty.
 */
function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Core run pipeline shared between JSON mode and interactive mode.
 * Returns the final output (scored or unscored) and the reportId.
 */
async function executeRunPipeline(
  opts: RunPipelineOptions,
  logger: Logger,
  /** Called when a job finishes and scoring begins (interactive mode only). */
  onScoringStart?: (scenarioKey: string, agentName: string) => void,
  /** Called when scoring completes for a job (interactive mode only). */
  onScoringDone?: (scored: ScoredRunResult) => void,
): Promise<{ output: ScoredOutput | RunOutput; reportId: string; configDir: string }> {
  const { config, configDir } = await loadConfig(opts.configPath);
  const scoringPromises: Promise<ScoredRunResult>[] = [];

  const concurrency = opts.concurrency ?? config.settings?.concurrency;

  if (config.beforeAll && config.beforeAll.length > 0) {
    const env = buildJobEnv(config);
    const outcome = await runLifecyclePhase(config.beforeAll, configDir, env, "beforeAll");
    if (outcome.output) logger.info(outcome.output);
    if (outcome.error) throw outcome.error;
  }

  // Create report directory early so scoring can write raw data for judges to read
  const { reportId, reportDir } = initReport(new Date().toISOString(), configDir);

  const runOutput = await run({
    configPath: opts.configPath,
    scenarioFilter: opts.scenarios,
    agentFilter: opts.agents,
    jobFilter: opts.jobFilter,
    concurrency,
    logger,
    registerCleanup,
    debug: opts.debug,
    refreshSkills: opts.refreshSkills,
    reportDir,
    onResult: opts.score
      ? (result: RunResult): Promise<void> => {
          const scoring = scoreRunResult(result, {
            weights: config.settings?.scoring_weights,
            logger,
            reportDir,
            onProgress: (scenarioKey, agentName, phase) => {
              if (phase === "start") onScoringStart?.(scenarioKey, agentName);
            },
          }).then((scored) => {
            onScoringDone?.(scored);
            return scored;
          });
          scoringPromises.push(scoring);
          return scoring.then(() => {});
        }
      : undefined,
  });

  let output: ScoredOutput | RunOutput;

  if (opts.score && runOutput.results.length > 0) {
    const scoredResults = await Promise.all(scoringPromises);
    // Artifacts and teardown notes are captured during cleanup (after scoring) —
    // propagate them onto the scored results so they appear in the final manifest.
    for (const scored of scoredResults) {
      const match = runOutput.results.find(
        (r) => r.scenarioKey === scored.scenarioKey && r.agentName === scored.agentName,
      );
      if (!match) continue;
      if (match.artifacts && match.artifacts.length > 0) {
        scored.artifacts = match.artifacts;
      }
      if (match.setupOutput) {
        scored.setupOutput = match.setupOutput;
      }
      if (match.teardownOutput) {
        scored.teardownOutput = match.teardownOutput;
      }
    }
    output = buildScoredOutput(runOutput, scoredResults);
  } else {
    output = runOutput;
  }

  // Finalize: write scenario JSON, manifest, and HTML
  finalizeReport(reportDir, output, config.name);

  if (opts.outputDir) {
    const reportPath = writeReportFile(output, opts.outputDir);
    logger.info(`Report written to ${reportPath}`);
  }

  if (config.afterAll && config.afterAll.length > 0) {
    const env: Record<string, string> = {
      ...buildJobEnv(config),
      AXIS_REPORT_DIR: reportDir,
      AXIS_TOTAL: String(output.summary.total),
      AXIS_COMPLETED: String(output.summary.completed),
      AXIS_FAILED: String(output.summary.failed),
      AXIS_DURATION_MS: String(output.durationMs),
    };
    const outcome = await runLifecyclePhase(config.afterAll, configDir, env, "afterAll");
    if (outcome.output) logger.info(outcome.output);
    if (outcome.error) throw outcome.error;
  }

  return { output, reportId, configDir };
}

// --- axis run command ---

program
  .command("run")
  .description("Run scenarios against configured agents")
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .option(
    "-s, --scenario <keys>",
    "run specific scenarios (comma-separated, supports globs e.g. 'cms/*' or 'hello-*,foo')",
  )
  .option("-a, --agent <names>", "run with specific agents (comma-separated, supports globs e.g. 'claude-code|*')")
  .option("--json", "output results as JSON to stdout", false)
  .option("-v, --verbose", "show detailed per-step logging", false)
  .option("-o, --output-dir <dir>", "also write axis-report-[timestamp].json to this directory")
  .option("--concurrency <n>", "max parallel jobs (default: 15)", parseInt)
  .option("--debug", "show debug output (workspace paths, env, lifecycle)", false)
  .option(
    "--failed [reportId]",
    "re-run only the failed scenario/agent pairs from a previous report (default: latest)",
  )
  .option("--no-score", "skip scoring (raw results only)")
  .option("--refresh-skills", "force re-clone of cached remote skills", false)
  .option(
    "--compare-baseline [name]",
    `compare results against a baseline after scoring (default: "${DEFAULT_BASELINE_NAME}")`,
  )
  .action(async (opts) => {
    // Commander gives `true` for bare flag, a string for --flag=value
    const baselineName: string | undefined =
      opts.compareBaseline === true ? DEFAULT_BASELINE_NAME : opts.compareBaseline || undefined;

    if (baselineName && !opts.score) {
      process.stderr.write("\n  Warning: --compare-baseline requires scoring. Ignoring because --no-score is set.\n\n");
    }

    const scenarios = splitCsv(opts.scenario);
    const agents = splitCsv(opts.agent)?.map((a) => a.toLowerCase());

    // --- --failed: resolve failed jobs from a previous report ---
    let jobFilter: Array<{ scenarioKey: string; agentName: string }> | undefined;
    if (opts.failed !== undefined) {
      if (scenarios || agents) {
        process.stderr.write("\n  Error: --failed cannot be combined with --scenario or --agent\n\n");
        process.exit(1);
      }
      const requestedId = opts.failed === true ? "latest" : String(opts.failed);
      const { configDir } = await loadConfig(opts.config);
      const manifest = readReport(configDir, requestedId);
      if (!manifest) {
        process.stderr.write(`\n  Error: report "${requestedId}" not found\n\n`);
        process.exit(1);
      }
      jobFilter = manifest.results
        .filter((r) => r.exitCode !== 0 || r.error)
        .map((r) => ({ scenarioKey: r.scenarioKey, agentName: r.agentName }));
      if (jobFilter.length === 0) {
        process.stderr.write(`\n  No failed jobs in report ${manifest.reportId}. Nothing to retry.\n\n`);
        process.exit(0);
      }
      process.stderr.write(`\n  Retrying ${jobFilter.length} failed job(s) from report ${manifest.reportId}\n`);
    }

    const pipelineOpts: RunPipelineOptions = {
      configPath: opts.config,
      scenarios,
      agents,
      concurrency: opts.concurrency,
      score: opts.score,
      verbose: opts.verbose,
      debug: opts.debug,
      outputDir: opts.outputDir,
      json: opts.json,
      refreshSkills: opts.refreshSkills,
      jobFilter,
    };

    // JSON mode: no UI, just run and output
    if (opts.json) {
      const logger: Logger = {
        info() {},
        error: (msg) => process.stderr.write(`  ERROR: ${msg}\n`),
      };

      try {
        const { output, reportId, configDir } = await executeRunPipeline(pipelineOpts, logger);
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");

        if (baselineName && opts.score) {
          const exitCode = runBaselineComparison(configDir, baselineName, reportId, opts.json);
          if (exitCode !== 0) process.exit(exitCode);
        }

        if (output.summary.failed > 0) process.exit(1);
      } catch (err) {
        process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
        process.exit(1);
      }
      return;
    }

    // Interactive / non-JSON mode
    const isTTY = process.stderr.isTTY ?? false;
    let onUpdate: ((jobs: JobState[], skipped: number) => void) | undefined;
    let unmountInk: (() => void) | undefined;
    let lastJobs: JobState[] = [];
    let skippedCount = 0;

    const logger: Logger = {
      info: (msg) => process.stderr.write(`  ${msg}\n`),
      error: (msg) => process.stderr.write(`  ERROR: ${msg}\n`),
      verbose: opts.verbose || opts.debug ? (msg) => process.stderr.write(`  ${msg}\n`) : undefined,
      onJobUpdate: isTTY
        ? (jobs, meta) => {
            lastJobs = jobs;
            if (meta?.skipped) skippedCount = meta.skipped;
            onUpdate?.([...jobs], skippedCount);
          }
        : undefined,
    };

    // Start ink for TTY live display
    if (isTTY) {
      try {
        const { render } = await import("ink");
        const React = await import("react");
        const { App } = await import("./ui/App.js");

        const instance = render(
          React.createElement(App, {
            subscribe: (cb: (jobs: JobState[], skipped: number) => void) => {
              onUpdate = cb;
            },
          }),
          { stdout: process.stderr, stderr: process.stderr },
        );

        unmountInk = () => {
          instance.unmount();
        };
        registerCleanup(() => unmountInk?.());
      } catch (e) {
        logger.verbose?.(`Ink display unavailable: ${formatError(e)}`);
      }
    }

    try {
      const { output, reportId, configDir } = await executeRunPipeline(
        pipelineOpts,
        logger,
        // onScoringStart
        (scenarioKey, agentName) => {
          const job = lastJobs.find((j) => j.scenarioKey === scenarioKey && j.agentName === agentName);
          if (job && job.status !== "failed") {
            job.status = "scoring";
            onUpdate?.([...lastJobs], skippedCount);
          }
        },
        // onScoringDone
        (scored) => {
          const job = lastJobs.find((j) => j.scenarioKey === scored.scenarioKey && j.agentName === scored.agentName);
          if (job) {
            if (job.status !== "failed") {
              job.status = "done";
            }
            job.axisScore = scored.score.axisScore;
            onUpdate?.([...lastJobs], skippedCount);
          }
        },
      );

      // Let ink render the final "done" state before unmounting
      if (unmountInk) await new Promise((r) => setTimeout(r, 100));
      unmountInk?.();

      process.stderr.write(`  Report saved: .axis/reports/${reportId}\n`);
      process.stderr.write(`  View details: axis reports ${reportId}\n`);
      process.stderr.write(`  Open in browser: axis reports ${reportId} --html\n\n`);

      if (baselineName && opts.score) {
        const exitCode = runBaselineComparison(configDir, baselineName, reportId, false);
        if (exitCode !== 0) process.exit(exitCode);
      }

      if (output.summary.failed > 0) process.exit(1);
    } catch (err) {
      unmountInk?.();
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

// --- axis reports command ---

program
  .command("reports")
  .description("View past AXIS reports")
  .argument("[reportId]", "report ID or 'latest' (omit to list all)")
  .argument("[scenarioKey]", "scenario key to view detailed result")
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .option("-a, --agent <name...>", "filter scenario detail to specific agent(s), repeatable")
  .option("--json", "output as JSON", false)
  .option("--html", "open report as HTML in browser", false)
  .option("-n, --limit <count>", "max reports to list", "10")
  .action(async (reportId: string | undefined, scenarioKey: string | undefined, opts) => {
    try {
      const { configDir } = await loadConfig(opts.config);

      // List all reports
      if (!reportId) {
        const reports = listReports(configDir);
        if (reports.length === 0) {
          process.stdout.write("\n  No reports found. Run `axis run` to generate one.\n\n");
          return;
        }

        const limit = parseInt(opts.limit, 10) || 10;
        const displayed = reports.slice(0, limit);

        if (opts.json) {
          process.stdout.write(JSON.stringify(displayed, null, 2) + "\n");
        } else {
          process.stdout.write(renderReportList(displayed));
          if (reports.length > limit) {
            process.stdout.write(`  ... and ${reports.length - limit} more\n\n`);
          }
        }
        return;
      }

      // View a specific scenario result
      if (scenarioKey) {
        const agentFilter: string[] | undefined = opts.agent?.map((a: string) => a.toLowerCase());

        // Read all agents, then filter if --agent was specified
        let results = readScenarioResults(configDir, reportId, scenarioKey);
        if (agentFilter?.length) {
          results = results.filter((r) => agentFilter.includes(r.agentName));
        }

        if (results.length === 0) {
          const filterMsg = agentFilter?.length ? ` (agent: ${agentFilter.join(", ")})` : "";
          process.stderr.write(`\n  Scenario "${scenarioKey}"${filterMsg} not found in report "${reportId}".\n\n`);
          process.exit(1);
        }

        if (opts.json) {
          const jsonOut = results.length === 1 ? results[0] : results;
          process.stdout.write(JSON.stringify(jsonOut, null, 2) + "\n");
        } else {
          for (const result of results) {
            process.stdout.write(renderScenarioDetail(result));
          }
        }
        return;
      }

      // View a single report summary
      const report = readReport(configDir, reportId);
      if (!report) {
        process.stderr.write(`\n  Report "${reportId}" not found.\n\n`);
        process.exit(1);
      }

      if (opts.html) {
        const { generateReportHtml } = await import("./reports/html.js");
        const { getReportsDir } = await import("./reports/writer.js");

        const reportsDir = getReportsDir(configDir);
        const htmlPath = path.join(reportsDir, report.reportId, "report.html");
        fs.writeFileSync(htmlPath, generateReportHtml(report));

        const { exec } = await import("node:child_process");
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${openCmd} "${htmlPath}"`);

        process.stdout.write(`\n  Report opened in browser: ${htmlPath}\n\n`);
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(renderReportDetail(report));
      }
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

// --- Baseline comparison helper ---

function runBaselineComparison(configDir: string, baselineName: string, reportId: string, json: boolean): number {
  try {
    const baseline = readBaseline(configDir, baselineName);
    if (!baseline) {
      process.stderr.write(`\n  Baseline "${baselineName}" not found.\n\n`);
      return 1;
    }

    const report = readReport(configDir, reportId);
    if (!report) {
      process.stderr.write(`\n  Report "${reportId}" not found.\n\n`);
      return 1;
    }

    const diff = compareBaseline(baseline, report);

    if (json) {
      process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
    } else {
      process.stdout.write(renderBaselineComparison(diff));
    }

    return diff.summary.regressed > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
    return 1;
  }
}

// --- axis baseline command ---

const baselineCmd = program.command("baseline").description("Manage baselines for regression detection");

baselineCmd
  .command("set [name]")
  .description(
    `Create or update a baseline from the latest (or specific) report (default name: "${DEFAULT_BASELINE_NAME}")`,
  )
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .option("--from <reportId>", "use a specific report instead of latest")
  .action(async (name: string | undefined, opts) => {
    try {
      const baselineName = name ?? DEFAULT_BASELINE_NAME;
      const { configDir } = await loadConfig(opts.config);
      const report = readReport(configDir, opts.from ?? "latest");

      if (!report) {
        process.stderr.write(
          opts.from ? `\n  Report "${opts.from}" not found.\n\n` : `\n  No reports found. Run \`axis run\` first.\n\n`,
        );
        process.exit(1);
      }

      const baseline = setBaseline(configDir, report, baselineName);
      const scenarioCount = Object.keys(baseline.results).length;
      const agentSet = new Set<string>();
      for (const agents of Object.values(baseline.results)) {
        for (const agent of Object.keys(agents)) agentSet.add(agent);
      }

      process.stdout.write(
        `\n  Baseline "${baselineName}" updated — ${scenarioCount} scenario(s), ${agentSet.size} agent(s)\n` +
          `  Source: report ${report.reportId}\n\n`,
      );
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

baselineCmd
  .command("list")
  .description("List all baselines")
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .action(async (opts) => {
    try {
      const { configDir } = await loadConfig(opts.config);
      const baselines = listBaselines(configDir);

      if (baselines.length === 0) {
        process.stdout.write("\n  No baselines found. Use `axis baseline set` to create one.\n\n");
        return;
      }

      process.stdout.write(renderBaselineList(baselines));
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

baselineCmd
  .command("show [name]")
  .description(`Show baseline contents (default name: "${DEFAULT_BASELINE_NAME}")`)
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .option("--json", "output as JSON", false)
  .action(async (name: string | undefined, opts) => {
    try {
      const baselineName = name ?? DEFAULT_BASELINE_NAME;
      const { configDir } = await loadConfig(opts.config);
      const baseline = readBaseline(configDir, baselineName);

      if (!baseline) {
        process.stderr.write(`\n  Baseline "${baselineName}" not found.\n\n`);
        process.exit(1);
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(baseline, null, 2) + "\n");
      } else {
        process.stdout.write(renderBaselineShow(baseline));
      }
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

baselineCmd
  .command("compare [name]")
  .description(`Compare a report against a baseline (default name: "${DEFAULT_BASELINE_NAME}")`)
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .option("--report <reportId>", "compare a specific report instead of latest")
  .option("--json", "output as JSON", false)
  .action(async (name: string | undefined, opts) => {
    try {
      const baselineName = name ?? DEFAULT_BASELINE_NAME;
      const { configDir } = await loadConfig(opts.config);
      const baseline = readBaseline(configDir, baselineName);

      if (!baseline) {
        process.stderr.write(`\n  Baseline "${baselineName}" not found.\n\n`);
        process.exit(1);
      }

      const report = readReport(configDir, opts.report ?? "latest");
      if (!report) {
        process.stderr.write(
          opts.report
            ? `\n  Report "${opts.report}" not found.\n\n`
            : `\n  No reports found. Run \`axis run\` first.\n\n`,
        );
        process.exit(1);
      }

      const diff = compareBaseline(baseline, report);

      if (opts.json) {
        process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
      } else {
        process.stdout.write(renderBaselineComparison(diff));
      }

      if (diff.summary.regressed > 0) process.exit(1);
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

baselineCmd
  .command("delete [name]")
  .description(`Delete a baseline (default name: "${DEFAULT_BASELINE_NAME}")`)
  .option("-c, --config <path>", "path to axis.config file (.ts, .js, .mjs, .json)")
  .action(async (name: string | undefined, opts) => {
    try {
      const baselineName = name ?? DEFAULT_BASELINE_NAME;
      const { configDir } = await loadConfig(opts.config);
      const deleted = deleteBaseline(configDir, baselineName);

      if (deleted) {
        process.stdout.write(`\n  Baseline "${baselineName}" deleted.\n\n`);
      } else {
        process.stderr.write(`\n  Baseline "${baselineName}" not found.\n\n`);
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`\n  Error: ${formatError(err)}\n\n`);
      process.exit(1);
    }
  });

program.parse();

// --- Legacy report file writing (for --output-dir) ---

function writeReportFile(output: RunOutput, outputDir: string): string {
  const resolvedDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const timestamp = output.timestamp.replace(/[:.]/g, "-");
  const filename = `axis-report-${timestamp}.json`;
  const filePath = path.join(resolvedDir, filename);

  const fd = fs.openSync(filePath, "w");
  fs.writeSync(fd, JSON.stringify(output, null, 2));
  fs.closeSync(fd);

  return filePath;
}
