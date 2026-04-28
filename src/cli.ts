#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { run } from "./runner/runner.js";
import { loadConfig } from "./config/loader.js";
import { scoreRunResult, buildScoredOutput } from "./scoring/index.js";
import { writeReportToStore } from "./reports/writer.js";
import { listReports, readReport, readScenarioResults } from "./reports/reader.js";
import { setBaseline, readBaseline, listBaselines, deleteBaseline, DEFAULT_BASELINE_NAME } from "./baselines/store.js";
import { diffBaseline } from "./baselines/diff.js";
import {
  renderReportList,
  renderReportDetail,
  renderScenarioDetail,
  renderBaselineList,
  renderBaselineShow,
  renderBaselineDiff,
} from "./ui/format.js";
import { formatError } from "./types/output.js";
import type { Logger, JobState, RunResult, RunOutput } from "./types/output.js";
import type { ScoredRunResult, ScoredOutput } from "./types/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program.name("axis").description("AXIS — Agent eXperience Index Score").version(pkg.version);

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

// --- Shared run pipeline ---

interface RunPipelineOptions {
  configPath: string;
  scenario?: string;
  agent?: string;
  concurrency?: number;
  score: boolean;
  verbose: boolean;
  debug: boolean;
  outputDir?: string;
  json: boolean;
  refreshSkills: boolean;
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

  const runOutput = await run({
    configPath: opts.configPath,
    scenarioFilter: opts.scenario ? [opts.scenario] : undefined,
    agentFilter: opts.agent ? [opts.agent] : undefined,
    concurrency,
    logger,
    registerCleanup,
    debug: opts.debug,
    refreshSkills: opts.refreshSkills,
    onResult: opts.score
      ? (result: RunResult): Promise<void> => {
          const scoring = scoreRunResult(result, {
            weights: config.settings?.scoring_weights,
            logger,
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
    output = buildScoredOutput(runOutput, scoredResults);
  } else {
    output = runOutput;
  }

  const reportId = writeReportToStore(output, configDir, config.name);

  if (opts.outputDir) {
    const reportPath = writeReportFile(output, opts.outputDir);
    logger.info(`Report written to ${reportPath}`);
  }

  return { output, reportId, configDir };
}

// --- axis run command ---

program
  .command("run")
  .description("Run scenarios against configured agents")
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
  .option("-s, --scenario <key>", "run a specific scenario by key (e.g. hello-world, cms/create-post)")
  .option("-a, --agent <name>", "run with a specific agent only")
  .option("--json", "output results as JSON to stdout", false)
  .option("-v, --verbose", "show detailed per-step logging", false)
  .option("-o, --output-dir <dir>", "also write axis-report-[timestamp].json to this directory")
  .option("--concurrency <n>", "max parallel jobs (default: unlimited)", parseInt)
  .option("--debug", "show debug output (workspace paths, env, lifecycle)", false)
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

    const pipelineOpts: RunPipelineOptions = {
      configPath: opts.config,
      scenario: opts.scenario,
      agent: opts.agent,
      concurrency: opts.concurrency,
      score: opts.score,
      verbose: opts.verbose,
      debug: opts.debug,
      outputDir: opts.outputDir,
      json: opts.json,
      refreshSkills: opts.refreshSkills,
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
    let onUpdate: ((jobs: JobState[]) => void) | undefined;
    let unmountInk: (() => void) | undefined;
    let lastJobs: JobState[] = [];

    const logger: Logger = {
      info: (msg) => process.stderr.write(`  ${msg}\n`),
      error: (msg) => process.stderr.write(`  ERROR: ${msg}\n`),
      verbose: opts.verbose || opts.debug ? (msg) => process.stderr.write(`  ${msg}\n`) : undefined,
      onJobUpdate: isTTY
        ? (jobs) => {
            lastJobs = jobs;
            onUpdate?.([...jobs]);
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
            subscribe: (cb: (jobs: JobState[]) => void) => {
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
            onUpdate?.([...lastJobs]);
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
            onUpdate?.([...lastJobs]);
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
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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
        const agentFilter: string[] | undefined = opts.agent;

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

    const diff = diffBaseline(baseline, report);

    if (json) {
      process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
    } else {
      process.stdout.write(renderBaselineDiff(diff));
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
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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
  .command("diff [name]")
  .description(`Compare the latest (or specific) report against a baseline (default name: "${DEFAULT_BASELINE_NAME}")`)
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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

      const diff = diffBaseline(baseline, report);

      if (opts.json) {
        process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
      } else {
        process.stdout.write(renderBaselineDiff(diff));
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
  .option("-c, --config <path>", "path to axis.config.json", "axis.config.json")
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
