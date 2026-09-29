import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { silentLogger, formatError } from "../types/output.js";
import type { Logger } from "../types/output.js";
import type { LifecycleAction } from "../types/scenario.js";

/** Scheme-based git URLs: `https://host/owner/repo`, `git://…`, `ssh://…`. */
const SCHEME_URL_RE = /^(https?|git|ssh):\/\/([^/]+)\/(.+)$/;

/**
 * scp-style shorthand: `git@github.com:owner/repo.git`. The user and host
 * patterns are deliberately narrow (no slashes, host must be dotted) so a
 * local path that happens to contain `@` isn't mistaken for a repo.
 */
const SCP_URL_RE = /^([^@\s/.][^@\s/]*)@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+):(.+)$/;

/** Clones can be large; give them more room than a lifecycle script gets. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Cache directory for repositories staged by `copy` actions, relative to the config dir. */
const REPOS_SUBDIR = path.join(".axis", "repos");

/**
 * A git repository referenced by a `copy` action's `match` field, parsed into
 * the pieces needed to clone it and to give it a stable spot in the cache.
 */
export interface GitCopySource {
  /** Clone URL handed to `git clone`, with any `#ref` fragment or web `/tree/` suffix removed. */
  url: string;
  /** Hostname, without any `user:token@` userinfo prefix. Used for the cache path. */
  host: string;
  /** Owner/group path. May contain `/` for nested groups, or be empty for host-root repos. */
  owner: string;
  /** Repository name, without a trailing `.git`. */
  repo: string;
  /** Branch, tag, or commit to check out. Undefined means the repo's default branch. */
  ref?: string;
  /** Path (or glob) inside the repo to copy. Undefined means the whole working tree. */
  subpath?: string;
}

/** Default cache root for `copy` clones: `<configDir>/.axis/repos`. */
export function defaultRepoCacheRoot(configDir: string): string {
  return path.join(configDir, REPOS_SUBDIR);
}

/**
 * Parse a `copy` action `match` value as a git repository reference, or return
 * null when it looks like a local path/glob (the original `copy` behaviour).
 *
 * Accepted forms:
 *   - `https://github.com/org/repo` (also `.git`, `git://`, `ssh://`)
 *   - `git@github.com:org/repo.git`
 *   - any of the above with a `#branch`, `#tag`, or `#commit` fragment
 *   - a pasted web URL: `https://github.com/org/repo/tree/main/examples/blog`
 *     (GitLab's `/-/tree/` and `blob` variants work too), which sets both the
 *     ref and the subpath
 */
export function parseGitCopySource(match: string): GitCopySource | null {
  const trimmed = match.trim();
  if (trimmed.length === 0) return null;

  const hashIndex = trimmed.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const fragmentRef = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : "";

  const schemeMatch = withoutFragment.match(SCHEME_URL_RE);
  if (schemeMatch) {
    const [, scheme, authority, rest] = schemeMatch;
    // Keep credentials in the clone URL but out of the cache path.
    const atIndex = authority.lastIndexOf("@");
    const userinfo = atIndex >= 0 ? authority.slice(0, atIndex + 1) : "";
    const host = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
    const parts = splitRepoPath(rest);
    if (!parts) return null;
    return finalize({
      url: `${scheme}://${userinfo}${host}/${parts.repoPath}`,
      host,
      owner: parts.owner,
      repo: parts.repo,
      ...(parts.ref ? { ref: parts.ref } : {}),
      ...(parts.subpath ? { subpath: parts.subpath } : {}),
    });
  }

  const scpMatch = withoutFragment.match(SCP_URL_RE);
  if (scpMatch) {
    const [, user, host, rest] = scpMatch;
    const parts = splitRepoPath(rest);
    if (!parts) return null;
    return finalize({
      url: `${user}@${host}:${parts.repoPath}`,
      host,
      owner: parts.owner,
      repo: parts.repo,
      ...(parts.ref ? { ref: parts.ref } : {}),
      ...(parts.subpath ? { subpath: parts.subpath } : {}),
    });
  }

  return null;

  function finalize(source: GitCopySource): GitCopySource {
    // An explicit `#ref` fragment wins over a ref embedded in a web URL.
    return fragmentRef ? { ...source, ref: fragmentRef } : source;
  }
}

interface RepoPathParts {
  /** Path portion of the clone URL, e.g. `org/repo.git`. */
  repoPath: string;
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

/**
 * Split the path portion of a URL into owner/repo, peeling off a trailing
 * `tree/<ref>/<subpath>` (or `blob/…`, or GitLab's `-/tree/…`) when the URL
 * was copied out of a repository browser.
 */
function splitRepoPath(rest: string): RepoPathParts | null {
  const segments = rest
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  let repoSegments = segments;
  let ref: string | undefined;
  let subpath: string | undefined;

  const treeIndex = segments.findIndex((s, i) => i >= 1 && (s === "tree" || s === "blob"));
  if (treeIndex > 0 && segments.length > treeIndex + 1) {
    repoSegments = segments.slice(0, treeIndex);
    // GitLab routes browse URLs through a `/-/` separator segment.
    if (repoSegments[repoSegments.length - 1] === "-") repoSegments = repoSegments.slice(0, -1);
    ref = segments[treeIndex + 1];
    const remainder = segments.slice(treeIndex + 2).join("/");
    if (remainder.length > 0) subpath = remainder;
  }

  if (repoSegments.length === 0) return null;
  const repoPath = repoSegments.join("/");
  const repo = repoSegments[repoSegments.length - 1].replace(/\.git$/, "");
  const owner = repoSegments.slice(0, -1).join("/");

  return {
    repoPath,
    owner,
    repo,
    ...(ref ? { ref } : {}),
    ...(subpath ? { subpath } : {}),
  };
}

/**
 * `<cacheRoot>/<reversedHost>/<owner>/<repo>/<ref>` — one directory per
 * (repository, ref) pair so scenarios pinned to different refs of the same
 * repo don't fight over one checkout. Mirrors the layout used by
 * `.axis/remotes/` for remote scenario repos.
 */
export function repoCacheDirFor(cacheRoot: string, source: GitCopySource): string {
  const reversedHost = slugify(source.host.split(".").reverse().join("."));
  const ownerSegments = source.owner
    .split("/")
    .filter((s) => s.length > 0)
    .map(slugify);
  return path.join(cacheRoot, reversedHost, ...ownerSegments, slugify(source.repo), refSlug(source.ref));
}

/**
 * Filesystem-safe form of a ref. Refs containing path separators or other
 * unsafe characters get a short hash suffix so `feat/x` and `feat-x` can't
 * collapse onto the same cache directory.
 */
function refSlug(ref?: string): string {
  if (!ref) return "HEAD";
  const slug = slugify(ref);
  if (slug === ref) return slug;
  return `${slug}-${crypto.createHash("sha1").update(ref).digest("hex").slice(0, 8)}`;
}

function slugify(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "repo";
}

/**
 * Injection point for tests so they don't have to hit the network.
 * The default implementation shells out to `git`.
 */
export type GitCloneImpl = (source: GitCopySource, targetDir: string, logger: Logger) => Promise<void>;

let cloneImpl: GitCloneImpl = defaultClone;

/** Override the clone implementation. Returns a function that restores the default. */
export function setGitCloneImplForTests(impl: GitCloneImpl): () => void {
  cloneImpl = impl;
  return () => {
    cloneImpl = defaultClone;
  };
}

/**
 * In-flight and completed fetches, keyed by cache directory. Every scenario
 * and every parallel job asking for the same (repo, ref) awaits the same
 * promise, so a repository is fetched exactly once per process. Failures are
 * cached too: a repo that can't be cloned shouldn't be retried once per job.
 */
const fetches = new Map<string, Promise<string>>();

/** Drop the in-process fetch cache. Exposed for tests and long-lived embedders. */
export function resetRepoCache(): void {
  fetches.clear();
}

export interface EnsureRepoOptions {
  /** Root directory holding cached clones. See {@link defaultRepoCacheRoot}. */
  cacheRoot: string;
  logger?: Logger;
  /** Re-clone even when a valid cached copy exists. */
  refresh?: boolean;
}

/**
 * Resolve `source` to a local checkout, cloning it into the cache on first
 * use and reusing it forever after. Cached clones are never auto-updated —
 * results stay comparable across runs — so pass `refresh` (CLI:
 * `--refresh-repos`) to pull in upstream changes.
 */
export function ensureRepo(source: GitCopySource, options: EnsureRepoOptions): Promise<string> {
  const dir = repoCacheDirFor(options.cacheRoot, source);
  const existing = fetches.get(dir);
  if (existing) return existing;
  const pending = fetchIntoCache(source, dir, options);
  fetches.set(dir, pending);
  return pending;
}

async function fetchIntoCache(source: GitCopySource, dir: string, options: EnsureRepoOptions): Promise<string> {
  const logger = options.logger ?? silentLogger;

  if (!options.refresh && isValidClone(dir)) {
    logger.verbose?.(`Reusing cached repository: ${dir}`);
    return dir;
  }
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // Clone into a sibling temp dir and rename into place so a crashed or
  // concurrent clone can never leave a half-populated cache entry behind.
  const tmpDir = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const refLabel = source.ref ? ` (${source.ref})` : "";
  logger.info(`Cloning repository: ${source.url}${refLabel}`);
  try {
    await cloneImpl(source, tmpDir, logger);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      // Drop the `<repo>/` directory we just created, unless another ref of
      // the same repo is cached under it.
      fs.rmdirSync(path.dirname(dir));
    } catch {
      /* not empty, or never created — leave it */
    }
    throw new Error(`Failed to clone ${source.url}${refLabel}: ${formatError(err)}`);
  }

  try {
    fs.renameSync(tmpDir, dir);
  } catch (err) {
    // Another process populated the cache first — keep theirs, drop ours.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!isValidClone(dir)) {
      throw new Error(`Failed to stage clone of ${source.url} at ${dir}: ${formatError(err)}`);
    }
  }
  return dir;
}

/**
 * `.git/HEAD` is git's marker for "this directory holds real repository
 * state". Gating on it means an interrupted clone is re-fetched rather than
 * silently treated as a usable checkout.
 */
function isValidClone(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git", "HEAD"));
}

async function defaultClone(source: GitCopySource, targetDir: string, logger: Logger): Promise<void> {
  const shallow = ["clone", "--quiet", "--depth", "1", "--single-branch"];
  if (source.ref) shallow.push("--branch", source.ref);
  try {
    await runGit([...shallow, source.url, targetDir]);
    return;
  } catch (err) {
    if (!source.ref) throw err;
    // `--branch` only accepts branches and tags. A commit SHA lands here, so
    // fall back to a full clone we can check out by revision.
    logger.verbose?.(`Shallow clone of ${source.url}@${source.ref} failed, retrying with full history`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    await runGit(["clone", "--quiet", source.url, targetDir]);
    await runGit(["-C", targetDir, "checkout", "--quiet", "--detach", source.ref]);
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "ignore", "pipe"],
      // Without this git blocks forever waiting for credentials on a private repo.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, CLONE_TIMEOUT_MS);

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to run git: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${args[0]} timed out after ${CLONE_TIMEOUT_MS / 60_000} minutes`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim().split("\n").slice(-3).join("\n") || `git exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Collect the distinct git repositories referenced by `copy` actions, keyed by
 * cache directory. The runner uses this to fetch every repository once during
 * pre-flight instead of racing to fetch it from parallel job setups.
 */
export function collectGitCopySources(
  actions: LifecycleAction[] | undefined,
  cacheRoot: string,
  into: Map<string, GitCopySource> = new Map(),
): Map<string, GitCopySource> {
  for (const action of actions ?? []) {
    if (action.action !== "copy") continue;
    const parsed = parseGitCopySource(action.match);
    if (!parsed) continue;
    const source = action.ref ? { ...parsed, ref: action.ref } : parsed;
    into.set(repoCacheDirFor(cacheRoot, source), source);
  }
  return into;
}
