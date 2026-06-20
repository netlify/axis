import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentAdapter } from "../types/agent.js";
import { createAcpBasedAdapter } from "./base/acp-adapter.js";

/**
 * AWS Kiro CLI via ACP — `kiro-cli acp`. Auth is AWS-managed (kiro.dev
 * sign-in writes both `~/.kiro/` and `~/Library/Application Support/kiro-cli/`
 * on macOS); pre-authenticate once via `kiro-cli login` before headless use.
 */
export function createKiroCliAdapter(): AgentAdapter {
  const base = createAcpBasedAdapter({
    name: "kiro-cli",
    cliCommand: "kiro-cli",
    buildArgs: () => ["acp"],

    hasLocalSession: () => fs.existsSync(path.join(os.homedir(), ".kiro")),

    prepare: (ctx) => {
      // The runner redirects HOME to a fresh per-job dir; mirror the user's
      // login state and bin shims into that HOME so kiro-cli finds them.
      //   - `~/.kiro/` and (on macOS) `~/Library/Application Support/kiro-cli/`
      //     hold the auth token and sqlite DB.
      //   - `kiro-cli` spawns sibling binaries (e.g. `kiro-cli-chat`) via
      //     `$HOME/.local/bin/`, so the symlinks the installer drops there
      //     must also be visible in the isolated HOME.
      const isolatedHome = ctx.homeDirectory;
      const realHome = os.homedir();

      copyDirIfExists(path.join(realHome, ".kiro"), path.join(isolatedHome, ".kiro"));

      if (process.platform === "darwin") {
        const appSupportRel = path.join("Library", "Application Support", "kiro-cli");
        copyDirIfExists(path.join(realHome, appSupportRel), path.join(isolatedHome, appSupportRel));

        // kiro-cli reads AWS Builder ID credentials through the macOS Security
        // framework, which resolves the login keychain via $HOME. Symlink the
        // real Keychains dir so the child finds it. Tradeoff: exposes every
        // keychain item the user has to the kiro-cli process for this run.
        linkIfMissing(path.join(realHome, "Library", "Keychains"), path.join(isolatedHome, "Library", "Keychains"));
      }

      mirrorKiroBinShims(path.join(realHome, ".local", "bin"), path.join(isolatedHome, ".local", "bin"));
    },
  });

  // `kiro-cli acp` exits non-zero after responding to SIGTERM during teardown,
  // even when the prompt completed successfully. Treat a captured result with
  // no recorded error as success so the scorer doesn't penalize the run.
  return {
    ...base,
    async run(input) {
      const output = await base.run(input);
      if (output.result && !output.metadata.error && output.metadata.exitCode !== 0) {
        output.metadata.exitCode = 0;
      }
      return output;
    },
  };
}

function copyDirIfExists(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function linkIfMissing(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.symlinkSync(src, dest);
  } catch {
    // ignore — best-effort
  }
}

/** Symlink any `kiro-cli*` entries from the real `~/.local/bin/` into the isolated one. */
function mirrorKiroBinShims(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.startsWith("kiro-cli")) continue;
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    if (fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(fs.realpathSync(src), dest);
    } catch {
      // ignore — best-effort mirroring
    }
  }
}
