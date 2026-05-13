import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { executeLifecycleActions, runLifecyclePhase } from "../../../src/runner/lifecycle.js";

describe("executeLifecycleActions", () => {
  it("runs a simple echo command", async () => {
    const results = await executeLifecycleActions([{ action: "run_script", command: "echo hello" }], process.cwd());

    expect(results).toHaveLength(1);
    expect(results[0].exitCode).toBe(0);
    expect(results[0].stdout.trim()).toBe("hello");
  });

  it("runs multiple actions sequentially", async () => {
    const results = await executeLifecycleActions(
      [
        { action: "run_script", command: "echo first" },
        { action: "run_script", command: "echo second" },
      ],
      process.cwd(),
    );

    expect(results).toHaveLength(2);
    expect(results[0].stdout.trim()).toBe("first");
    expect(results[1].stdout.trim()).toBe("second");
  });

  it("throws on non-zero exit code", async () => {
    await expect(executeLifecycleActions([{ action: "run_script", command: "exit 1" }], process.cwd())).rejects.toThrow(
      "exited with code 1",
    );
  });

  it("stops on first failure", async () => {
    await expect(
      executeLifecycleActions(
        [
          { action: "run_script", command: "exit 1" },
          { action: "run_script", command: "echo should-not-run" },
        ],
        process.cwd(),
      ),
    ).rejects.toThrow("exited with code 1");
  });

  it("reports duration", async () => {
    const results = await executeLifecycleActions([{ action: "run_script", command: "echo fast" }], process.cwd());

    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses the provided cwd", async () => {
    const results = await executeLifecycleActions([{ action: "run_script", command: "pwd" }], "/tmp");

    // /tmp may resolve to /private/tmp on macOS
    expect(results[0].stdout.trim()).toMatch(/\/tmp$/);
  });
});

describe("runLifecyclePhase", () => {
  it("captures markdown written to $AXIS_OUTPUT", async () => {
    const outcome = await runLifecyclePhase(
      [{ action: "run_script", command: 'printf "# hello\\n\\nworld" > "$AXIS_OUTPUT"' }],
      "/tmp",
      undefined,
      "setup",
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.output).toBe("# hello\n\nworld");
  });

  it("shares the output file across multiple actions in the phase", async () => {
    const outcome = await runLifecyclePhase(
      [
        { action: "run_script", command: 'echo "first" >> "$AXIS_OUTPUT"' },
        { action: "run_script", command: 'echo "second" >> "$AXIS_OUTPUT"' },
      ],
      "/tmp",
      undefined,
      "setup",
    );

    expect(outcome.output).toBe("first\nsecond");
  });

  it("returns undefined output when nothing was written", async () => {
    const outcome = await runLifecyclePhase(
      [{ action: "run_script", command: "echo no-output" }],
      "/tmp",
      undefined,
      "setup",
    );

    expect(outcome.output).toBeUndefined();
  });

  it("captures partial output even when an action fails", async () => {
    const outcome = await runLifecyclePhase(
      [
        { action: "run_script", command: 'echo "before-fail" >> "$AXIS_OUTPUT"' },
        { action: "run_script", command: "exit 1" },
        { action: "run_script", command: 'echo "after-fail" >> "$AXIS_OUTPUT"' },
      ],
      "/tmp",
      undefined,
      "teardown",
    );

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.output).toBe("before-fail");
  });

  it("exposes AXIS_WORKSPACE and AXIS_PHASE to scripts", async () => {
    const outcome = await runLifecyclePhase(
      [{ action: "run_script", command: 'printf "%s\\n%s" "$AXIS_PHASE" "$AXIS_WORKSPACE" > "$AXIS_OUTPUT"' }],
      "/tmp",
      undefined,
      "teardown",
    );

    expect(outcome.output?.split("\n")[0]).toBe("teardown");
    expect(outcome.output?.split("\n")[1]).toMatch(/\/tmp$/);
  });

  it("exposes AXIS_AGENT, AXIS_SCENARIO, AXIS_MODEL, AXIS_VARIANT when context provided", async () => {
    const outcome = await runLifecyclePhase(
      [
        {
          action: "run_script",
          command: 'printf "%s|%s|%s|%s" "$AXIS_AGENT" "$AXIS_SCENARIO" "$AXIS_MODEL" "$AXIS_VARIANT" > "$AXIS_OUTPUT"',
        },
      ],
      "/tmp",
      undefined,
      "setup",
      {
        agent: "claude-code",
        model: "claude-sonnet-4-6",
        scenario: "build-shop@fast",
        variant: "fast",
      },
    );

    expect(outcome.output).toBe("claude-code|build-shop@fast|claude-sonnet-4-6|fast");
  });

  it("omits AXIS_MODEL and AXIS_VARIANT when not in context", async () => {
    const outcome = await runLifecyclePhase(
      [
        {
          action: "run_script",
          command:
            'printf "agent=%s scenario=%s model=[%s] variant=[%s]" "$AXIS_AGENT" "$AXIS_SCENARIO" "${AXIS_MODEL-unset}" "${AXIS_VARIANT-unset}" > "$AXIS_OUTPUT"',
        },
      ],
      "/tmp",
      undefined,
      "setup",
      {
        agent: "codex",
        scenario: "echo-test",
      },
    );

    expect(outcome.output).toBe("agent=codex scenario=echo-test model=[unset] variant=[unset]");
  });

  it("does not set AXIS_AGENT when no context is provided", async () => {
    const outcome = await runLifecyclePhase(
      [{ action: "run_script", command: 'printf "[%s]" "${AXIS_AGENT-unset}" > "$AXIS_OUTPUT"' }],
      "/tmp",
      undefined,
      "setup",
    );

    expect(outcome.output).toBe("[unset]");
  });
});

describe("copy lifecycle action", () => {
  let sourceRoot: string;
  let workspace: string;

  beforeEach(() => {
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axis-copy-src-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "axis-copy-ws-"));
  });

  afterEach(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("copies files matched by a single-star glob into destination relative to cwd", async () => {
    fs.mkdirSync(path.join(sourceRoot, "fixture", "thing"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "fixture", "thing", "a.txt"), "alpha");
    fs.writeFileSync(path.join(sourceRoot, "fixture", "thing", "b.txt"), "beta");
    // Should not be matched by a single-star glob (lives in a subdir).
    fs.mkdirSync(path.join(sourceRoot, "fixture", "thing", "nested"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "fixture", "thing", "nested", "c.txt"), "gamma");

    const results = await executeLifecycleActions(
      [{ action: "copy", match: "./fixture/thing/*", destination: "./this/dir" }],
      workspace,
      undefined,
      { sourceRoot },
    );

    expect(results[0].exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "this", "dir", "a.txt"), "utf8")).toBe("alpha");
    expect(fs.readFileSync(path.join(workspace, "this", "dir", "b.txt"), "utf8")).toBe("beta");
    expect(fs.existsSync(path.join(workspace, "this", "dir", "nested"))).toBe(false);
  });

  it("preserves directory structure for ** globs relative to the longest non-glob prefix", async () => {
    fs.mkdirSync(path.join(sourceRoot, "fixture", "a"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "fixture", "b", "c"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "fixture", "a", "1.txt"), "1");
    fs.writeFileSync(path.join(sourceRoot, "fixture", "b", "c", "2.txt"), "2");
    fs.writeFileSync(path.join(sourceRoot, "fixture", "skip.md"), "md");

    await executeLifecycleActions(
      [{ action: "copy", match: "./fixture/**/*.txt", destination: "out" }],
      workspace,
      undefined,
      { sourceRoot },
    );

    expect(fs.readFileSync(path.join(workspace, "out", "a", "1.txt"), "utf8")).toBe("1");
    expect(fs.readFileSync(path.join(workspace, "out", "b", "c", "2.txt"), "utf8")).toBe("2");
    expect(fs.existsSync(path.join(workspace, "out", "skip.md"))).toBe(false);
  });

  it("logs resolved paths via the logger when debug is true", async () => {
    fs.mkdirSync(path.join(sourceRoot, "f"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "f", "x.txt"), "x");

    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), error: () => {} };

    await executeLifecycleActions(
      [{ action: "copy", match: "./f/*", destination: "./dst" }],
      workspace,
      undefined,
      { sourceRoot, debug: true, logger },
    );

    const joined = lines.join("\n");
    expect(joined).toContain("[copy] pattern=./f/*");
    expect(joined).toContain(`resolved source base=${path.join(sourceRoot, "f")}`);
    expect(joined).toContain(`resolved destination=${path.join(workspace, "dst")}`);
    expect(joined).toContain("-> ");
    expect(joined).toContain("copied 1 file(s)");
  });

  it("does not log to the logger when debug is false", async () => {
    fs.mkdirSync(path.join(sourceRoot, "f"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "f", "x.txt"), "x");

    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), error: () => {} };

    const results = await executeLifecycleActions(
      [{ action: "copy", match: "./f/*", destination: "./dst" }],
      workspace,
      undefined,
      { sourceRoot, debug: false, logger },
    );

    expect(lines).toHaveLength(0);
    expect(results[0].stdout).toBe("");
    expect(fs.existsSync(path.join(workspace, "dst", "x.txt"))).toBe(true);
  });

  it("succeeds with zero matches when the glob base is missing", async () => {
    const results = await executeLifecycleActions(
      [{ action: "copy", match: "./missing/*", destination: "./out" }],
      workspace,
      undefined,
      { sourceRoot },
    );

    expect(results[0].exitCode).toBe(0);
    expect(fs.existsSync(path.join(workspace, "out"))).toBe(false);
  });

  it("fails when match resolves to a missing path and reports the source in stderr", async () => {
    await expect(
      executeLifecycleActions(
        [{ action: "copy", match: "./nope/file.txt", destination: "./out" }],
        workspace,
        undefined,
        { sourceRoot },
      ),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("copies a single literal file when match has no glob characters", async () => {
    fs.writeFileSync(path.join(sourceRoot, "single.txt"), "only");

    await executeLifecycleActions(
      [{ action: "copy", match: "./single.txt", destination: "./out" }],
      workspace,
      undefined,
      { sourceRoot },
    );

    expect(fs.readFileSync(path.join(workspace, "out", "single.txt"), "utf8")).toBe("only");
  });

  it("defaults sourceRoot to cwd when not provided", async () => {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "x.txt"), "x");

    await executeLifecycleActions(
      [{ action: "copy", match: "./src/*", destination: "./out" }],
      workspace,
    );

    expect(fs.readFileSync(path.join(workspace, "out", "x.txt"), "utf8")).toBe("x");
  });
});
