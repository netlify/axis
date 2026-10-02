import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as ChildProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../../../src/adapters/utils/resolve.js", () => ({
  resolveCommand: vi.fn().mockResolvedValue({ command: "muse", prefixArgs: [] }),
}));

import { spawn } from "node:child_process";
import { createMuseAdapter } from "../../../src/adapters/muse.js";
import { getAdapter, getBuiltinAdapterNames, _resetAdapterCache } from "../../../src/adapters/registry.js";
import { uuidv7 } from "../../../src/adapters/utils/msp.js";
import type { AgentAdapter, AgentInput } from "../../../src/types/agent.js";
import {
  createMspMockProcess,
  agentMessage,
  toolCall,
  toolCallStarted,
  internalItem,
  tokenUsage,
  turnCompleted,
  DEFAULT_SESSION_ID,
  type MspMockOptions,
} from "../../helpers/msp-mock.js";

const mockSpawn = vi.mocked(spawn);

let tmpRoot: string;

function mockMuse(options: MspMockOptions = {}) {
  const { proc, requests } = createMspMockProcess(options);
  mockSpawn.mockReturnValue(proc as never);
  return requests;
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  const workspace = path.join(tmpRoot, "work");
  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    prompt: "do the thing",
    config: { agent: "muse" },
    scenario: { key: "s", prompt: "do the thing" } as AgentInput["scenario"],
    workingDirectory: workspace,
    homeDirectory: home,
    env: { META_API_KEY: "test-key" },
    ...overrides,
  };
}

describe("muse adapter", () => {
  let adapter: AgentAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "muse-test-"));
    adapter = createMuseAdapter();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("registry", () => {
    it("is registered as a built-in named muse", () => {
      _resetAdapterCache();
      expect(getBuiltinAdapterNames()).toContain("muse");
      expect(getAdapter("muse").name).toBe("muse");
    });
  });

  describe("isolation", () => {
    it("points XDG dirs under home and pins the launcher's auto-update off", () => {
      const env = adapter.isolationEnv!({ workspace: "/w", home: "/h" });

      expect(env.XDG_CONFIG_HOME).toBe(path.join("/h", ".config"));
      expect(env.XDG_DATA_HOME).toBe(path.join("/h", ".local", "share"));
      // The launcher swaps the binary in the background on a ~hourly check;
      // a suite must grade one build, and parallel jobs must not race a download.
      expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
      expect(env.MUSE_LOGIN).toBe("0");
    });

    it("keeps every isolation path out of the workspace", () => {
      const env = adapter.isolationEnv!({ workspace: "/w", home: "/h" });
      for (const value of Object.values(env)) {
        expect(value.startsWith("/w")).toBe(false);
      }
    });
  });

  describe("auth", () => {
    it("declares META_API_KEY as the required env var", () => {
      expect(adapter.requiredEnv!()).toEqual(["META_API_KEY"]);
    });
  });

  describe("uuidv7", () => {
    // MSP rejects any other version with
    // "invalid session/start commandId: expected UUIDv7".
    it("produces a version 7, variant 10 UUID", () => {
      expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("embeds the current time in the leading 48 bits", () => {
      const before = Date.now();
      const stamp = parseInt(uuidv7().replace(/-/g, "").slice(0, 12), 16);

      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(Date.now());
    });

    it("orders ids generated in different milliseconds", async () => {
      const first = uuidv7();
      await new Promise((r) => setTimeout(r, 2));
      expect(uuidv7() > first).toBe(true);
    });
  });

  describe("serve invocation", () => {
    it("launches `muse serve`, disabling the sandbox and trusting the workspace", async () => {
      mockMuse();

      await adapter.run(makeInput());

      const argv = mockSpawn.mock.calls[0][1] as string[];
      expect(argv[0]).toBe("serve");
      // `muse serve` has no --yolo: the sandbox is fixed for the host's
      // lifetime and must be set here, while approval mode goes on the wire.
      expect(argv).toContain("--disable-sandbox");
      expect(argv).toContain("--trust-workspace");
      // The prompt is a protocol message, never an argument.
      expect(argv).not.toContain("do the thing");
    });

    it("lets a scenario opt out of the sandbox-off default", async () => {
      mockMuse();

      await adapter.run(makeInput({ config: { agent: "muse", flags: { yolo: false } } }));

      const argv = mockSpawn.mock.calls[0][1] as string[];
      expect(argv).not.toContain("--disable-sandbox");
      expect(argv).not.toContain("--trust-workspace");
    });

    it("forwards the model and extra flags", async () => {
      mockMuse();

      await adapter.run(makeInput({ config: { agent: "muse", model: "muse-spark", flags: { provider: "echo" } } }));

      const argv = mockSpawn.mock.calls[0][1] as string[];
      expect(argv[argv.indexOf("--model") + 1]).toBe("muse-spark");
      expect(argv[argv.indexOf("--provider") + 1]).toBe("echo");
    });

    it("spawns detached so the whole process tree can be reaped", async () => {
      mockMuse();

      await adapter.run(makeInput());

      expect((mockSpawn.mock.calls[0][2] as { detached?: boolean }).detached).toBe(true);
    });
  });

  describe("protocol handshake", () => {
    it("initializes, starts a session, then starts the turn", async () => {
      const requests = mockMuse();

      await adapter.run(makeInput());

      expect(requests.map((r) => r.method)).toEqual(["initialize", "initialized", "session/start", "turn/start"]);
    });

    it("requests allowAll approval on the wire and roots the session in the workspace", async () => {
      const requests = mockMuse();
      const input = makeInput();

      await adapter.run(input);

      const start = requests.find((r) => r.method === "session/start")!.params;
      expect(start.approvalMode).toBe("allowAll");
      expect(start.workspaceRoot).toBe(input.workingDirectory);
      expect(start.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    });

    it("sends the prompt as a text input part", async () => {
      const requests = mockMuse();

      await adapter.run(makeInput());

      const turn = requests.find((r) => r.method === "turn/start")!.params;
      expect(turn.input).toEqual([{ type: "text", text: "do the thing" }]);
      expect(turn.sessionId).toBe(DEFAULT_SESSION_ID);
    });

    it("signals the runner once the handshake is done", async () => {
      mockMuse();
      const onAgentReady = vi.fn();

      await adapter.run(makeInput({ onAgentReady }));

      expect(onAgentReady).toHaveBeenCalled();
    });
  });

  describe("results and transcript", () => {
    it("takes the final answer from the last agentMessage", async () => {
      mockMuse({ turnNotifications: [agentMessage("first"), agentMessage("final", "item-2")] });

      const out = await adapter.run(makeInput());

      expect(out.result).toBe("final");
      expect(out.metadata.exitCode).toBe(0);
      expect(out.metadata.error).toBeUndefined();
      expect(out.metadata.sessionId).toBe(DEFAULT_SESSION_ID);
    });

    it("assembles a message streamed as item/delta", async () => {
      mockMuse({
        turnNotifications: [
          { method: "item/delta", params: { itemId: "i1", field: "text", delta: "Hello " } },
          { method: "item/delta", params: { itemId: "i1", field: "text", delta: "world" } },
          { method: "item/completed", params: { item: { itemId: "i1", kind: "agentMessage", status: "completed" } } },
        ],
      });

      const out = await adapter.run(makeInput());

      expect(out.result).toBe("Hello world");
    });

    it("emits a tool_use/tool_result pair so the interaction can be timed", async () => {
      mockMuse({ turnNotifications: [toolCallStarted("bash"), toolCall("bash"), agentMessage("Done")] });

      const out = await adapter.run(makeInput());

      // sparse-index.ts measures an interaction's duration from the
      // tool_use -> tool_result timestamp gap, so the open half is required:
      // without it every Muse tool call scores as having no duration.
      expect(out.transcript.map((e) => e.type)).toEqual(["tool_use", "tool_result", "assistant"]);
      // `tool_name` is the first key extractToolName() checks, so scoring
      // categorizes this as an environment interaction with no special casing.
      expect(out.transcript[0].content.tool_name).toBe("bash");
      expect(out.transcript[1].content.tool_name).toBe("bash");
    });

    it("keeps the pair's tool name when the completion omits it", async () => {
      mockMuse({
        turnNotifications: [
          toolCallStarted("grep", "i-9"),
          { method: "item/completed", params: { item: { itemId: "i-9", kind: "toolCall", status: "completed" } } },
        ],
      });

      const out = await adapter.run(makeInput());

      expect(out.transcript.map((e) => e.content.tool_name)).toEqual(["grep", "grep"]);
    });

    it("opens a pair for a sub-run but not for a plain message", async () => {
      mockMuse({
        turnNotifications: [
          { method: "item/started", params: { item: { itemId: "a1", kind: "agentMessage" } } },
          { method: "item/started", params: { item: { itemId: "r1", kind: "reminderChild" } } },
          internalItem("reminderChild", "r1"),
          agentMessage("Done"),
        ],
      });

      const out = await adapter.run(makeInput());

      // A started agentMessage opens nothing (its text arrives as deltas), but
      // a sub-run needs both halves so its duration is measurable.
      expect(out.transcript.map((e) => e.type)).toEqual(["tool_use", "tool_result", "assistant"]);
    });

    it("records a failed tool call as an error entry", async () => {
      mockMuse({ turnNotifications: [toolCall("bash", { failed: true }), agentMessage("Done")] });

      const out = await adapter.run(makeInput());

      expect(out.transcript.some((e) => e.type === "error")).toBe(true);
    });

    it("drops the echoed prompt and view bookkeeping", async () => {
      mockMuse({
        turnNotifications: [
          { method: "item/completed", params: { item: { kind: "userMessage", text: "do the thing" } } },
          { method: "session/statusChanged", params: { status: "running" } },
          { method: "session/contextUsage", params: { usedTokens: 10 } },
          agentMessage("Done"),
        ],
      });

      const out = await adapter.run(makeInput());

      // The prompt is already stored on the report, and status/cursor churn
      // is not an agent decision.
      expect(out.transcript.map((e) => e.type)).toEqual(["assistant"]);
    });

    it("keeps Muse's own sub-runs, which occupy real wall time", async () => {
      // A trivial greeting turn spent 18.7s of 27s on three reminderChild
      // runs AFTER the answer. Dropping them left the last entry at 7.9s and
      // the report charged the remaining 19.2s to "agent shutdown".
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          internalItem("reminderChild", "r1"),
          internalItem("reminderChild", "r2"),
          internalItem("subagent", "s1"),
          internalItem("compaction", "c1"),
        ],
      });

      const out = await adapter.run(makeInput());

      expect(out.transcript.map((e) => e.type)).toEqual([
        "assistant",
        "tool_result",
        "tool_result",
        "tool_result",
        "tool_result",
      ]);
      // `task` is in AGENT_TOOL_NAMES, so these score against the agent
      // dimension rather than falling through to `service`.
      expect(out.transcript.slice(1).every((e) => e.content.tool_name === "task")).toBe(true);
      // The original kind stays available for anything reading the detail.
      expect(out.transcript[1].content.kind).toBe("reminderChild");
    });

    it("feeds streamed text to the live token estimator", async () => {
      mockMuse({
        turnNotifications: [
          { method: "item/delta", params: { itemId: "i1", field: "text", delta: "x".repeat(500) } },
          agentMessage("done", "i1"),
        ],
      });
      const onTokenProgress = vi.fn();

      await adapter.run(makeInput({ onTokenProgress }));

      expect(onTokenProgress).toHaveBeenCalled();
    });
  });

  describe("token usage and cost", () => {
    it("reports cumulative counters and USD cost", async () => {
      // Shape taken from a real billed turn. Muse counts prompt tokens once,
      // cache reads included: totalTokens = promptTokens + outputTokens.
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          tokenUsage({
            promptTokens: 26374,
            outputTokens: 233,
            cacheReadTokens: 14577,
            totalTokens: 26607,
            cost: { usd: 0.001255454, partial: false },
          }),
        ],
      });

      const out = await adapter.run(makeInput());

      // AXIS sums input + output + cacheReadInput, so the cache read is
      // subtracted out of `input` to avoid counting it twice.
      expect(out.metadata.tokenUsage).toEqual({ input: 11797, output: 233, cacheReadInput: 14577 });
      expect(out.metadata.totalCostUsd).toBeCloseTo(0.001255454);
    });

    it("totals to Muse's own totalTokens rather than double counting the cache", async () => {
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          tokenUsage({ promptTokens: 26374, outputTokens: 233, cacheReadTokens: 14577, totalTokens: 26607 }),
        ],
      });

      const { input, output, cacheReadInput } = (await adapter.run(makeInput())).metadata.tokenUsage!;

      expect(input + output + (cacheReadInput ?? 0)).toBe(26607);
    });

    it("never reports a negative input count", async () => {
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          tokenUsage({ promptTokens: 10, outputTokens: 1, cacheReadTokens: 50, totalTokens: 11 }),
        ],
      });

      expect((await adapter.run(makeInput())).metadata.tokenUsage!.input).toBe(0);
    });

    it("falls back to the per-call usage block when there is no cumulative", async () => {
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          { method: "session/tokenUsage", params: { usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 } } },
        ],
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.tokenUsage).toEqual({ input: 5, output: 3, cacheReadInput: 2 });
    });

    it("reports no cost rather than $0 when nothing was priced", async () => {
      mockMuse({
        turnNotifications: [agentMessage("Done"), tokenUsage({ promptTokens: 5, outputTokens: 5, totalTokens: 10 })],
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.tokenUsage).toEqual({ input: 5, output: 5 });
      // An unpriced run must not look free; `undefined` keeps it out of the
      // cost column entirely.
      expect(out.metadata.totalCostUsd).toBeUndefined();
    });

    it("does not let a subagent's smaller usage clobber the session total", async () => {
      mockMuse({
        turnNotifications: [
          agentMessage("Done"),
          tokenUsage({ promptTokens: 900, outputTokens: 100, totalTokens: 1000 }),
          tokenUsage({ promptTokens: 10, outputTokens: 2, totalTokens: 12 }),
        ],
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.tokenUsage).toEqual({ input: 900, output: 100 });
    });

    it("leaves usage undefined when the host never reports any", async () => {
      mockMuse({ turnNotifications: [agentMessage("Done")] });

      const out = await adapter.run(makeInput());

      expect(out.metadata.tokenUsage).toBeUndefined();
      expect(out.metadata.totalCostUsd).toBeUndefined();
    });
  });

  describe("duration", () => {
    it("reports the turn's own duration, not wall clock", async () => {
      mockMuse({
        turnNotifications: [agentMessage("Done"), turnCompleted("completed", { durationMs: 24306 })],
        omitTurnCompleted: true,
      });

      const out = await adapter.run(makeInput());

      // Wall clock would also charge the agent for `muse serve` cold start
      // (~1.8s) and the teardown AXIS itself triggers.
      expect(out.metadata.durationMs).toBe(24306);
    });

    it("falls back to wall clock when the turn reports no duration", async () => {
      mockMuse({ turnNotifications: [agentMessage("Done")] });

      const out = await adapter.run(makeInput());

      expect(out.metadata.durationMs).toBeGreaterThanOrEqual(0);
      expect(out.metadata.durationMs).toBeLessThan(10_000);
    });
  });

  describe("failure paths", () => {
    it("surfaces a failed turn with its error message", async () => {
      mockMuse({
        turnNotifications: [
          turnCompleted("failed", { error: { message: "API error 402: billing", kind: "provider" } }),
        ],
        omitTurnCompleted: true,
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.error).toContain("402");
      expect(out.metadata.exitCode).not.toBe(0);
    });

    it("fails fast when the host closes the session without completing the turn", async () => {
      mockMuse({
        turnNotifications: [{ method: "session/closed", params: { reason: "hostShutdown" } }],
        omitTurnCompleted: true,
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.error).toContain("hostShutdown");
      expect(out.metadata.exitCode).not.toBe(0);
    });

    it("reports Muse's own stderr when the host dies before the turn", async () => {
      mockMuse({
        dieOnTurn: 1,
        stderr: "missing meta credentials: run `muse login` or set META_API_KEY\n",
      });

      const out = await adapter.run(makeInput());

      expect(out.metadata.error).toContain("missing meta credentials");
      expect(out.metadata.exitCode).not.toBe(0);
    });

    it("surfaces a protocol error from a rejected handshake", async () => {
      mockMuse({ errorOn: { method: "session/start", code: -32602, message: "invalid session/start commandId" } });

      const out = await adapter.run(makeInput());

      expect(out.metadata.error).toContain("commandId");
      expect(out.metadata.exitCode).not.toBe(0);
    });
  });

  describe("config materialization", () => {
    it("passes MCP servers over the wire in session/start, writing no config file", async () => {
      const requests = mockMuse();
      const input = makeInput({
        mcpServers: {
          local: { type: "stdio", command: "node", args: ["s.js"], env: { K: "v" } },
          remote: { type: "http", url: "https://example.com/mcp", headers: { A: "b" } },
        },
      });

      await adapter.run(input);

      const config = requests.find((r) => r.method === "session/start")!.params.config as Record<string, unknown>;
      // MSP discriminates on `transport`, NOT the Claude-style `type`. Sending
      // the Claude shape is rejected with "mcpServers does not match the
      // supported shape".
      expect(config.mcpServers).toEqual({
        local: { transport: "stdio", command: "node", args: ["s.js"], env: { K: "v" } },
        remote: { transport: "streamableHttp", url: "https://example.com/mcp", headers: { A: "b" } },
      });
      // Nothing is written to disk, so no settings file can leak into a run.
      expect(fs.existsSync(path.join(input.homeDirectory, ".config", "muse", "settings.json"))).toBe(false);
    });

    it("requests the sessionMcp capability only when servers are declared", async () => {
      const withServers = mockMuse();
      await adapter.run(makeInput({ mcpServers: { local: { type: "stdio", command: "node" } } }));
      const caps = (withServers.find((r) => r.method === "initialize")!.params.capabilities ?? {}) as Record<
        string,
        unknown
      >;
      expect(caps.requestedCapabilities).toEqual(["sessionMcp"]);

      vi.clearAllMocks();
      const without = mockMuse();
      await adapter.run(makeInput());
      const bare = (without.find((r) => r.method === "initialize")!.params.capabilities ?? {}) as Record<
        string,
        unknown
      >;
      expect(bare.requestedCapabilities).toBeUndefined();
    });

    it("fails clearly when the host refuses the sessionMcp capability", async () => {
      mockMuse({ denyCapabilities: ["sessionMcp"] });

      const out = await adapter.run(makeInput({ mcpServers: { local: { type: "stdio", command: "node" } } }));

      // Better than letting session/start fail with the host's opaque
      // "session MCP configuration requires the sessionMcp capability".
      expect(out.metadata.error).toContain("sessionMcp");
      expect(out.metadata.exitCode).not.toBe(0);
    });

    it("omits session config entirely when no MCP servers are declared", async () => {
      const requests = mockMuse();

      await adapter.run(makeInput());

      expect(requests.find((r) => r.method === "session/start")!.params.config).toBeUndefined();
    });

    it("installs skills under the config dir, which is where Muse looks", async () => {
      mockMuse();
      const skillSrc = path.join(tmpRoot, "src-skill");
      fs.mkdirSync(skillSrc, { recursive: true });
      fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "---\nname: greeter\n---\nhi");
      const input = makeInput({ resolvedSkills: [{ name: "greeter", path: skillSrc }] });

      await adapter.run(input);

      // `muse skills install --scope user` reports $CONFIG_DIR/skills/<id>,
      // NOT the XDG data dir, which is the easy path to get wrong.
      expect(fs.existsSync(path.join(input.homeDirectory, ".config", "muse", "skills", "greeter", "SKILL.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(input.homeDirectory, ".local", "share", "muse", "skills", "greeter"))).toBe(false);
    });
  });

  describe("robustness", () => {
    it("ignores non-JSON lines on stdout", async () => {
      const { proc } = createMspMockProcess({ turnNotifications: [agentMessage("ok")] });
      proc.stdout.push("muse: workspace root: /tmp/x\n");
      mockSpawn.mockReturnValue(proc as never);

      const out = await adapter.run(makeInput());

      expect(out.result).toBe("ok");
    });

    it("captures raw protocol lines when debug capture is on", async () => {
      mockMuse({ turnNotifications: [agentMessage("ok")] });

      const out = await adapter.run(makeInput({ captureRawOutput: true }));

      expect(out.rawOutput!.length).toBeGreaterThan(0);
      expect(out.rawOutput!.some((l) => l.includes("agentMessage"))).toBe(true);
    });
  });
});
