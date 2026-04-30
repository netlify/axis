import type { AxisConfig } from "../types/config.js";
import type { RubricCriterion, Scenario } from "../types/scenario.js";

export function validateConfig(data: unknown, filePath: string): asserts data is AxisConfig {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid config at ${filePath}: must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.scenarios !== "string") {
    throw new Error(`Invalid config at ${filePath}: "scenarios" must be a string path`);
  }

  if (!Array.isArray(obj.agents)) {
    throw new Error(`Invalid config at ${filePath}: "agents" must be an array`);
  }

  for (let i = 0; i < obj.agents.length; i++) {
    const entry = obj.agents[i];
    if (typeof entry === "string") continue;

    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Invalid config at ${filePath}: agents[${i}] must be a string or object`);
    }
    const agentObj = entry as Record<string, unknown>;
    if (typeof agentObj.adapter !== "string") {
      throw new Error(`Invalid config at ${filePath}: agents[${i}] must have an "adapter" string`);
    }
    if (agentObj.scenarios !== undefined && !Array.isArray(agentObj.scenarios)) {
      throw new Error(`Invalid config at ${filePath}: agents[${i}].scenarios must be an array`);
    }
    if (agentObj.skills !== undefined) {
      validateSkillsSources(agentObj.skills, filePath, `agents[${i}].skills`);
    }
  }

  if (obj.env !== undefined) {
    if (!Array.isArray(obj.env) || !obj.env.every((v: unknown) => typeof v === "string")) {
      throw new Error(`Invalid config at ${filePath}: "env" must be an array of strings`);
    }
  }

  const settings = obj.settings as Record<string, unknown> | undefined;
  if (settings?.concurrency !== undefined) {
    const c = settings.concurrency;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1) {
      throw new Error(`Invalid config at ${filePath}: "settings.concurrency" must be a positive integer`);
    }
  }

  if (obj.mcp_servers !== undefined) {
    validateMcpServers(obj.mcp_servers, filePath);
  }

  if (obj.skills !== undefined) {
    validateSkillsSources(obj.skills, filePath, "skills");
  }
}

export function validateScenario(data: unknown, filePath: string): asserts data is Scenario {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid scenario at ${filePath}: must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.name !== "string") {
    throw new Error(`Invalid scenario at ${filePath}: missing required field "name"`);
  }
  if (typeof obj.prompt !== "string") {
    throw new Error(`Invalid scenario at ${filePath}: missing required field "prompt"`);
  }
  if (typeof obj.rubric === "string") {
    // String rubric — freeform evaluation description
  } else if (Array.isArray(obj.rubric)) {
    for (let i = 0; i < obj.rubric.length; i++) {
      const entry = obj.rubric[i] as Record<string, unknown>;
      if (typeof entry.check !== "string") {
        throw new Error(`Invalid scenario at ${filePath}: rubric[${i}] missing "check" string`);
      }
      if (entry.weight !== undefined && typeof entry.weight !== "number") {
        throw new Error(`Invalid scenario at ${filePath}: rubric[${i}].weight must be a number`);
      }
    }
    // Resolve weights so downstream code always has them
    obj.rubric = resolveRubricWeights(obj.rubric as RubricCriterion[]);
  } else {
    throw new Error(`Invalid scenario at ${filePath}: "rubric" must be a string or array`);
  }

  if (obj.skip !== undefined && typeof obj.skip !== "boolean") {
    throw new Error(`Invalid scenario at ${filePath}: "skip" must be a boolean`);
  }

  if (obj.agents !== undefined) {
    if (!Array.isArray(obj.agents) || obj.agents.length === 0) {
      throw new Error(`Invalid scenario at ${filePath}: "agents" must be a non-empty array of strings`);
    }
    for (let i = 0; i < obj.agents.length; i++) {
      if (typeof obj.agents[i] !== "string") {
        throw new Error(`Invalid scenario at ${filePath}: agents[${i}] must be a string`);
      }
    }
  }

  if (obj.skills !== undefined) {
    validateSkillsSources(obj.skills, filePath, "skills");
  }

  if (obj.setup !== undefined) {
    validateLifecycleActions(obj.setup, filePath, "setup");
  }
  if (obj.teardown !== undefined) {
    validateLifecycleActions(obj.teardown, filePath, "teardown");
  }
}

function validateMcpServers(data: unknown, filePath: string): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Invalid config at ${filePath}: "mcp_servers" must be an object`);
  }

  const servers = data as Record<string, unknown>;
  for (const [name, server] of Object.entries(servers)) {
    if (typeof server !== "object" || server === null) {
      throw new Error(`Invalid config at ${filePath}: mcp_servers.${name} must be an object`);
    }

    const s = server as Record<string, unknown>;
    if (s.type !== "stdio" && s.type !== "http") {
      throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.type must be "stdio" or "http"`);
    }

    if (s.type === "stdio") {
      if (typeof s.command !== "string") {
        throw new Error(`Invalid config at ${filePath}: mcp_servers.${name} (stdio) requires a "command" string`);
      }
      if (s.args !== undefined) {
        if (!Array.isArray(s.args) || !s.args.every((a: unknown) => typeof a === "string")) {
          throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.args must be an array of strings`);
        }
      }
      if (s.env !== undefined) {
        if (typeof s.env !== "object" || s.env === null || Array.isArray(s.env)) {
          throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.env must be an object`);
        }
        for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
          if (typeof v !== "string") {
            throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.env.${k} must be a string`);
          }
        }
      }
    }

    if (s.type === "http") {
      if (typeof s.url !== "string") {
        throw new Error(`Invalid config at ${filePath}: mcp_servers.${name} (http) requires a "url" string`);
      }
      if (s.headers !== undefined) {
        if (typeof s.headers !== "object" || s.headers === null || Array.isArray(s.headers)) {
          throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.headers must be an object`);
        }
        for (const [k, v] of Object.entries(s.headers as Record<string, unknown>)) {
          if (typeof v !== "string") {
            throw new Error(`Invalid config at ${filePath}: mcp_servers.${name}.headers.${k} must be a string`);
          }
        }
      }
    }
  }
}

function validateSkillsSources(data: unknown, filePath: string, field: string): void {
  if (!Array.isArray(data) || !data.every((v: unknown) => typeof v === "string")) {
    throw new Error(`Invalid config at ${filePath}: "${field}" must be an array of strings`);
  }
}

/**
 * Resolve optional weights on rubric entries. Entries with explicit weights
 * keep them; entries without a weight split the remaining budget equally.
 * If no entries have weights, each gets `1 / n`.
 */
export function resolveRubricWeights(rubric: RubricCriterion[]): RubricCriterion[] {
  if (rubric.length === 0) return rubric;

  const specified = rubric.filter((r) => r.weight !== undefined);
  const unspecified = rubric.filter((r) => r.weight === undefined);

  if (unspecified.length === 0) return rubric;

  const usedWeight = specified.reduce((sum, r) => sum + r.weight!, 0);
  const remaining = Math.max(0, 1.0 - usedWeight);
  const share = unspecified.length > 0 ? remaining / unspecified.length : 0;

  return rubric.map((r) => (r.weight !== undefined ? r : { ...r, weight: share }));
}

function validateLifecycleActions(data: unknown, filePath: string, field: string): void {
  if (!Array.isArray(data)) {
    throw new Error(`Invalid scenario at ${filePath}: "${field}" must be an array`);
  }
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;
    if (entry.action !== "run_script") {
      throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}].action must be "run_script"`);
    }
    if (typeof entry.command !== "string") {
      throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}] missing "command" string`);
    }
  }
}
