import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_SRC = path.join(REPO_ROOT, "src/cli.ts");
// jiti's CLI is not in its `exports` map, so resolve it through package.json
// rather than hardcoding a path that a version bump could move.
const JITI_PKG = require.resolve("jiti/package.json");
const JITI_BIN = path.join(path.dirname(JITI_PKG), JSON.parse(fs.readFileSync(JITI_PKG, "utf-8")).bin.jiti);
const ECHO_ADAPTER = path.join(REPO_ROOT, "test/e2e/adapters/custom/echo-adapter.ts");

/**
 * Run the CLI from source through jiti, so these cover the real argv wiring
 * without depending on `dist/` (CI runs the suite against src/ and never
 * builds). Returns the exit code rather than throwing, since most cases here
 * are expected to fail.
 */
async function axis(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [JITI_BIN, CLI_SRC, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

let tmpDir: string;

/** Write a prior report manifest so `--failed` has something to read. */
function writeReport(reportId: string, entries: Array<{ scenarioKey: string; agentName: string; failed: boolean }>) {
  const dir = path.join(tmpDir, ".axis/reports", reportId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "report.json"),
    JSON.stringify({
      version: "1.0.0",
      reportId,
      timestamp: "2026-09-29T10:00:00.000Z",
      durationMs: 1,
      summary: { total: entries.length, completed: 0, failed: entries.length },
      results: entries.map((e) => ({
        scenarioKey: e.scenarioKey,
        scenarioName: e.scenarioKey,
        agentName: e.agentName,
        durationMs: 1,
        exitCode: e.failed ? 1 : 0,
        failed: e.failed,
        file: `scenarios/${e.scenarioKey}/${e.agentName}.json`,
      })),
    }),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-failed-cli-"));
  fs.mkdirSync(path.join(tmpDir, "scenarios"));
  for (const key of ["create-one", "ask-one"]) {
    fs.writeFileSync(
      path.join(tmpDir, "scenarios", `${key}.json`),
      JSON.stringify({ name: key, prompt: key, judge: "echoes" }),
    );
  }
  fs.writeFileSync(
    path.join(tmpDir, "axis.config.json"),
    JSON.stringify({
      adapters: { echo: ECHO_ADAPTER },
      scenarios: "./scenarios",
      exclude: ["ask-*"],
      agents: [{ agent: "echo" }],
      profiles: {
        create: {},
        ask: { include: ["ask-*"], agents: [{ agent: "echo", model: "ask-model" }] },
      },
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("axis run --failed with --profile", () => {
  it("retries the profile's own failed pairs", async () => {
    writeReport("2026-09-29-100000", [{ scenarioKey: "ask-one", agentName: "echo|ask-model", failed: true }]);

    const { stdout, code } = await axis(tmpDir, [
      "run",
      "--failed",
      "latest",
      "--profile",
      "ask",
      "--no-score",
      "--json",
    ]);

    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.results.map((r: { scenarioKey: string; agentName: string }) => [r.scenarioKey, r.agentName])).toEqual([
      ["ask-one", "echo|ask-model"],
    ]);
  }, 60_000);

  it("allows --profile alongside --failed", async () => {
    writeReport("2026-09-29-100000", [{ scenarioKey: "ask-one", agentName: "echo|ask-model", failed: true }]);

    const { stderr } = await axis(tmpDir, ["run", "--failed", "--profile", "ask", "--no-score", "--json"]);

    // The mutual-exclusion guard covers --scenario and --agent only. If a
    // future edit folds --profile into it, this catches the regression.
    expect(stderr).not.toContain("cannot be combined");
  }, 60_000);

  it("validates the profile name before reading the report", async () => {
    // No report on disk at all: the profile error must still win, so a typo in
    // CI does not surface as a missing report.
    const { stderr, code } = await axis(tmpDir, ["run", "--failed", "--profile", "asks", "--no-score"]);

    expect(code).not.toBe(0);
    expect(stderr).toContain('Unknown profile "asks"');
    expect(stderr).not.toContain("not found");
  }, 60_000);

  it("still rejects --failed combined with --scenario or --agent", async () => {
    writeReport("2026-09-29-100000", [{ scenarioKey: "ask-one", agentName: "echo|ask-model", failed: true }]);

    const withScenario = await axis(tmpDir, ["run", "--failed", "-s", "ask-one", "--no-score"]);
    expect(withScenario.code).not.toBe(0);
    expect(withScenario.stderr).toContain("cannot be combined");

    const withAgent = await axis(tmpDir, ["run", "--failed", "-a", "echo", "--no-score"]);
    expect(withAgent.code).not.toBe(0);
    expect(withAgent.stderr).toContain("cannot be combined");
  }, 60_000);

  it("skips the run when the report has no failures", async () => {
    writeReport("2026-09-29-100000", [{ scenarioKey: "create-one", agentName: "echo", failed: false }]);

    const { stderr, code } = await axis(tmpDir, ["run", "--failed", "--no-score"]);

    expect(code).toBe(0);
    expect(stderr).toContain("No failed jobs");
  }, 60_000);

  it("exits non-zero when the retried pairs belong to another suite", async () => {
    // A report from the default run, retried under --profile ask: the pairs are
    // real but address a scenario and an agent the ask suite does not have.
    writeReport("2026-09-29-100000", [{ scenarioKey: "create-one", agentName: "echo", failed: true }]);

    const { stderr, code } = await axis(tmpDir, ["run", "--failed", "--profile", "ask", "--no-score"]);

    // Must not read as a clean pass over zero jobs.
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no (jobs|scenarios)/i);
  }, 60_000);
});
