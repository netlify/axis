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
const JITI_PKG = require.resolve("jiti/package.json");
const JITI_BIN = path.join(path.dirname(JITI_PKG), JSON.parse(fs.readFileSync(JITI_PKG, "utf-8")).bin.jiti);
const ECHO_ADAPTER = path.join(REPO_ROOT, "test/e2e/adapters/custom/echo-adapter.ts");

/**
 * Run the CLI from source through jiti, so these cover the real argv wiring
 * (commander included) rather than a stand-in for it.
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-alias-"));
  fs.mkdirSync(path.join(tmpDir, "scenarios"));
  for (const key of ["alpha", "beta"]) {
    fs.writeFileSync(
      path.join(tmpDir, "scenarios", `${key}.json`),
      JSON.stringify({ name: key, prompt: "hi", judge: "it said hi" }),
    );
  }
  fs.writeFileSync(
    path.join(tmpDir, "axis.config.json"),
    JSON.stringify({
      adapters: { echo: ECHO_ADAPTER },
      scenarios: "./scenarios",
      agents: [{ agent: "echo" }],
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("plural option aliases on axis run", () => {
  it("accepts --scenarios in place of --scenario", async () => {
    const { stderr, code } = await axis(tmpDir, ["run", "--no-score", "--scenarios", "alpha"]);

    expect(stderr).not.toContain("unknown option");
    expect(stderr).toContain("Discovered 1 scenario");
    expect(code).toBe(0);
  });

  it("accepts --scenarios=value", async () => {
    const { stderr, code } = await axis(tmpDir, ["run", "--no-score", "--scenarios=alpha"]);

    expect(stderr).toContain("Discovered 1 scenario");
    expect(code).toBe(0);
  });

  it("accepts --agents in place of --agent", async () => {
    const { stderr, code } = await axis(tmpDir, ["run", "--no-score", "--agents", "echo"]);

    expect(stderr).not.toContain("unknown option");
    expect(stderr).toContain("across 1 agent");
    expect(code).toBe(0);
  });

  it("filters identically whichever spelling is used", async () => {
    const plural = await axis(tmpDir, ["run", "--no-score", "--scenarios", "alpha"]);
    const singular = await axis(tmpDir, ["run", "--no-score", "--scenario", "alpha"]);

    const discovered = (out: string) =>
      out
        .split("\n")
        .find((l) => l.includes("Discovered"))
        ?.trim();
    expect(discovered(plural.stderr)).toBe(discovered(singular.stderr));
  });

  it("still rejects a genuinely unknown option", async () => {
    const { stderr, code } = await axis(tmpDir, ["run", "--scenariosss", "alpha"]);

    expect(stderr).toContain("unknown option");
    expect(code).not.toBe(0);
  });

  it("leaves the plural spelling alone after a bare --", async () => {
    // `--` marks the end of options, so anything past it is positional and must
    // not be rewritten.
    const { stderr } = await axis(tmpDir, ["run", "--no-score", "--", "--scenarios"]);

    expect(stderr).not.toContain("Discovered 1 scenario");
  });
});

describe("axis init keeps its own --scenarios option", () => {
  it("treats --scenarios as the scenarios directory, not a filter", async () => {
    // `init --scenarios` predates the alias and means something entirely
    // different. Aliasing it to `--scenario` would silently break it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-init-"));
    try {
      const { code } = await axis(dir, ["init", "--scenarios", "./custom-scenarios", "--no-skills"]);

      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, "custom-scenarios", "hello-world.json"))).toBe(true);
      const config = JSON.parse(fs.readFileSync(path.join(dir, "axis.config.json"), "utf-8"));
      expect(config.scenarios).toBe("./custom-scenarios");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
