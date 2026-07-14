import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  copyClaudeConfigWithoutMcp,
  copyHomeFile,
  hasHomeFile,
  hasKeychainEntry,
} from "../../../../src/adapters/utils/local-session.js";

describe("local-session", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "axis-local-session-"));
    // os.homedir() honors HOME on POSIX and USERPROFILE on Windows
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  describe("hasHomeFile", () => {
    it("returns false when file does not exist", () => {
      expect(hasHomeFile(".claude/.credentials.json")).toBe(false);
    });

    it("returns false for empty files", () => {
      fs.mkdirSync(path.join(fakeHome, ".claude"));
      fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "");
      expect(hasHomeFile(".claude/.credentials.json")).toBe(false);
    });

    it("returns true when file exists and is non-empty", () => {
      fs.mkdirSync(path.join(fakeHome, ".claude"));
      fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), '{"token":"x"}');
      expect(hasHomeFile(".claude/.credentials.json")).toBe(true);
    });

    it("returns false for a directory at the path", () => {
      fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
      expect(hasHomeFile(".codex")).toBe(false);
    });
  });

  describe("copyHomeFile", () => {
    it("no-ops when the source file is missing", () => {
      const destDir = path.join(fakeHome, "isolated", ".claude");
      copyHomeFile(".claude/.credentials.json", destDir);
      expect(fs.existsSync(destDir)).toBe(false);
    });

    it("copies the file into destDir, preserving the basename", () => {
      fs.mkdirSync(path.join(fakeHome, ".claude"));
      fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "creds");

      const destDir = path.join(fakeHome, "isolated", ".claude");
      copyHomeFile(".claude/.credentials.json", destDir);

      expect(fs.readFileSync(path.join(destDir, ".credentials.json"), "utf8")).toBe("creds");
    });

    it("creates destDir if it does not exist", () => {
      fs.mkdirSync(path.join(fakeHome, ".codex"));
      fs.writeFileSync(path.join(fakeHome, ".codex", "auth.json"), "{}");

      const destDir = path.join(fakeHome, "isolated", ".codex");
      copyHomeFile(".codex/auth.json", destDir);

      expect(fs.existsSync(path.join(destDir, "auth.json"))).toBe(true);
    });
  });

  describe("copyClaudeConfigWithoutMcp", () => {
    const destDir = () => path.join(fakeHome, "isolated", ".claude");

    it("no-ops when ~/.claude.json is missing", () => {
      copyClaudeConfigWithoutMcp(destDir());
      expect(fs.existsSync(path.join(destDir(), ".claude.json"))).toBe(false);
    });

    it("strips top-level and per-project mcpServers while keeping oauthAccount", () => {
      const projectPath = "/some/project";
      fs.writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({
          oauthAccount: { emailAddress: "op@example.com", accountUuid: "uuid-123" },
          mcpServers: { notion: { type: "http", url: "https://notion.example" } },
          numStartups: 42,
          projects: {
            [projectPath]: {
              mcpServers: { bluesky: { command: "bsky" } },
              allowedTools: ["Read"],
            },
          },
        }),
      );

      copyClaudeConfigWithoutMcp(destDir());

      const staged = JSON.parse(fs.readFileSync(path.join(destDir(), ".claude.json"), "utf8"));
      expect(staged.oauthAccount).toEqual({ emailAddress: "op@example.com", accountUuid: "uuid-123" });
      expect(staged.numStartups).toBe(42);
      expect(staged.mcpServers).toBeUndefined();
      expect(staged.projects[projectPath].mcpServers).toBeUndefined();
      // Non-MCP per-project data is preserved
      expect(staged.projects[projectPath].allowedTools).toEqual(["Read"]);
    });

    it("does not mutate the operator's real ~/.claude.json", () => {
      const original = {
        oauthAccount: { emailAddress: "op@example.com" },
        mcpServers: { notion: { type: "http", url: "https://notion.example" } },
      };
      fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify(original));

      copyClaudeConfigWithoutMcp(destDir());

      const realStill = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude.json"), "utf8"));
      expect(realStill.mcpServers).toEqual(original.mcpServers);
    });

    it("skips (does not copy) an unparseable ~/.claude.json rather than leaking it", () => {
      fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{ not valid json");
      copyClaudeConfigWithoutMcp(destDir());
      expect(fs.existsSync(path.join(destDir(), ".claude.json"))).toBe(false);
    });
  });

  describe("hasKeychainEntry", () => {
    it("returns false on non-Darwin platforms", async () => {
      if (process.platform === "darwin") return;
      expect(await hasKeychainEntry("Anything")).toBe(false);
    });

    it("returns false for a service name that almost certainly does not exist", async () => {
      // Even on macOS, this random service shouldn't exist in any sane CI keychain
      expect(await hasKeychainEntry("axis-test-nonexistent-service-99999")).toBe(false);
    });
  });
});
