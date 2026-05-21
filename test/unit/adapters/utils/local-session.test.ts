import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyHomeFile, hasHomeFile, hasKeychainEntry } from "../../../../src/adapters/utils/local-session.js";

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
