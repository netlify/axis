---
name: configure-axis
description: Author AXIS (Agent Experience Index Score) scenarios and axis.config.json for a project. Use when the user asks to set up AXIS, add a scenario, write or edit axis.config.json, or evaluate an AI agent with AXIS.
---

# Configure AXIS

AXIS (Agent Experience Index Score) is a synthetic testing framework for AI agents. This skill teaches you to author the two files an AXIS user maintains:

1. **Scenarios** under `scenarios/` (or any path the config points at): one JSON file per task the agent will be asked to perform.
2. **`axis.config.json`** at the project root: which agents to run, where scenarios live, and what is shared across them.

## When to use this skill

Trigger phrases include "set up AXIS", "add an AXIS scenario", "write an axis.config.json", "evaluate my agent with AXIS", "score my agent on X".

Before authoring, do this:

1. Look for an existing `axis.config.json` (or `axis.config.{js,ts}`) at the project root. If one exists, read it; do not overwrite without confirmation.
2. List the existing scenarios directory if present. Match its naming and style.
3. If no config exists, suggest running `npx @netlify/axis init` first, or scaffold one yourself using the patterns below.

## Conceptual model

For each scenario, AXIS runs every configured agent against the same prompt in an isolated workspace, then scores each run on four dimensions and produces an HTML + JSON report.

- **Goal achievement** (default weight 0.4): did the agent satisfy the judge's checks?
- **Environment** (0.2): did filesystem / shell / network operations succeed reliably?
- **Service** (0.2): did external services (APIs, MCP servers) respond reliably?
- **Agent** (0.2): were the agent's decisions sound across every tool call?

Refer to the framework's output as the **AXIS Result**. The acronym expands to **Agent Experience Index Score**.

## Authoring a scenario

A scenario is a JSON file under the scenarios directory. The file path (without extension, relative to that directory) becomes the scenario's `key`. Only `name`, `prompt`, and `judge` are required.

> The annotated examples below are labeled `jsonc` for documentation only. They contain `// comments` and trailing commas. Real `.json` files do NOT support either. When copying these examples into output, strip every `//` comment line and every trailing comma. Plain JSON examples (in the Recipes section) are safe to copy verbatim.

Full annotated shape:

```jsonc
{
  // Display name shown in reports.
  "name": "Refactor utility module",

  // Set true to exclude this scenario from runs without deleting it.
  "skip": false,

  // Run before the agent starts. Two action types: run_script and copy.
  "setup": [
    { "action": "run_script", "command": "git init -q && git add -A && git commit -q -m init" },
    { "action": "copy", "match": "fixtures/sample-repo/**", "destination": "." },
  ],

  // The task. Be specific and verifiable.
  "prompt": "Refactor src/utils.js to split it into two files: src/strings.js and src/numbers.js. Update all import sites and ensure `npm test` still passes.",

  // Judge: either a single string OR an array of weighted checks.
  // Use the array form for multi-criterion scoring. Weight is optional;
  // remaining weight is distributed equally across unweighted entries.
  "judge": [
    { "check": "src/strings.js exists and exports the string utilities", "weight": 0.3 },
    { "check": "src/numbers.js exists and exports the numeric utilities", "weight": 0.3 },
    { "check": "All import sites are updated and reference the new files", "weight": 0.2 },
    { "check": "`npm test` passes after the change", "weight": 0.2 },
  ],

  // Run after the agent finishes, before scoring.
  "teardown": [{ "action": "run_script", "command": "rm -rf node_modules" }],

  // Only these agents run this scenario. Overrides the top-level agents list.
  "agents": ["claude-code"],

  // Skills passed to the agent under test. Each entry is a local path,
  // GitHub shorthand (owner/repo), or a full GitHub URL.
  "skills": ["./skills/repo-conventions", "anthropics/skills"],

  // MCP servers available to the agent for this scenario only. Merged
  // with the top-level mcp_servers from axis.config.json.
  "mcp_servers": {
    "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  },

  // Per-scenario time/token limits. Defaults: 15 minutes, no token cap.
  "limits": { "time_minutes": 10, "tokens": 200000 },

  // Glob patterns (relative to the workspace) of files to capture into the
  // report after teardown. Merged with the top-level artifacts list.
  "artifacts": ["src/**/*.js", "test-output.log"],
}
```

### Judge: string vs weighted array

- **String** when one statement captures the whole pass/fail bar: `"The agent should have written summary.md with at least three sentences."`
- **Weighted array** when there are multiple checks the agent could partially satisfy. Each entry has a `check` (the statement) and an optional `weight` (sum your weights to 1.0; unweighted entries split the remainder evenly).

Write checks as **observable facts a third party could verify**, not vibes. "Agent wrote a file named `summary.md` with at least three sentences" beats "Agent did a good job summarizing".

### Lifecycle actions

Two action types are allowed in `setup` and `teardown`:

- `{ "action": "run_script", "command": "<shell command>" }`: runs with the agent's workspace as cwd. Available env vars include `AXIS_PHASE` (`setup`/`teardown`), `AXIS_WORKSPACE`, and `AXIS_OUTPUT` (a file path where the script can append markdown that will surface in the report).
- `{ "action": "copy", "match": "<glob>", "destination": "<workspace-relative path>" }`: copies files matching `match` (resolved relative to the config file) into `destination` (relative to the workspace). The path of each matched file relative to the longest non-glob prefix of `match` is preserved under `destination`.

### Variants

When a scenario should run multiple times with small differences, define `variants`. The parent does not run by itself; each variant inherits all parent fields and may override `prompt`, `judge`, `setup`, `teardown`, `agents`, `skills`, `mcp_servers`, `limits`, `artifacts`, or `skip`.

```jsonc
{
  "name": "Summarize the docs",
  "prompt": "Summarize the contents of docs/ into summary.md.",
  "judge": "summary.md exists and is at least 200 words.",
  "variants": [
    { "name": "baseline" },
    { "name": "concise", "prompt": "Summarize the contents of docs/ into summary.md in fewer than 100 words." },
  ],
}
```

Each variant's key is `{scenarioKey}@{variantName}`. Variant names must match `/^[a-zA-Z0-9_-]+$/`.

## Authoring `axis.config.json`

Sits at the project root. Minimum viable file:

```json
{
  "scenarios": "./scenarios",
  "agents": ["claude-code"]
}
```

Full annotated shape:

```jsonc
{
  // Shown in report headers.
  "name": "My Project",

  // Where scenarios come from. Three forms:
  //  - "./path" (a directory, walked recursively for *.json scenarios)
  //  - ["./path1", "./scenarios/special.json"] (mix of dirs and single files)
  //  - Mixed with inline scenarios (objects with a required "key" field) when
  //    authoring axis.config.{js,ts} programmatically.
  //  - Git URLs ("https://github.com/owner/repo") cloned into .axis/remotes/
  //    and merged from their own axis.config.
  // Defaults to "./scenarios" when omitted.
  "scenarios": ["./scenarios", "https://github.com/netlify/agent-runner-orchestrator"],

  // Agents to evaluate. Strings are shorthand for { "agent": "<name>" }.
  "agents": [
    "claude-code",
    { "agent": "claude-code", "model": "claude-opus-4-6" },
    { "agent": "codex", "model": "gpt-5-codex" },
    {
      "agent": "echo", // custom adapter (see "adapters" below)
      "command": "./bin/my-agent", // CLI override for custom adapters
      "scenarios": ["hello-world"], // restrict this agent to a subset (scenario keys)
      "skills": ["./skills/my-conventions"], // per-agent skills
      "flags": { "debug": true, "max-turns": "5" },
    },
  ],

  // Agents used to score runs. When omitted, each agent judges itself
  // (it scores its own transcript). Otherwise the first entry whose adapter
  // name differs from the run's own agent is picked; if every entry matches,
  // the first entry is used. Order is precedence.
  "judging": {
    "agents": [{ "agent": "claude-code", "model": "claude-opus-4-7" }, "codex"],
  },

  // MCP servers shared across all agents and all scenarios. Two types:
  // stdio (local subprocess) and http (remote endpoint).
  "mcp_servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "DEBUG": "1" },
    },
    "search": {
      "type": "http",
      "url": "https://mcp.example.com/search",
      "headers": { "Authorization": "Bearer ${SEARCH_TOKEN}" },
    },
  },

  // Skills shared across all agents. Each entry is one of:
  //  - local path: "./skills/my-skill"
  //  - GitHub shorthand: "anthropics/skills"
  //  - GitHub URL: "https://github.com/anthropics/skills"
  "skills": ["./skills/repo-conventions"],

  // Glob patterns (relative to each scenario's workspace) of files captured
  // into the report after teardown. Merged with per-scenario artifacts.
  "artifacts": ["./*.md", "src/**/*.js"],

  // Custom adapters. Keys are adapter names referenced by "agents" entries;
  // values are paths (relative to this config) to JS/TS modules that export
  // an AgentAdapter as default or as `adapter`.
  "adapters": { "echo": "./adapters/echo.ts" },

  // Extra env vars allowed through to agent processes. PATH, HOME, and the
  // default agent API keys (ANTHROPIC_API_KEY, CODEX_API_KEY, GEMINI_API_KEY)
  // pass through automatically; entries here are merged on top.
  "env": ["GITHUB_TOKEN", "MY_FEATURE_FLAG"],

  // Run-wide settings.
  "settings": {
    "concurrency": 8,
    "limits": {
      "run": { "time_minutes": 60, "tokens": 5000000 },
      "scenario": { "time_minutes": 10, "tokens": 200000 },
    },
    "remotes": { "maxDepth": 1 },
  },

  // CLI-only lifecycle hooks. beforeAll runs once before any scenarios start;
  // afterAll runs once after every scenario is scored. Scripts execute with
  // cwd set to the config directory. afterAll receives AXIS_REPORT_DIR,
  // AXIS_TOTAL, AXIS_COMPLETED, AXIS_FAILED, AXIS_DURATION_MS as env vars.
  // These are not fired by the programmatic run() API.
  "beforeAll": [{ "action": "run_script", "command": "npm install --silent" }],
  "afterAll": [{ "action": "run_script", "command": "echo Report at $AXIS_REPORT_DIR" }],
}
```

### Built-in adapters

- `claude-code`: Anthropic Claude Code CLI. Requires `ANTHROPIC_API_KEY`.
- `codex`: OpenAI Codex CLI. Requires `CODEX_API_KEY`.
- `gemini`: Google Gemini CLI. Requires `GEMINI_API_KEY`.

Any other name in `agents[].agent` must be declared in the `adapters` map and point to a module that exports an `AgentAdapter`.

### Judging precedence

For each run, AXIS finds a judge by scanning `judging.agents` in order and picking the first entry whose adapter name differs from the agent being scored. If every entry matches, the first entry is used. When `judging` is omitted, the run's own agent judges itself.

## Recipes

### Minimal scenario

```json
{
  "name": "Hello world",
  "prompt": "Say hello.",
  "judge": "The agent should say hello."
}
```

### Realistic scenario with setup, weighted judge, and teardown

```json
{
  "name": "Debug and fix a broken script",
  "setup": [
    {
      "action": "run_script",
      "command": "mkdir -p /tmp/demo && echo 'function add(a, b) { return a - b; }' > /tmp/demo/add.js"
    }
  ],
  "prompt": "There is a JavaScript file at /tmp/demo/add.js with a bug. Run it, fix it, and verify the fix.",
  "judge": [
    { "check": "Agent ran the script and observed the wrong output", "weight": 0.25 },
    { "check": "Agent identified the subtraction-instead-of-addition bug", "weight": 0.25 },
    { "check": "Agent fixed the bug in the file", "weight": 0.25 },
    { "check": "Agent re-ran the script and confirmed correct output", "weight": 0.25 }
  ],
  "teardown": [{ "action": "run_script", "command": "rm -rf /tmp/demo" }]
}
```

### Multi-agent comparison config

```json
{
  "scenarios": "./scenarios",
  "agents": [
    { "agent": "claude-code", "model": "claude-sonnet-4-6" },
    { "agent": "claude-code", "model": "claude-opus-4-6" },
    "codex"
  ],
  "judging": {
    "agents": [{ "agent": "claude-code", "model": "claude-opus-4-7" }]
  }
}
```

### Custom adapter wiring

Module `adapters/echo.ts`:

```ts
import { createAgentAdapter } from "@netlify/axis";

export default createAgentAdapter<{ stdout: string }>({
  name: "echo",
  resolveCommand: () => ({ command: "echo", prefixArgs: [] }),
  buildArgs: (input) => [input.prompt],
  initialState: () => ({ stdout: "" }),
  streamConfig: {
    mode: "aggregate",
    onChunk: (chunk, ctx) => {
      ctx.state.stdout += chunk;
    },
  },
  getResult: (ctx) => ({ result: ctx.state.stdout.trim() || null }),
});
```

`axis.config.json`:

```json
{
  "adapters": { "echo": "./adapters/echo.ts" },
  "scenarios": "./scenarios",
  "agents": [{ "agent": "echo" }]
}
```

## Reading AXIS reports

For interpreting reports, comparing runs, finding regressions, or explaining scores, use the companion skill `using-axis`. It covers the report file layout, dimension semantics, calibration, and citation rules in depth. This skill stays focused on authoring.

## Rules you must follow

1. Refer to the score as the **AXIS Result**, never "AXIS Score" (which reads as "score score"). The acronym is **Agent Experience Index Score**, never "eXperience".
2. Do not use em dashes in any prose, comment, or judge check you author. Use a comma, semicolon, colon, parenthesis, or a new sentence instead.
3. Do not invent fields. The authoritative schemas live at `src/types/scenario.ts` and `src/types/config.ts` in the netlify/axis repo. If you are unsure whether a field exists, omit it and tell the user where to look.
4. Judge checks must be specific and verifiable. Prefer "Agent wrote a file named X with property Y" over "Agent did well at the task".
5. The default per-scenario time limit is 15 minutes. Only override it when the task warrants a different ceiling.
6. For `skills` entries, pick the simplest form that works: prefer a local path during development, GitHub shorthand (`owner/repo`) for public skills, full URLs only when needed.
7. When `judge` is a weighted array, sum your weights to 1.0 (or leave some unweighted to split the remainder; do not exceed 1.0).
8. Variant names match `/^[a-zA-Z0-9_-]+$/`. Scenario keys are derived from the file path; do not set `key` for file-based scenarios.
9. `beforeAll` and `afterAll` only fire from the CLI. Do not rely on them when the user runs AXIS programmatically via `run()`.
10. In an isolated AXIS scenario workspace, do NOT try to verify your authored file by executing it, importing it, or cross-checking it against an installed copy of `@netlify/axis`. The workspace is intentionally minimal: no `node_modules`, no git history. That means: no `tsc`, no `node -e "require(...)"`, no `git diff` or `git status`, no `npm install`, and no reading or grepping the globally-installed `@netlify/axis` package outside the workspace (paths like `/usr/local/lib/node_modules/@netlify/axis`, `/opt/homebrew/.../node_modules/@netlify/axis`, or any `node_modules/@netlify/axis` you did not put there yourself). Every such command fails or wastes interactions and tanks the environment and agent dimensions. Write the file once, correctly, against the schema you already know from this skill. The AXIS judge inspects your output directly; you do not need to prove it works first.
11. When asked to make a targeted edit (add a field, fix a single bug), edit ONLY what the prompt specifies. Do not reorganize, reformat, or add unrelated fields. Preserve every field the prompt did not name. The judge often checks "original X and Y fields are preserved unchanged".
12. Minimize unnecessary tool calls. Every tool call is evaluated as an agent decision; redundant `ls`, repeated `cat` of the same file, exploratory `find` that you do not act on, all tank the agent dimension via the `necessity` sub-dimension. Read each file you need once. Write each edit once. Stop when the task is done.
13. Field-name discipline. AXIS uses snake_case in all JSON config fields: `mcp_servers` not `mcpServers`, `time_minutes` not `timeMinutes`, `run_script` not `runScript` or `shell`. The deprecated alias `rubric` exists for backwards compat; prefer `judge`. Other commonly-invented names that are WRONG: `criteria`, `success_criteria`, `expected`, `tasks`, `evaluators`, `models`, `timeout`, `maxTokens`, `tokenLimit`, `timeoutMinutes`.

## Validation

After authoring or editing, ask the user to run:

```
npx @netlify/axis run --help
```

to confirm the CLI is installed, then:

```
npx @netlify/axis run
```

The config loader validates the file on load and prints actionable errors (missing required fields, unknown adapter names, malformed limits, invalid skill sources, etc.). Fix any reported errors before declaring the work done.

## Reference

- Documentation site: https://axis.run
- Scenario schema: `src/types/scenario.ts` in the netlify/axis repo
- Config schema: `src/types/config.ts` in the netlify/axis repo
- Validator (source of truth for accepted shapes): `src/config/validator.ts`

## Installing this skill

To make this skill available to your AI tool in a project, drop it under `.claude/skills/`:

```
mkdir -p .claude/skills/configure-axis
curl -fsSL https://raw.githubusercontent.com/netlify/axis/main/skills/configure-axis/SKILL.md \
  -o .claude/skills/configure-axis/SKILL.md
```
