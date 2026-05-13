import type { AxisConfig } from "../types/config.js";
import type { RubricCriterion, Scenario } from "../types/scenario.js";

export function validateConfig(data: unknown, filePath: string): asserts data is AxisConfig {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid config at ${filePath}: must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  validateScenariosField(obj.scenarios, filePath);

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
    if (typeof agentObj.agent !== "string") {
      throw new Error(`Invalid config at ${filePath}: agents[${i}] must have an "agent" string`);
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

  if (settings?.limits !== undefined) {
    const limits = settings.limits as Record<string, unknown>;
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      throw new Error(`Invalid config at ${filePath}: "settings.limits" must be an object`);
    }
    if (limits.run !== undefined) {
      validateLimits(limits.run, filePath, "settings.limits.run");
    }
    if (limits.scenario !== undefined) {
      validateLimits(limits.scenario, filePath, "settings.limits.scenario");
    }
  }

  if (obj.mcp_servers !== undefined) {
    validateMcpServers(obj.mcp_servers, filePath);
  }

  if (obj.skills !== undefined) {
    validateSkillsSources(obj.skills, filePath, "skills");
  }

  if (obj.artifacts !== undefined) {
    validateArtifactPatterns(obj.artifacts, filePath, "artifacts");
  }
}

function validateScenariosField(data: unknown, filePath: string): void {
  if (data === undefined) return; // optional — loader fills in the default
  if (typeof data === "string") return;

  if (!Array.isArray(data)) {
    throw new Error(
      `Invalid config at ${filePath}: "scenarios" must be a string path or an array of paths and/or scenario objects`,
    );
  }

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (typeof entry === "string") continue;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Invalid config at ${filePath}: scenarios[${i}] must be a string path or a scenario object`);
    }
    validateScenario(entry, `${filePath} (scenarios[${i}])`, "inline");
  }
}

/**
 * Validates a scenario object.
 *
 * @param mode  "file" — loaded from a JSON scenario file; the loader will assign
 *              the `key` from the file path and rejects any user-supplied `key`.
 *              "inline" — declared inline in `axis.config.*`; the user must
 *              provide a non-empty `key` string.
 */
export function validateScenario(
  data: unknown,
  filePath: string,
  mode: "file" | "inline" = "file",
): asserts data is Scenario {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid scenario at ${filePath}: must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (mode === "inline") {
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      throw new Error(`Invalid scenario at ${filePath}: inline scenarios must include a non-empty "key" string`);
    }
  } else if (obj.key !== undefined) {
    // File-mode: an explicit `key` is allowed (helpers like `withSharedVariants` may
    // require it on their input), but it must be a non-empty string. The loader
    // verifies it matches the path-derived key — see finalizeScenarioObject in loader.ts.
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      throw new Error(`Invalid scenario at ${filePath}: "key" must be a non-empty string`);
    }
  }

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

  if (obj.mcp_servers !== undefined) {
    validateMcpServers(obj.mcp_servers, filePath);
  }

  if (obj.limits !== undefined) {
    validateLimits(obj.limits, filePath, "limits");
  }

  if (obj.setup !== undefined) {
    validateLifecycleActions(obj.setup, filePath, "setup");
  }
  if (obj.teardown !== undefined) {
    validateLifecycleActions(obj.teardown, filePath, "teardown");
  }

  if (obj.artifacts !== undefined) {
    validateArtifactPatterns(obj.artifacts, filePath, "artifacts");
  }

  if (obj.variants !== undefined) {
    validateVariants(obj.variants, filePath);
  }
}

const VARIANT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateVariants(data: unknown, filePath: string): void {
  if (!Array.isArray(data)) {
    throw new Error(`Invalid scenario at ${filePath}: "variants" must be an array`);
  }

  const names = new Set<string>();

  for (let i = 0; i < data.length; i++) {
    const variant = data[i] as Record<string, unknown>;

    if (typeof variant !== "object" || variant === null) {
      throw new Error(`Invalid scenario at ${filePath}: variants[${i}] must be an object`);
    }

    if (typeof variant.name !== "string" || !VARIANT_NAME_RE.test(variant.name)) {
      throw new Error(
        `Invalid scenario at ${filePath}: variants[${i}].name must be a string matching /^[a-zA-Z0-9_-]+$/`,
      );
    }

    if (names.has(variant.name)) {
      throw new Error(`Invalid scenario at ${filePath}: duplicate variant name "${variant.name}"`);
    }
    names.add(variant.name);

    if (variant.prompt !== undefined && typeof variant.prompt !== "string") {
      throw new Error(`Invalid scenario at ${filePath}: variants[${i}].prompt must be a string`);
    }

    if (variant.rubric !== undefined) {
      if (typeof variant.rubric === "string") {
        // String rubric — freeform evaluation description
      } else if (Array.isArray(variant.rubric)) {
        for (let j = 0; j < variant.rubric.length; j++) {
          const entry = variant.rubric[j] as Record<string, unknown>;
          if (typeof entry.check !== "string") {
            throw new Error(`Invalid scenario at ${filePath}: variants[${i}].rubric[${j}] missing "check" string`);
          }
          if (entry.weight !== undefined && typeof entry.weight !== "number") {
            throw new Error(`Invalid scenario at ${filePath}: variants[${i}].rubric[${j}].weight must be a number`);
          }
        }
        variant.rubric = resolveRubricWeights(variant.rubric as RubricCriterion[]);
      } else {
        throw new Error(`Invalid scenario at ${filePath}: variants[${i}].rubric must be a string or array`);
      }
    }

    if (variant.skip !== undefined && typeof variant.skip !== "boolean") {
      throw new Error(`Invalid scenario at ${filePath}: variants[${i}].skip must be a boolean`);
    }

    if (variant.agents !== undefined) {
      if (!Array.isArray(variant.agents) || variant.agents.length === 0) {
        throw new Error(`Invalid scenario at ${filePath}: variants[${i}].agents must be a non-empty array of strings`);
      }
      for (let j = 0; j < variant.agents.length; j++) {
        if (typeof variant.agents[j] !== "string") {
          throw new Error(`Invalid scenario at ${filePath}: variants[${i}].agents[${j}] must be a string`);
        }
      }
    }

    if (variant.skills !== undefined) {
      validateSkillsSources(variant.skills, filePath, `variants[${i}].skills`);
    }

    if (variant.mcp_servers !== undefined) {
      validateMcpServers(variant.mcp_servers, filePath);
    }

    if (variant.setup !== undefined) {
      validateLifecycleActions(variant.setup, filePath, `variants[${i}].setup`);
    }
    if (variant.teardown !== undefined) {
      validateLifecycleActions(variant.teardown, filePath, `variants[${i}].teardown`);
    }

    if (variant.limits !== undefined) {
      validateLimits(variant.limits, filePath, `variants[${i}].limits`);
    }

    if (variant.artifacts !== undefined) {
      validateArtifactPatterns(variant.artifacts, filePath, `variants[${i}].artifacts`);
    }
  }
}

export function validateMcpServers(data: unknown, filePath: string): void {
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

function validateLimits(data: unknown, filePath: string, field: string): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Invalid config at ${filePath}: "${field}" must be an object`);
  }
  const obj = data as Record<string, unknown>;

  if (obj.time_minutes !== undefined) {
    if (typeof obj.time_minutes !== "number" || obj.time_minutes <= 0) {
      throw new Error(`Invalid config at ${filePath}: "${field}.time_minutes" must be a positive number`);
    }
  }
  if (obj.tokens !== undefined) {
    if (typeof obj.tokens !== "number" || !Number.isInteger(obj.tokens) || obj.tokens <= 0) {
      throw new Error(`Invalid config at ${filePath}: "${field}.tokens" must be a positive integer`);
    }
  }
}

function validateArtifactPatterns(data: unknown, filePath: string, field: string): void {
  if (!Array.isArray(data) || !data.every((v: unknown) => typeof v === "string" && v.length > 0)) {
    throw new Error(`Invalid config at ${filePath}: "${field}" must be an array of non-empty glob strings`);
  }
}

function validateLifecycleActions(data: unknown, filePath: string, field: string): void {
  if (!Array.isArray(data)) {
    throw new Error(`Invalid scenario at ${filePath}: "${field}" must be an array`);
  }
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;
    if (entry.action === "run_script") {
      if (typeof entry.command !== "string") {
        throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}] missing "command" string`);
      }
    } else if (entry.action === "copy") {
      if (typeof entry.match !== "string" || entry.match.length === 0) {
        throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}] missing non-empty "match" string`);
      }
      if (typeof entry.destination !== "string" || entry.destination.length === 0) {
        throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}] missing non-empty "destination" string`);
      }
    } else {
      throw new Error(`Invalid scenario at ${filePath}: ${field}[${i}].action must be "run_script" or "copy"`);
    }
  }
}
