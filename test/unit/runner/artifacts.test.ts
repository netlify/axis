import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  captureArtifacts,
  globToRegExp,
  inferMimeType,
  resolveArtifactPatterns,
} from "../../../src/runner/artifacts.js";
import type { AxisConfig } from "../../../src/types/config.js";
import type { Scenario } from "../../../src/types/scenario.js";

describe("globToRegExp", () => {
  it("matches literal paths", () => {
    expect(globToRegExp("foo.txt").test("foo.txt")).toBe(true);
    expect(globToRegExp("foo.txt").test("foo.txtx")).toBe(false);
  });

  it("supports * (single segment)", () => {
    const re = globToRegExp("*.log");
    expect(re.test("a.log")).toBe(true);
    expect(re.test("nested/a.log")).toBe(false);
  });

  it("supports ** (any depth)", () => {
    const re = globToRegExp("**/*.json");
    expect(re.test("a.json")).toBe(true);
    expect(re.test("dir/a.json")).toBe(true);
    expect(re.test("dir/sub/a.json")).toBe(true);
    expect(re.test("a.txt")).toBe(false);
  });

  it("supports prefix/**", () => {
    const re = globToRegExp("dist/**");
    expect(re.test("dist/a")).toBe(true);
    expect(re.test("dist/sub/a")).toBe(true);
    expect(re.test("other/a")).toBe(false);
  });

  it("escapes regex specials", () => {
    const re = globToRegExp("path.with+special$.txt");
    expect(re.test("path.with+special$.txt")).toBe(true);
    expect(re.test("pathXwith+special$.txt")).toBe(false);
  });

  it("supports character classes", () => {
    const re = globToRegExp("file[0-9].txt");
    expect(re.test("file3.txt")).toBe(true);
    expect(re.test("fileA.txt")).toBe(false);
  });

  it("strips leading ./", () => {
    const re = globToRegExp("./foo/bar.txt");
    expect(re.test("foo/bar.txt")).toBe(true);
  });
});

describe("inferMimeType", () => {
  it("maps common text extensions", () => {
    expect(inferMimeType("a.txt")).toBe("text/plain");
    expect(inferMimeType("a.log")).toBe("text/plain");
    expect(inferMimeType("a.md")).toBe("text/markdown");
    expect(inferMimeType("a.json")).toBe("application/json");
  });

  it("maps image extensions", () => {
    expect(inferMimeType("a.png")).toBe("image/png");
    expect(inferMimeType("a.JPG")).toBe("image/jpeg");
    expect(inferMimeType("a.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream", () => {
    expect(inferMimeType("a.unknownext")).toBe("application/octet-stream");
    expect(inferMimeType("noext")).toBe("application/octet-stream");
  });
});

describe("resolveArtifactPatterns", () => {
  it("merges config and scenario patterns, preserving order", () => {
    const cfg = { artifacts: ["*.log", "dist/**"] } as AxisConfig;
    const scenario = { artifacts: ["screenshot.png", "dist/**"] } as Scenario;
    expect(resolveArtifactPatterns(cfg, scenario)).toEqual(["*.log", "dist/**", "screenshot.png"]);
  });

  it("handles missing fields", () => {
    expect(resolveArtifactPatterns({} as AxisConfig, {} as Scenario)).toEqual([]);
    expect(resolveArtifactPatterns({ artifacts: ["a"] } as AxisConfig, {} as Scenario)).toEqual(["a"]);
    expect(resolveArtifactPatterns({} as AxisConfig, { artifacts: ["a"] } as Scenario)).toEqual(["a"]);
  });

  it("ignores empty/non-string entries", () => {
    const cfg = { artifacts: ["", "*.log", null as unknown as string] } as AxisConfig;
    expect(resolveArtifactPatterns(cfg, {} as Scenario)).toEqual(["*.log"]);
  });
});

describe("captureArtifacts", () => {
  let workspace: string;
  let dest: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "axis-art-test-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "axis-art-dest-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("captures matching files and copies them to dest", () => {
    fs.writeFileSync(path.join(workspace, "out.log"), "hello");
    fs.writeFileSync(path.join(workspace, "ignore.txt"), "skip");
    fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "dist", "bundle.js"), "code");

    const entries = captureArtifacts(workspace, ["*.log", "dist/**"], dest);

    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["dist/bundle.js", "out.log"]);

    expect(fs.existsSync(path.join(dest, "out.log"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "dist", "bundle.js"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "ignore.txt"))).toBe(false);
  });

  it("populates size, mimeType, and base64 content", () => {
    fs.writeFileSync(path.join(workspace, "data.json"), '{"k":1}');

    const [entry] = captureArtifacts(workspace, ["*.json"], dest);

    expect(entry.path).toBe("data.json");
    expect(entry.size).toBe(7);
    expect(entry.mimeType).toBe("application/json");
    expect(Buffer.from(entry.content, "base64").toString("utf8")).toBe('{"k":1}');
  });

  it("returns empty when no patterns are provided", () => {
    fs.writeFileSync(path.join(workspace, "out.log"), "hello");
    expect(captureArtifacts(workspace, [], dest)).toEqual([]);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("returns empty when no files match", () => {
    fs.writeFileSync(path.join(workspace, "out.txt"), "hello");
    expect(captureArtifacts(workspace, ["*.log"], dest)).toEqual([]);
  });

  it("returns empty when workspace does not exist", () => {
    fs.rmSync(workspace, { recursive: true, force: true });
    expect(captureArtifacts(workspace, ["*"], dest)).toEqual([]);
  });

  it("handles binary files with base64 round-trip", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(workspace, "img.png"), png);

    const [entry] = captureArtifacts(workspace, ["*.png"], dest);

    expect(entry.mimeType).toBe("image/png");
    expect(Buffer.from(entry.content, "base64").equals(png)).toBe(true);
  });

  it("captures nested files via **", () => {
    fs.mkdirSync(path.join(workspace, "a", "b", "c"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "a", "b", "c", "deep.log"), "x");

    const entries = captureArtifacts(workspace, ["**/*.log"], dest);

    expect(entries.map((e) => e.path)).toEqual(["a/b/c/deep.log"]);
    expect(fs.existsSync(path.join(dest, "a", "b", "c", "deep.log"))).toBe(true);
  });

  it("returns deterministic ordering across runs", () => {
    fs.writeFileSync(path.join(workspace, "z.log"), "z");
    fs.writeFileSync(path.join(workspace, "a.log"), "a");
    fs.writeFileSync(path.join(workspace, "m.log"), "m");

    const paths = captureArtifacts(workspace, ["*.log"], dest).map((e) => e.path);
    expect(paths).toEqual(["a.log", "m.log", "z.log"]);
  });
});
