import { describe, it, expect, beforeEach } from "vitest";
import { getAdapter, _resetAdapterCache, getBuiltinAdapterNames } from "../../../src/adapters/registry.js";

interface ExpectedAdapter {
  name: string;
  requiredEnv?: string[];
  /** If set, isolationEnv() must yield these keys (workspace="/tmp/ws"). */
  expectIsolationKeys?: string[];
}

const cases: ExpectedAdapter[] = [
  { name: "codex-sdk", requiredEnv: ["OPENAI_API_KEY"] },
  { name: "opencode" },
  {
    name: "qwen-code",
    expectIsolationKeys: ["QWEN_CODE_HOME", "QWEN_TELEMETRY_ENABLED"],
  },
  { name: "stakpak" },
  { name: "blackbox", requiredEnv: ["BLACKBOX_API_KEY"] },
  { name: "fast-agent" },
  { name: "mistral-vibe", requiredEnv: ["MISTRAL_API_KEY"] },
  { name: "factory-droid", requiredEnv: ["FACTORY_API_KEY"] },
  { name: "poolside", requiredEnv: ["POOLSIDE_API_KEY"] },
  {
    name: "vtcode",
    expectIsolationKeys: ["VT_ACP_ENABLED", "VT_ACP_ZED_ENABLED"],
  },
  { name: "cursor-agent", requiredEnv: ["CURSOR_API_KEY"] },
  { name: "auggie", requiredEnv: ["AUGMENT_SESSION_AUTH"] },
  { name: "kimi" },
  { name: "openhands" },
  { name: "cline" },
  { name: "kiro-cli" },
  { name: "kilo" },
  { name: "qoder", requiredEnv: ["QODER_PERSONAL_ACCESS_TOKEN"] },
  { name: "copilot" },
];

describe("ACP-based built-in adapters", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("registers every adapter as a built-in", () => {
    const builtins = new Set(getBuiltinAdapterNames());
    for (const { name } of cases) {
      expect(builtins.has(name), `expected ${name} in built-ins`).toBe(true);
    }
  });

  for (const { name, requiredEnv, expectIsolationKeys } of cases) {
    describe(name, () => {
      it("is retrievable from the adapter registry", () => {
        const adapter = getAdapter(name);
        expect(adapter.name).toBe(name);
      });

      it(`${requiredEnv ? "requires" : "does not enforce"} env vars`, () => {
        const adapter = getAdapter(name);
        if (requiredEnv) {
          expect(adapter.requiredEnv?.()).toEqual(requiredEnv);
        } else {
          expect(adapter.requiredEnv).toBeUndefined();
        }
      });

      if (expectIsolationKeys) {
        it("provides expected isolationEnv keys", () => {
          const adapter = getAdapter(name);
          const env = adapter.isolationEnv?.("/tmp/ws") ?? {};
          for (const key of expectIsolationKeys) {
            expect(env, `${name} isolationEnv missing ${key}`).toHaveProperty(key);
          }
        });
      }
    });
  }
});
