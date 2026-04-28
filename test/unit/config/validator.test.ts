import { describe, it, expect } from "vitest";
import { validateConfig, validateScenario, resolveRubricWeights } from "../../../src/config/validator.js";

describe("validateConfig", () => {
  it("accepts a valid config with string agents", () => {
    const config = {
      scenarios: "./scenarios",
      agents: ["claude-code"],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts a valid config with object agents", () => {
    const config = {
      scenarios: "./scenarios",
      agents: [{ adapter: "claude-code", scenarios: ["*"] }],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts mixed string and object agents", () => {
    const config = {
      scenarios: "./scenarios",
      agents: ["claude-code", { adapter: "claude-code", model: "sonnet" }],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateConfig("string", "test.json")).toThrow("must be a JSON object");
    expect(() => validateConfig(null, "test.json")).toThrow("must be a JSON object");
  });

  it("rejects missing scenarios field", () => {
    expect(() => validateConfig({ agents: [] }, "test.json")).toThrow('"scenarios" must be a string');
  });

  it("rejects missing agents field", () => {
    expect(() => validateConfig({ scenarios: "./s" }, "test.json")).toThrow('"agents" must be an array');
  });

  it("rejects non-array agents", () => {
    expect(() => validateConfig({ scenarios: "./s", agents: {} }, "test.json")).toThrow('"agents" must be an array');
  });

  it("rejects agent object without adapter", () => {
    const config = { scenarios: "./s", agents: [{}] };
    expect(() => validateConfig(config, "test.json")).toThrow('must have an "adapter" string');
  });

  it("rejects agent with non-array scenarios", () => {
    const config = {
      scenarios: "./s",
      agents: [{ adapter: "x", scenarios: "bad" }],
    };
    expect(() => validateConfig(config, "test.json")).toThrow("must be an array");
  });

  it("allows extra fields on agent objects", () => {
    const config = {
      scenarios: "./s",
      agents: [{ adapter: "x", model: "sonnet", custom_field: true }],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts valid settings.concurrency", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      settings: { concurrency: 4 },
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("rejects non-integer concurrency", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      settings: { concurrency: 2.5 },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("positive integer");
  });

  it("rejects zero concurrency", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      settings: { concurrency: 0 },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("positive integer");
  });

  it("rejects negative concurrency", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      settings: { concurrency: -1 },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("positive integer");
  });

  it("accepts valid stdio mcp_servers", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      mcp_servers: {
        fs: { type: "stdio", command: "npx", args: ["-y", "server"], env: { KEY: "val" } },
      },
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts valid http mcp_servers", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      mcp_servers: {
        remote: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer tok" } },
      },
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts mixed stdio and http mcp_servers", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      mcp_servers: {
        local: { type: "stdio", command: "node", args: ["server.js"] },
        remote: { type: "http", url: "https://mcp.example.com" },
      },
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("rejects non-object mcp_servers", () => {
    const config = { scenarios: "./s", agents: ["x"], mcp_servers: "bad" };
    expect(() => validateConfig(config, "test.json")).toThrow("must be an object");
  });

  it("rejects array mcp_servers", () => {
    const config = { scenarios: "./s", agents: ["x"], mcp_servers: [{ type: "stdio" }] };
    expect(() => validateConfig(config, "test.json")).toThrow("must be an object");
  });

  it("rejects mcp_servers entry with missing type", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { command: "echo" } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow('type must be "stdio" or "http"');
  });

  it("rejects mcp_servers entry with unknown type", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "sse", url: "http://x" } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow('type must be "stdio" or "http"');
  });

  it("rejects stdio mcp_server missing command", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "stdio" } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow('requires a "command" string');
  });

  it("rejects http mcp_server missing url", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "http" } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow('requires a "url" string');
  });

  it("rejects stdio mcp_server with non-string args", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "stdio", command: "x", args: [1, 2] } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("args must be an array of strings");
  });

  it("rejects stdio mcp_server with non-string env values", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "stdio", command: "x", env: { KEY: 42 } } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("env.KEY must be a string");
  });

  it("rejects http mcp_server with non-string headers", () => {
    const config = {
      scenarios: "./s",
      agents: ["x"],
      mcp_servers: { bad: { type: "http", url: "http://x", headers: { Auth: 42 } } },
    };
    expect(() => validateConfig(config, "test.json")).toThrow("headers.Auth must be a string");
  });

  it("accepts valid top-level skills", () => {
    const config = {
      scenarios: "./s",
      agents: ["claude-code"],
      skills: ["netlify/deploy-skill", "./local-skill"],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("accepts valid per-agent skills", () => {
    const config = {
      scenarios: "./s",
      agents: [{ adapter: "claude-code", skills: ["./skills/custom"] }],
    };
    expect(() => validateConfig(config, "test.json")).not.toThrow();
  });

  it("rejects non-array top-level skills", () => {
    const config = { scenarios: "./s", agents: ["x"], skills: "bad" };
    expect(() => validateConfig(config, "test.json")).toThrow('"skills" must be an array of strings');
  });

  it("rejects top-level skills with non-string elements", () => {
    const config = { scenarios: "./s", agents: ["x"], skills: ["valid", 42] };
    expect(() => validateConfig(config, "test.json")).toThrow('"skills" must be an array of strings');
  });

  it("rejects non-array per-agent skills", () => {
    const config = {
      scenarios: "./s",
      agents: [{ adapter: "x", skills: "bad" }],
    };
    expect(() => validateConfig(config, "test.json")).toThrow('"agents[0].skills" must be an array of strings');
  });

  it("rejects per-agent skills with non-string elements", () => {
    const config = {
      scenarios: "./s",
      agents: [{ adapter: "x", skills: [true] }],
    };
    expect(() => validateConfig(config, "test.json")).toThrow('"agents[0].skills" must be an array of strings');
  });
});

describe("validateScenario", () => {
  const validScenario = {
    name: "Test",
    prompt: "Do something",
    rubric: [{ check: "Did it?", weight: 1.0 }],
  };

  it("accepts a valid scenario", () => {
    expect(() => validateScenario(validScenario, "test.json")).not.toThrow();
  });

  it("accepts a scenario with setup and teardown", () => {
    const scenario = {
      ...validScenario,
      setup: [{ action: "run_script", command: "echo setup" }],
      teardown: [{ action: "run_script", command: "echo teardown" }],
    };
    expect(() => validateScenario(scenario, "test.json")).not.toThrow();
  });

  it("rejects missing name", () => {
    const { name: _name, ...rest } = validScenario;
    expect(() => validateScenario(rest, "test.json")).toThrow('"name"');
  });

  it("rejects missing prompt", () => {
    const { prompt: _prompt, ...rest } = validScenario;
    expect(() => validateScenario(rest, "test.json")).toThrow('"prompt"');
  });

  it("accepts a string rubric", () => {
    const scenario = { ...validScenario, rubric: "The agent should complete the task" };
    expect(() => validateScenario(scenario, "test.json")).not.toThrow();
  });

  it("rejects missing rubric", () => {
    const { rubric: _rubric, ...rest } = validScenario;
    expect(() => validateScenario(rest, "test.json")).toThrow('"rubric"');
  });

  it("rejects rubric of wrong type", () => {
    const scenario = { ...validScenario, rubric: 42 };
    expect(() => validateScenario(scenario, "test.json")).toThrow('"rubric"');
  });

  it("rejects rubric entry without check", () => {
    const scenario = { ...validScenario, rubric: [{ weight: 1.0 }] };
    expect(() => validateScenario(scenario, "test.json")).toThrow("rubric[0]");
  });

  it("accepts rubric entry without weight", () => {
    const scenario = { ...validScenario, rubric: [{ check: "x" }] };
    expect(() => validateScenario(scenario, "test.json")).not.toThrow();
  });

  it("rejects rubric entry with non-number weight", () => {
    const scenario = { ...validScenario, rubric: [{ check: "x", weight: "heavy" }] };
    expect(() => validateScenario(scenario, "test.json")).toThrow("weight must be a number");
  });

  it("accepts a scenario with agents override", () => {
    const scenario = { ...validScenario, agents: ["gemini", "claude-code"] };
    expect(() => validateScenario(scenario, "test.json")).not.toThrow();
  });

  it("rejects non-array agents", () => {
    const scenario = { ...validScenario, agents: "gemini" };
    expect(() => validateScenario(scenario, "test.json")).toThrow("non-empty array");
  });

  it("rejects empty agents array", () => {
    const scenario = { ...validScenario, agents: [] };
    expect(() => validateScenario(scenario, "test.json")).toThrow("non-empty array");
  });

  it("rejects agents with non-string elements", () => {
    const scenario = { ...validScenario, agents: ["gemini", 42] };
    expect(() => validateScenario(scenario, "test.json")).toThrow("agents[1] must be a string");
  });

  it("rejects setup with unknown action type", () => {
    const scenario = {
      ...validScenario,
      setup: [{ action: "unknown", command: "x" }],
    };
    expect(() => validateScenario(scenario, "test.json")).toThrow('must be "run_script"');
  });

  it("rejects setup action without command", () => {
    const scenario = {
      ...validScenario,
      setup: [{ action: "run_script" }],
    };
    expect(() => validateScenario(scenario, "test.json")).toThrow('"command"');
  });

  it("accepts a scenario with skills", () => {
    const scenario = { ...validScenario, skills: ["./local-skill", "owner/repo"] };
    expect(() => validateScenario(scenario, "test.json")).not.toThrow();
  });

  it("rejects non-array scenario skills", () => {
    const scenario = { ...validScenario, skills: "bad" };
    expect(() => validateScenario(scenario, "test.json")).toThrow('"skills" must be an array of strings');
  });

  it("rejects scenario skills with non-string elements", () => {
    const scenario = { ...validScenario, skills: ["valid", 42] };
    expect(() => validateScenario(scenario, "test.json")).toThrow('"skills" must be an array of strings');
  });
});

describe("resolveRubricWeights", () => {
  it("returns empty array unchanged", () => {
    expect(resolveRubricWeights([])).toEqual([]);
  });

  it("passes through entries that all have weights", () => {
    const rubric = [
      { check: "a", weight: 0.5 },
      { check: "b", weight: 0.5 },
    ];
    expect(resolveRubricWeights(rubric)).toEqual(rubric);
  });

  it("distributes equally when no entries have weights", () => {
    const rubric = [{ check: "a" }, { check: "b" }, { check: "c" }];
    const resolved = resolveRubricWeights(rubric);
    expect(resolved).toHaveLength(3);
    for (const r of resolved) {
      expect(r.weight).toBeCloseTo(1 / 3, 10);
    }
  });

  it("splits remaining weight among unweighted entries", () => {
    const rubric = [{ check: "a", weight: 0.5 }, { check: "b" }, { check: "c" }];
    const resolved = resolveRubricWeights(rubric);
    expect(resolved[0].weight).toBe(0.5);
    expect(resolved[1].weight).toBeCloseTo(0.25, 10);
    expect(resolved[2].weight).toBeCloseTo(0.25, 10);
  });

  it("gives zero to unweighted entries when specified weights sum to 1", () => {
    const rubric = [{ check: "a", weight: 1.0 }, { check: "b" }];
    const resolved = resolveRubricWeights(rubric);
    expect(resolved[0].weight).toBe(1.0);
    expect(resolved[1].weight).toBe(0);
  });

  it("clamps remaining at zero when specified weights exceed 1", () => {
    const rubric = [{ check: "a", weight: 0.7 }, { check: "b", weight: 0.5 }, { check: "c" }];
    const resolved = resolveRubricWeights(rubric);
    expect(resolved[2].weight).toBe(0);
  });

  it("is called by validateScenario to resolve weights in-place", () => {
    const scenario = {
      name: "test",
      prompt: "do the thing",
      rubric: [{ check: "a", weight: 0.4 }, { check: "b" }, { check: "c" }],
    };
    validateScenario(scenario, "test.json");
    const rubric = scenario.rubric as Array<{ check: string; weight: number }>;
    expect(rubric[0].weight).toBe(0.4);
    expect(rubric[1].weight).toBeCloseTo(0.3, 10);
    expect(rubric[2].weight).toBeCloseTo(0.3, 10);
  });
});
