import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Check whether a credentials/auth file exists under the real user HOME.
 *
 * `relPath` is relative to `os.homedir()` (the runner's HOME, NOT the
 * isolated per-job HOME). Empty files return false — a zero-byte
 * credentials file is never a real session.
 */
export function hasHomeFile(relPath: string): boolean {
  try {
    const full = path.join(os.homedir(), relPath);
    const stat = fs.statSync(full);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Read a JSON file under the real user HOME and check whether any of the
 * dotted `paths` resolves to a non-empty value. Used to detect a logged-in
 * session in agent config files like `~/.claude.json` where the OAuth
 * account block is the actual signal of "logged in" (the Keychain entry
 * alone is not enough — `claude-code` reads its `oauthAccount` from the
 * JSON to know which Keychain token to use).
 */
export function homeJsonHasValue(relPath: string, dottedPaths: string[]): boolean {
  try {
    const full = path.join(os.homedir(), relPath);
    const raw = fs.readFileSync(full, "utf8");
    const obj = JSON.parse(raw) as unknown;
    return dottedPaths.some((p) => {
      let cur: unknown = obj;
      for (const part of p.split(".")) {
        if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return false;
        }
      }
      return cur !== null && cur !== undefined && cur !== "";
    });
  } catch {
    return false;
  }
}

/**
 * Check whether a generic-password entry exists in the macOS Keychain.
 *
 * Claude Code on macOS stores OAuth credentials in Keychain by default
 * (service name `"Claude Code-credentials"`), so file-based detection
 * alone misses logged-in users. Returns false on non-Darwin or any
 * lookup error.
 */
export async function hasKeychainEntry(serviceName: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  // Lazy-resolve execFile so test files that mock `node:child_process` with
  // only `spawn` don't blow up at module-load time. Production code always
  // has the real binding available.
  if (typeof childProcess.execFile !== "function") return false;
  const execFileAsync = promisify(childProcess.execFile);
  try {
    await execFileAsync("security", ["find-generic-password", "-s", serviceName], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a macOS Keychain generic-password secret and write it verbatim to
 * `destPath` (mode 0600). Returns true on success. Adapters use this to
 * materialize OAuth credentials stored in Keychain (e.g. `claude login`)
 * into a file-based form that the CLI looks for when its config dir is
 * an isolated path that bypasses Keychain.
 *
 * Note: macOS may prompt the user the first time `security` reads an entry
 * that wasn't created by `/usr/bin/security` itself. Clicking "Always Allow"
 * authorizes subsequent runs.
 */
export async function extractKeychainSecretToFile(serviceName: string, destPath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (typeof childProcess.execFile !== "function") return false;
  const execFileAsync = promisify(childProcess.execFile);
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", serviceName, "-w"], {
      timeout: 10_000,
    });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    // `security -w` always appends a trailing newline; strip it so the file
    // contains the raw JSON the CLI expects.
    fs.writeFileSync(destPath, stdout.replace(/\n$/, ""), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a file from the real user HOME into an isolated config dir, so an
 * agent CLI can authenticate via the user's existing local login without
 * the runner needing an API key. No-op if the source doesn't exist or
 * the destination already has the file (caller may pre-populate).
 */
export function copyHomeFile(srcRelPath: string, destDir: string, destFileName?: string): void {
  const src = path.join(os.homedir(), srcRelPath);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destFileName ?? path.basename(srcRelPath));
  fs.copyFileSync(src, dest);
}

/**
 * Copy `~/.claude.json` into an isolated config dir with all MCP server
 * config stripped out.
 *
 * `claude login` writes the `oauthAccount` anchor into this file, so the
 * claude-code adapter copies it to propagate the operator's OAuth session
 * into CLAUDE_CONFIG_DIR. But the same file also carries the operator's
 * PERSONAL MCP servers — both top-level `mcpServers` and per-project
 * `projects[<path>].mcpServers`. Copying those verbatim leaks the operator's
 * personal MCP tools (notion, bluesky, internal-apps, …) into every scenario
 * run, breaking hermeticity. We delete them from a parsed copy so scenarios
 * get only the servers they declare via ScenarioInput.
 *
 * The operator's real `~/.claude.json` is never mutated — we read it, strip
 * an in-memory copy, and write the sanitized result to `destDir`. No-op if the
 * source is missing; skips (rather than copying verbatim) if it isn't valid
 * JSON, since we can't sanitize what we can't parse — and an unparseable
 * `.claude.json` wouldn't authenticate anyway.
 */
export function copyClaudeConfigWithoutMcp(destDir: string): void {
  const src = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(src)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(src, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  delete parsed.mcpServers;
  const projects = parsed.projects;
  if (projects && typeof projects === "object") {
    for (const project of Object.values(projects as Record<string, unknown>)) {
      if (project && typeof project === "object") {
        delete (project as Record<string, unknown>).mcpServers;
      }
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, ".claude.json"), JSON.stringify(parsed, null, 2) + "\n");
}
