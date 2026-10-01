import { describe, it, expect } from "vitest";
import {
  artifactsPath,
  isMultiRun,
  pairDir,
  parseRunDirName,
  resultPath,
  runSiblingPath,
  scenarioDir,
} from "../../../src/reports/paths.js";

describe("isMultiRun", () => {
  it("treats an absent or single run count as the single-run layout", () => {
    expect(isMultiRun(undefined)).toBe(false);
    expect(isMultiRun(1)).toBe(false);
  });

  it("switches layout above one run", () => {
    expect(isMultiRun(2)).toBe(true);
  });
});

describe("single-run layout", () => {
  const ref = { scenarioKey: "cms/create-post", agentName: "claude-code|opus" };

  it("keeps the pre-multi-run result path so old reports stay readable", () => {
    expect(resultPath(ref)).toBe("scenarios/cms/create-post/claude-code|opus.json");
  });

  it("keeps dot-joined sibling names", () => {
    expect(runSiblingPath(ref, "raw.ndjson")).toBe("scenarios/cms/create-post/claude-code|opus.raw.ndjson");
    expect(runSiblingPath(ref, "sparse-index.txt")).toBe("scenarios/cms/create-post/claude-code|opus.sparse-index.txt");
  });

  it("keeps artifacts in the agent directory alongside the result file", () => {
    expect(artifactsPath(ref)).toBe("scenarios/cms/create-post/claude-code|opus/artifacts");
  });

  it("ignores a run index it was given without a run count", () => {
    expect(resultPath({ ...ref, runIndex: 2 })).toBe("scenarios/cms/create-post/claude-code|opus.json");
  });
});

describe("multi-run layout", () => {
  const ref = { scenarioKey: "cms/create-post", agentName: "claude-code|opus", runIndex: 2, runCount: 3 };

  it("nests each run under its own directory", () => {
    expect(resultPath(ref)).toBe("scenarios/cms/create-post/claude-code|opus/run-2/result.json");
  });

  it("puts sibling files inside the run directory", () => {
    expect(runSiblingPath(ref, "raw.ndjson")).toBe("scenarios/cms/create-post/claude-code|opus/run-2/raw.ndjson");
    expect(runSiblingPath(ref, "debug.stderr.log")).toBe(
      "scenarios/cms/create-post/claude-code|opus/run-2/debug.stderr.log",
    );
  });

  it("gives each run its own artifacts directory", () => {
    expect(artifactsPath(ref)).toBe("scenarios/cms/create-post/claude-code|opus/run-2/artifacts");
  });

  it("defaults a missing run index to 1", () => {
    expect(resultPath({ ...ref, runIndex: undefined })).toBe(
      "scenarios/cms/create-post/claude-code|opus/run-1/result.json",
    );
  });

  it("keeps variant keys distinct", () => {
    expect(resultPath({ ...ref, scenarioKey: "cms/create-post@fast" })).toBe(
      "scenarios/cms/create-post@fast/claude-code|opus/run-2/result.json",
    );
  });
});

describe("directory helpers", () => {
  it("names the pair and scenario directories", () => {
    expect(pairDir("s1", "a1")).toBe("scenarios/s1/a1");
    expect(scenarioDir("s1")).toBe("scenarios/s1");
  });
});

describe("parseRunDirName", () => {
  it("parses a run directory name", () => {
    expect(parseRunDirName("run-1")).toBe(1);
    expect(parseRunDirName("run-12")).toBe(12);
  });

  it("rejects anything that is not a run directory", () => {
    expect(parseRunDirName("artifacts")).toBeNull();
    expect(parseRunDirName("run-0")).toBeNull();
    expect(parseRunDirName("run-")).toBeNull();
    expect(parseRunDirName("run-x")).toBeNull();
    expect(parseRunDirName("prerun-1")).toBeNull();
  });
});
