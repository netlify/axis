import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  collectGitCopySources,
  defaultRepoCacheRoot,
  ensureRepo,
  parseGitCopySource,
  repoCacheDirFor,
  resetRepoCache,
  setGitCloneImplForTests,
} from "../../../src/runner/repo-cache.js";
import type { GitCopySource } from "../../../src/runner/repo-cache.js";
import { silentLogger } from "../../../src/types/output.js";

let cacheRoot: string;
let restoreClone: (() => void) | undefined;

beforeEach(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axis-repo-cache-"));
  resetRepoCache();
});

afterEach(() => {
  restoreClone?.();
  restoreClone = undefined;
  resetRepoCache();
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

/** Stand-in for `git clone`: writes a marker file and a `.git/HEAD`. */
function stubClone(onClone?: (source: GitCopySource, targetDir: string) => void) {
  const calls: Array<{ url: string; ref?: string; targetDir: string }> = [];
  restoreClone = setGitCloneImplForTests(async (source, targetDir) => {
    calls.push({ url: source.url, ...(source.ref ? { ref: source.ref } : {}), targetDir });
    fs.mkdirSync(path.join(targetDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(targetDir, "README.md"), `# ${source.repo}\n`);
    onClone?.(source, targetDir);
  });
  return calls;
}

describe("parseGitCopySource", () => {
  it("returns null for local paths and globs", () => {
    expect(parseGitCopySource("./fixtures/app/**/*")).toBeNull();
    expect(parseGitCopySource("../fixtures/nextjsapp")).toBeNull();
    expect(parseGitCopySource("/abs/path/file.json")).toBeNull();
    expect(parseGitCopySource("fixtures/seed.json")).toBeNull();
    expect(parseGitCopySource("")).toBeNull();
  });

  it("parses an https repo url", () => {
    expect(parseGitCopySource("https://github.com/org/project")).toEqual({
      url: "https://github.com/org/project",
      host: "github.com",
      owner: "org",
      repo: "project",
    });
  });

  it("strips a trailing .git from the repo name but keeps it in the clone url", () => {
    const parsed = parseGitCopySource("https://github.com/org/project.git");
    expect(parsed?.url).toBe("https://github.com/org/project.git");
    expect(parsed?.repo).toBe("project");
  });

  it("parses git:// and ssh:// urls", () => {
    expect(parseGitCopySource("git://github.com/org/project")?.host).toBe("github.com");
    expect(parseGitCopySource("ssh://git@github.com/org/project")).toEqual({
      url: "ssh://git@github.com/org/project",
      host: "github.com",
      owner: "org",
      repo: "project",
    });
  });

  it("does not mistake a local path containing @ for scp-style shorthand", () => {
    expect(parseGitCopySource("fixtures/snapshot@2.0/app:v1/*")).toBeNull();
    expect(parseGitCopySource("./fixtures/user@host/file.txt")).toBeNull();
  });

  it("parses scp-style shorthand", () => {
    expect(parseGitCopySource("git@github.com:org/project.git")).toEqual({
      url: "git@github.com:org/project.git",
      host: "github.com",
      owner: "org",
      repo: "project",
    });
  });

  it("reads a ref from a #fragment", () => {
    expect(parseGitCopySource("https://github.com/org/project#v1.2.3")?.ref).toBe("v1.2.3");
    expect(parseGitCopySource("git@github.com:org/project.git#main")?.ref).toBe("main");
  });

  it("reads ref and subpath from a pasted GitHub tree url", () => {
    expect(parseGitCopySource("https://github.com/org/project/tree/main/examples/blog")).toEqual({
      url: "https://github.com/org/project",
      host: "github.com",
      owner: "org",
      repo: "project",
      ref: "main",
      subpath: "examples/blog",
    });
  });

  it("reads a single file from a blob url", () => {
    expect(parseGitCopySource("https://github.com/org/project/blob/v2/package.json")?.subpath).toBe("package.json");
  });

  it("handles GitLab nested groups and the /-/ separator", () => {
    expect(parseGitCopySource("https://gitlab.com/group/sub/project/-/tree/main/app")).toEqual({
      url: "https://gitlab.com/group/sub/project",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "project",
      ref: "main",
      subpath: "app",
    });
  });

  it("lets a #fragment override a ref in a tree url", () => {
    const parsed = parseGitCopySource("https://github.com/org/project/tree/main/examples#v9");
    expect(parsed?.ref).toBe("v9");
    expect(parsed?.subpath).toBe("examples");
  });

  it("keeps credentials out of the cache path but in the clone url", () => {
    const parsed = parseGitCopySource("https://user:token@github.com/org/project");
    expect(parsed?.url).toBe("https://user:token@github.com/org/project");
    expect(parsed?.host).toBe("github.com");
    expect(repoCacheDirFor("/cache", parsed!)).not.toContain("token");
  });
});

describe("repoCacheDirFor", () => {
  const base: GitCopySource = {
    url: "https://github.com/org/project",
    host: "github.com",
    owner: "org",
    repo: "project",
  };

  it("uses a reversed host and HEAD for an unpinned ref", () => {
    expect(repoCacheDirFor("/cache", base)).toBe(path.join("/cache", "com.github", "org", "project", "HEAD"));
  });

  it("gives each ref its own directory", () => {
    const a = repoCacheDirFor("/cache", { ...base, ref: "v1" });
    const b = repoCacheDirFor("/cache", { ...base, ref: "v2" });
    expect(a).not.toBe(b);
    expect(a.endsWith(path.join("project", "v1"))).toBe(true);
  });

  it("does not collapse refs that slugify to the same string", () => {
    const slashed = repoCacheDirFor("/cache", { ...base, ref: "feat/x" });
    const dashed = repoCacheDirFor("/cache", { ...base, ref: "feat-x" });
    expect(slashed).not.toBe(dashed);
    expect(slashed).not.toContain("/feat/x");
  });

  it("nests gitlab subgroups", () => {
    const dir = repoCacheDirFor("/cache", { ...base, host: "gitlab.com", owner: "group/sub" });
    expect(dir).toBe(path.join("/cache", "com.gitlab", "group", "sub", "project", "HEAD"));
  });
});

describe("defaultRepoCacheRoot", () => {
  it("lives under .axis in the config directory", () => {
    expect(defaultRepoCacheRoot("/project")).toBe(path.join("/project", ".axis", "repos"));
  });
});

describe("ensureRepo", () => {
  const source: GitCopySource = {
    url: "https://github.com/org/project",
    host: "github.com",
    owner: "org",
    repo: "project",
  };

  it("clones into the cache directory on first use", async () => {
    const calls = stubClone();
    const dir = await ensureRepo(source, { cacheRoot, logger: silentLogger });

    expect(dir).toBe(repoCacheDirFor(cacheRoot, source));
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# project\n");
  });

  it("fetches a repository only once across concurrent callers", async () => {
    const calls = stubClone();
    const dirs = await Promise.all([
      ensureRepo(source, { cacheRoot, logger: silentLogger }),
      ensureRepo(source, { cacheRoot, logger: silentLogger }),
      ensureRepo(source, { cacheRoot, logger: silentLogger }),
    ]);

    expect(calls).toHaveLength(1);
    expect(new Set(dirs).size).toBe(1);
  });

  it("reuses an existing clone in a fresh process", async () => {
    stubClone();
    await ensureRepo(source, { cacheRoot, logger: silentLogger });

    // Simulate a later run: same cache on disk, empty in-process cache.
    resetRepoCache();
    const calls = stubClone();
    await ensureRepo(source, { cacheRoot, logger: silentLogger });
    expect(calls).toHaveLength(0);
  });

  it("re-clones when refresh is set", async () => {
    stubClone();
    const dir = await ensureRepo(source, { cacheRoot, logger: silentLogger });
    fs.writeFileSync(path.join(dir, "stale.txt"), "stale");

    resetRepoCache();
    const calls = stubClone();
    await ensureRepo(source, { cacheRoot, logger: silentLogger, refresh: true });

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "stale.txt"))).toBe(false);
  });

  it("re-clones when a cached directory is missing .git/HEAD", async () => {
    stubClone();
    const dir = await ensureRepo(source, { cacheRoot, logger: silentLogger });
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });

    resetRepoCache();
    const calls = stubClone();
    await ensureRepo(source, { cacheRoot, logger: silentLogger });
    expect(calls).toHaveLength(1);
  });

  it("keeps different refs of the same repo side by side", async () => {
    const calls = stubClone();
    const one = await ensureRepo({ ...source, ref: "v1" }, { cacheRoot, logger: silentLogger });
    const two = await ensureRepo({ ...source, ref: "v2" }, { cacheRoot, logger: silentLogger });

    expect(calls).toHaveLength(2);
    expect(one).not.toBe(two);
  });

  it("leaves no cache entry behind when the clone fails", async () => {
    restoreClone = setGitCloneImplForTests(async () => {
      throw new Error("repository not found");
    });

    await expect(ensureRepo(source, { cacheRoot, logger: silentLogger })).rejects.toThrow(
      /Failed to clone https:\/\/github.com\/org\/project: repository not found/,
    );
    expect(fs.existsSync(repoCacheDirFor(cacheRoot, source))).toBe(false);
    // No empty `<repo>/` shell left behind either.
    expect(fs.existsSync(path.join(cacheRoot, "com.github", "org", "project"))).toBe(false);
  });

  it("reuses the failure instead of retrying once per caller", async () => {
    let attempts = 0;
    restoreClone = setGitCloneImplForTests(async () => {
      attempts++;
      throw new Error("network down");
    });

    await expect(ensureRepo(source, { cacheRoot, logger: silentLogger })).rejects.toThrow();
    await expect(ensureRepo(source, { cacheRoot, logger: silentLogger })).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("collectGitCopySources", () => {
  it("collects git copy actions and ignores local ones", () => {
    const sources = collectGitCopySources(
      [
        { action: "copy", match: "./fixtures/app/**/*", destination: "." },
        { action: "copy", match: "https://github.com/org/project", destination: "." },
        { action: "run_script", command: "npm install" },
      ],
      "/cache",
    );

    expect([...sources.values()].map((s) => s.url)).toEqual(["https://github.com/org/project"]);
  });

  it("deduplicates the same repo and ref across scenarios", () => {
    const sources = collectGitCopySources(
      [{ action: "copy", match: "https://github.com/org/project", destination: "." }],
      "/cache",
    );
    collectGitCopySources(
      [{ action: "copy", match: "https://github.com/org/project/tree/HEAD/docs", destination: "docs" }],
      "/cache",
      sources,
    );
    collectGitCopySources(
      [{ action: "copy", match: "https://github.com/org/project", destination: ".", ref: "v2" }],
      "/cache",
      sources,
    );

    // Same repo at HEAD collapses to one entry; the pinned ref gets its own.
    expect(sources.size).toBe(2);
  });

  it("lets an explicit ref override the url fragment", () => {
    const sources = collectGitCopySources(
      [{ action: "copy", match: "https://github.com/org/project#main", destination: ".", ref: "v9" }],
      "/cache",
    );
    expect([...sources.values()][0].ref).toBe("v9");
  });
});
