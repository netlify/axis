import * as fs from "node:fs";
import * as path from "node:path";
import type { AxisConfig } from "../types/config.js";
import type { ArtifactEntry } from "../types/output.js";
import type { Logger } from "../types/output.js";
import type { Scenario } from "../types/scenario.js";

/**
 * Compute the effective artifact glob patterns for a single run by merging
 * top-level config patterns with per-scenario patterns. Order is preserved
 * (config first, scenario second) and duplicates are removed.
 */
export function resolveArtifactPatterns(axisConfig: AxisConfig, scenario: Scenario): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(axisConfig.artifacts ?? []), ...(scenario.artifacts ?? [])]) {
    if (typeof p !== "string" || p.length === 0) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Walk `workspace`, match files against `patterns`, copy each match into
 * `destDir` preserving its relative path, and return the manifest entries
 * with file contents base64-encoded so the HTML report can preview/download
 * them even when opened from disk.
 */
export function captureArtifacts(
  workspace: string,
  patterns: string[],
  destDir: string,
  logger?: Logger,
): ArtifactEntry[] {
  if (patterns.length === 0) return [];
  if (!fs.existsSync(workspace)) return [];

  const matchers = patterns.map(globToRegExp);
  const matches: string[] = [];
  walk(workspace, "", (relPath) => {
    if (matchers.some((re) => re.test(relPath))) matches.push(relPath);
  });

  if (matches.length === 0) return [];

  fs.mkdirSync(destDir, { recursive: true });

  const entries: ArtifactEntry[] = [];
  // Stable ordering for deterministic reports
  matches.sort();
  for (const relPath of matches) {
    const src = path.join(workspace, relPath);
    const dst = path.join(destDir, relPath);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      const buf = fs.readFileSync(src);
      entries.push({
        path: relPath.split(path.sep).join("/"),
        size: buf.byteLength,
        mimeType: inferMimeType(relPath),
        content: buf.toString("base64"),
      });
    } catch (err) {
      logger?.verbose?.(`Failed to capture artifact ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return entries;
}

/**
 * Walk a directory recursively, invoking `onFile` with each file's path
 * relative to `root` (forward-slash normalized). Skips symlinks to avoid
 * following loops outside the workspace.
 */
export function walk(root: string, rel: string, onFile: (relPath: string) => void): void {
  const abs = path.join(root, rel);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of dirents) {
    if (ent.isSymbolicLink()) continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) {
      walk(root, childRel, onFile);
    } else if (ent.isFile()) {
      onFile(childRel.split(path.sep).join("/"));
    }
  }
}

/**
 * Convert a glob pattern to a RegExp anchored to the start and end of the
 * input. Supported syntax:
 *   - `**`  any number of path segments (including zero)
 *   - `*`   any chars except `/`
 *   - `?`   any single char except `/`
 *   - `[abc]` / `[a-z]`  character classes
 *   - everything else is matched literally
 *
 * Patterns are matched against forward-slash relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  // Normalize separators and strip leading "./"
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      // Look ahead for `**`
      if (p[i + 1] === "*") {
        // `**/` or `/**` or bare `**` matches any depth (including zero segments).
        // Consume optional trailing `/`.
        i++; // eat second *
        if (p[i + 1] === "/") {
          i++; // eat the slash too
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      // Pass character class through, but escape inner specials minimally.
      const close = p.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
      } else {
        let body = p.slice(i + 1, close);
        // Support GNU-style `!` negation
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += "[" + body + "]";
        i = close;
      }
    } else if (/[.+^$|(){}\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }

  return new RegExp("^" + re + "$");
}

const MIME_BY_EXT: Record<string, string> = {
  // text
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".ndjson": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".jsx": "text/jsx",
  ".sh": "text/x-shellscript",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".sql": "application/sql",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".lua": "text/x-lua",
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  // pdf / archives / binary
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
};

export function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
