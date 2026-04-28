import { describe, it, expect } from "vitest";
import { executeLifecycleActions } from "../../../src/runner/lifecycle.js";

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
