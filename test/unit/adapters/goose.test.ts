import { describe, it, expect, beforeEach } from "vitest";
import { createGooseAdapter } from "../../../src/adapters/goose.js";
import { getAdapter, _resetAdapterCache } from "../../../src/adapters/registry.js";

describe("GooseAdapter", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("has name 'goose'", () => {
    const adapter = createGooseAdapter();
    expect(adapter.name).toBe("goose");
  });

  it("is retrievable from the adapter registry", () => {
    const adapter = getAdapter("goose");
    expect(adapter.name).toBe("goose");
  });

  it("has no requiredEnv (Goose manages its own provider config)", () => {
    const adapter = createGooseAdapter();
    expect(adapter.requiredEnv).toBeUndefined();
  });

  it("has no isolationEnv", () => {
    const adapter = createGooseAdapter();
    expect(adapter.isolationEnv).toBeUndefined();
  });
});
