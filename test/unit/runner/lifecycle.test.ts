import { describe, it, expect } from "vitest";
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
});
