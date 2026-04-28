# AXIS — Agent eXperience Index Score

AXIS is a synthetic testing framework for measuring how well systems support AI agent interaction. Think [Lighthouse](https://developer.chrome.com/docs/lighthouse), but instead of scoring user experience, AXIS scores **agent experience**.

Given a scenario, an agent, and a prompt — AXIS runs the agent, captures a full transcript of the interaction, and produces a graded score across multiple dimensions.

## Why AXIS

The web has Lighthouse. APIs have contract testing. Performance has k6. But there's no standardized way to answer: _"How well does my system work when an AI agent tries to use it?"_

As agents become a primary interface for interacting with websites, APIs, and developer platforms, the systems they interact with need to be measured and optimized for that experience — just like we optimize for page load time or accessibility.

AXIS provides:

- **A universal score** for agent experience across any target system
- **Repeatable, synthetic tests** that can run in CI or on a schedule
- **Agent-agnostic execution** — plug in Claude Code, Codex CLI, or any agent that implements the adapter contract
- **A grading system** that combines user-defined rubrics with automatically measured signals

## Quick Start

```bash
npm install @netlify/axis
```

Create an `axis.config.json`:

```json
{
  "scenarios": "./scenarios",
  "agents": ["claude-code"]
}
```

Create a scenario file at `scenarios/hello-world.json`:

```json
{
  "name": "Hello World",
  "prompt": "Navigate to https://example.com and describe what you see on the page.",
  "rubric": [
    { "check": "Agent visited the target URL", "weight": 0.5 },
    { "check": "Agent provided a description of the page content", "weight": 0.5 }
  ]
}
```

Run it:

```bash
axis run
```

AXIS will execute the scenario, score the results, and display a live summary. Reports are automatically saved to `.axis/reports/` for later review.

## Configuration

`axis.config.json` is the project-level config. It defines which agents to run and where to find scenarios.

```json
{
  "scenarios": "./scenarios",
  "agents": [
    "claude-code",
    {
      "adapter": "claude-code",
      "model": "sonnet",
      "scenarios": ["hello-world", "cms/*"],
      "flags": {
        "dangerously-skip-permissions": true
      }
    }
  ],
  "env": ["ANTHROPIC_API_KEY", "MY_API_TOKEN"],
  "defaults": {
    "scoring_weights": {
      "goal_achievement": 0.4,
      "environment": 0.2,
      "service": 0.2,
      "agent": 0.2
    }
  }
}
```

| Field                      | Required | Description                                                                                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarios`                | yes      | Path to the scenarios directory (relative to config file)                                                                             |
| `agents`                   | yes      | Array of agents to run. Each entry is a string (adapter name) or an agent config object                                               |
| `adapters`                 | no       | Custom adapter modules. Keys are names, values are paths to JS/TS modules. See [Custom Adapters](#custom-adapters)                    |
| `env`                      | no       | Environment variable names to pass through to agent processes. Defaults to `["ANTHROPIC_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY"]` |
| `mcp_servers`              | no       | MCP servers available to all agents. See [MCP Servers](#mcp-servers)                                                                  |
| `skills`                   | no       | Skills available to all agents. See [Skills](#skills)                                                                                 |
| `defaults.concurrency`     | no       | Maximum parallel jobs. Defaults to unlimited (all jobs run simultaneously)                                                            |
| `defaults.scoring_weights` | no       | Weights for the composite AXIS result. Defaults to `0.4 / 0.2 / 0.2 / 0.2` (goal / env / svc / agent)                                 |

### Agent Config

When an agent entry is an object, it supports these fields:

| Field       | Required | Description                                                                     |
| ----------- | -------- | ------------------------------------------------------------------------------- |
| `adapter`   | yes      | Adapter type (`"claude-code"`, `"codex"`, `"gemini"`, or a custom adapter name) |
| `command`   | no       | Executable command for custom adapters (e.g. `"aider"`, `"./my-agent.sh"`)      |
| `model`     | no       | Model override passed to the adapter                                            |
| `scenarios` | no       | Subset of scenarios to run. Supports exact keys and glob patterns (`"cms/*"`)   |
| `skills`    | no       | Per-agent skills (merged with top-level `skills`). See [Skills](#skills)        |
| `flags`     | no       | Adapter-specific CLI flags (e.g. `{"dangerously-skip-permissions": true}`)      |

Multiple entries with the same adapter are auto-named: `claude-code`, `claude-code-2`, etc.

### Agent Isolation

AXIS runs every scenario job in a fully isolated environment. This ensures results are reproducible regardless of where you run them — your local machine, a colleague's laptop, or CI.

**Workspace** — Each job gets its own temporary directory. Setup scripts, agent execution, and teardown all run inside this workspace. It is automatically cleaned up after the job completes.

**HOME** — The `HOME` environment variable points to the job's workspace, not your real home directory. This prevents agents from picking up user-specific configuration (e.g. `~/.claude/settings.json`, `~/.claude/CLAUDE.md`) that would cause results to differ between machines.

**Environment variables** — Agent processes receive a minimal set of environment variables:

- **System variables** (always included): `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`
- **User-configured variables** (via `env`): defaults to `["ANTHROPIC_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY"]`

Everything else from the host environment is stripped. To pass additional variables (e.g. API tokens needed by setup scripts), add them to `env`:

```json
{
  "env": ["ANTHROPIC_API_KEY", "MY_SERVICE_TOKEN", "DATABASE_URL"]
}
```

#### Claude Code Isolation

The `claude-code` adapter sets these additional defaults to prevent the Claude CLI from loading host configuration:

| Variable                          | Default               | Purpose                                                    |
| --------------------------------- | --------------------- | ---------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`               | `<workspace>/.claude` | Config discovery uses the clean workspace, not `~/.claude` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`                   | No memory side effects between runs                        |
| `DISABLE_AUTOUPDATER`             | `1`                   | No update checks during test execution                     |
| `DISABLE_TELEMETRY`               | `1`                   | No telemetry from synthetic test runs                      |

To override any of these defaults, add the variable to `env` and set it in your shell environment before running `axis run`. Variables in `env` take precedence over adapter defaults.

### MCP Servers

MCP (Model Context Protocol) servers give agents access to external tools during execution. Servers are defined at the top level of `axis.config.json` and are available to **all** agents — every agent gets the same set of tools so they're tested on equal footing.

Two transport types are supported:

- **stdio** — Spawns a local process that communicates over stdin/stdout
- **http** — Connects to a remote MCP server over HTTP

```json
{
  "scenarios": "./scenarios",
  "agents": ["claude-code", "gemini", "codex"],
  "mcp_servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "LOG_LEVEL": "info" }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/tools",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
  }
}
```

| Field     | Type                  | Required | Description                                  |
| --------- | --------------------- | -------- | -------------------------------------------- |
| `type`    | `"stdio"` or `"http"` | yes      | Transport type                               |
| `command` | string                | stdio    | Command to spawn                             |
| `args`    | string[]              | no       | Arguments for the command                    |
| `env`     | object                | no       | Environment variables for the server process |
| `url`     | string                | http     | URL of the remote MCP endpoint               |
| `headers` | object                | no       | HTTP headers (e.g. authentication)           |

AXIS writes the appropriate native config file for each adapter before spawning the agent:

- **Claude Code**: `.mcp.json` in the workspace root (project-scoped)
- **Codex**: `config.toml` in `CODEX_HOME`
- **Gemini**: `settings.json` in `GEMINI_CLI_HOME`

MCP server processes inherit the agent's environment. If a server needs env vars not in the default passthrough list, either add them to the server's `env` field or to the top-level `env` array.

### Skills

Skills augment what agents can do during test runs. They follow the [SKILL.md standard](https://github.com/anthropics/claude-code/blob/main/SKILLS.md) — each skill is a directory containing a `SKILL.md` file and optional supporting files (scripts, references, assets).

Skills can be defined at the top level (shared across all agents) or per-agent (via `AgentConfig.skills`). Both are merged at runtime — top-level first, then per-agent, deduplicated.

```json
{
  "scenarios": "./scenarios",
  "agents": ["claude-code", { "adapter": "codex", "skills": ["./skills/codex-specific"] }],
  "skills": ["netlify/axis-skill-deploy", "./skills/custom-lint"]
}
```

Three source formats are supported:

| Format           | Example                                          | Resolution                                         |
| ---------------- | ------------------------------------------------ | -------------------------------------------------- |
| Local path       | `"./skills/deploy"`                              | Resolved relative to the config file directory     |
| GitHub shorthand | `"netlify/axis-skill-deploy"`                    | Cloned from `github.com/netlify/axis-skill-deploy` |
| GitHub URL       | `"https://github.com/netlify/axis-skill-deploy"` | Cloned from the URL                                |

Skills are resolved once during pre-flight and copied into each adapter's native discovery path before spawning the agent:

| Adapter     | Discovery Path                       | Notes                               |
| ----------- | ------------------------------------ | ----------------------------------- |
| Claude Code | `{workspace}/.claude/skills/{name}/` | Native Claude Code skill discovery  |
| Codex       | `{workspace}/.agents/skills/{name}/` | Native Codex skill discovery        |
| Gemini      | `{GEMINI_CLI_HOME}/skills/{name}/`   | Native Gemini CLI skill discovery   |
| CLI         | _(skipped)_                          | No native skill discovery mechanism |

Skills are purely environmental — AXIS copies the skill directory as-is without modifying content or altering the agent's prompt. The `.git`, `.github`, and `node_modules` directories are excluded from copies.

**Caching**: Remote skills (GitHub shorthand and URLs) are cached in `.axis/skills-cache/`. Use `--refresh-skills` to force a re-clone.

**SKILL.md discovery**: AXIS looks for `SKILL.md` at the root of the resolved directory. If not found, it checks one level of subdirectories (for repos where the skill lives in a subdirectory).

## Scenarios

A scenario is the complete unit of test. It defines the prompt, rubric, and any setup/teardown needed. Scenarios live as individual `.json` files in the configured scenarios directory.

```json
{
  "name": "Create a new blog post via CMS",

  "setup": [{ "action": "run_script", "command": "npm run seed -- fixtures/empty-blog.json" }],

  "prompt": "Navigate to the CMS at https://cms.example.com. Create a new blog post titled \"Hello World\" with at least two paragraphs of content. Publish it and verify it appears on the public site.",

  "rubric": [
    { "check": "Blog post exists on public site", "weight": 0.5 },
    { "check": "Post has title 'Hello World'", "weight": 0.25 },
    { "check": "Post contains at least two paragraphs", "weight": 0.25 }
  ],

  "teardown": [{ "action": "run_script", "command": "npm run cleanup -- fixtures/empty-blog.json" }]
}
```

| Field      | Required | Description                                                                         |
| ---------- | -------- | ----------------------------------------------------------------------------------- |
| `name`     | yes      | Human-readable scenario title                                                       |
| `prompt`   | yes      | Task description for the agent                                                      |
| `rubric`   | yes      | Success criteria — either a freeform string or an array of checks (weight optional) |
| `setup`    | no       | Lifecycle actions to run before the agent executes                                  |
| `teardown` | no       | Lifecycle actions to run after scoring completes                                    |
| `agents`   | no       | When set, only these agents run this scenario (overrides the global agents list)    |

### Agent Override

A scenario can specify which agents should run it. When the `agents` field is present, it completely overrides the global agents list — only the named agents are paired with that scenario.

```json
{
  "name": "Gemini-specific test",
  "prompt": "Test something that only Gemini supports",
  "rubric": "Verify it works",
  "agents": ["gemini"]
}
```

Agent names match the adapter name in the config (e.g. `"claude-code"`, `"gemini"`, `"codex"`). Scenarios without the `agents` field run with all configured agents as usual.

### Rubric Formats

**Array rubric** — each check is scored independently by the LLM judge. Weights are optional — unweighted checks split the remaining budget equally:

```json
"rubric": [
  { "check": "Blog post exists on public site", "weight": 0.5 },
  { "check": "Post has title 'Hello World'", "weight": 0.25 },
  { "check": "Post contains at least two paragraphs", "weight": 0.25 }
]
```

**String rubric** — freeform description evaluated holistically by the LLM judge:

```json
"rubric": "The agent should create a blog post with the title 'Hello World' containing at least two paragraphs of content, and verify it appears on the public site."
```

### Scenario Keys

Scenario keys are derived from their file path relative to the scenarios directory. For example:

- `scenarios/hello-world.json` → `hello-world`
- `scenarios/cms/create-post.json` → `cms/create-post`

### Lifecycle Actions

Setup and teardown support `run_script` actions that execute shell commands. Commands run in the job's isolated workspace directory. Teardown runs **after** scoring completes, so the LLM judge can verify resources before they're cleaned up.

## CLI Reference

### `axis run`

Run scenarios against configured agents.

```bash
axis run [options]
```

| Option                      | Description                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>`       | Path to axis.config.json (default: `axis.config.json`)                                                               |
| `-s, --scenario <key>`      | Run a specific scenario by key (e.g. `hello-world`, `cms/create-post`)                                               |
| `-a, --agent <name>`        | Run with a specific agent only                                                                                       |
| `--json`                    | Output results as JSON to stdout (no live display)                                                                   |
| `--concurrency <n>`         | Max parallel jobs (default: unlimited). Overrides `defaults.concurrency`                                             |
| `-v, --verbose`             | Show detailed per-step logging                                                                                       |
| `--debug`                   | Show debug output (workspace paths, env, lifecycle)                                                                  |
| `-o, --output-dir <dir>`    | Also write `axis-report-[timestamp].json` to this directory                                                          |
| `--no-score`                | Skip scoring (raw results only, saves LLM cost)                                                                      |
| `--refresh-skills`          | Force re-clone of cached remote skills                                                                               |
| `--compare-baseline [name]` | Compare results against a baseline after scoring (default: `default`). Exits with code 1 if regressions are detected |

In interactive mode, AXIS renders a live display showing scenario progress, scoring status, and per-job AXIS results. Each agent row shows a ticking elapsed-time timer and a smooth count-up token estimate (e.g. `(12.3s) ~1,234 tok`) — tokens are conservative by design so the displayed number never has to reverse, and both values remain visible once the job completes. When all jobs complete, the final summary persists in the terminal.

Reports are automatically saved to `.axis/reports/` on every run.

### `axis reports`

View past AXIS reports.

```bash
axis reports [reportId] [scenarioKey] [options]
```

| Argument / Option       | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `[reportId]`            | Report ID or `latest` (omit to list all)                                  |
| `[scenarioKey]`         | Drill into a specific scenario's detailed result                          |
| `-c, --config <path>`   | Path to axis.config.json (default: `axis.config.json`)                    |
| `-a, --agent <name...>` | Filter scenario detail to specific agent(s), repeatable (defaults to all) |
| `--json`                | Output as JSON                                                            |
| `-n, --limit <count>`   | Max reports to list (default: `10`)                                       |

Examples:

```bash
axis reports                                          # List recent reports
axis reports latest                                   # View most recent report summary
axis reports 2025-04-13-183042                        # View specific report
axis reports latest hello-world                       # View all agents for a scenario
axis reports latest hello-world -a codex              # View result for a specific agent
axis reports latest hello-world -a codex -a claude-code  # View results for multiple agents
```

## Scoring

AXIS scores every run across **four independent dimensions**, each measuring a different aspect of the agent's interaction. The dimensions roll up into a composite **AXIS Result** (0–100).

| Dimension            | What it measures                          | How                                     |
| -------------------- | ----------------------------------------- | --------------------------------------- |
| **Goal Achievement** | Did the agent accomplish the task?        | LLM judge evaluates against your rubric |
| **Environment**      | OS/filesystem/tooling interaction quality | Interaction audit + category scoring    |
| **Service**          | Service/API interaction quality           | Interaction audit + category scoring    |
| **Agent**            | Agent reasoning/planning quality          | Interaction audit + category scoring    |

### Goal Achievement _(LLM-judged)_

An LLM judge evaluates the agent's transcript and final result against the user-defined rubric.

- **Array rubric**: Each check is scored 0–10, weighted, and normalized to 0–100
- **String rubric**: The judge produces a single holistic 0–10 score, scaled to 0–100

The judge has full context: the scenario prompt, a condensed transcript, and the agent's final result. It is instructed to independently verify claimed outcomes when possible (e.g. visiting URLs, checking endpoints).

**How the judge is invoked:** The judge runs using the **same adapter and config** as the agent being evaluated — same CLI, same model, same flags. For example, if a scenario runs with `claude-code` using `claude-sonnet-4-5-20250929`, the judge also spawns `claude` with that model. This means scoring requires the agent's underlying CLI to be capable of returning structured JSON in response to the judge prompt. The built-in adapters (`claude-code`, `codex`, `gemini`) all work out of the box. Custom adapters will work as long as the underlying agent can follow the judge's instructions and return valid JSON.

> **Note:** A dedicated `judge` config (to use a different adapter/model for scoring) is on the roadmap but not yet supported. For now, consider using a capable model in your agent config if scoring accuracy is important.

### Environment, Service & Agent _(interaction-based)_

Every transcript entry is classified into one of three categories:

- **Environment**: OS, filesystem, and dev tooling — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, git, npm, pip, cargo, etc.
- **Agent**: Internal agent operations — `assistant` entries (thinking/planning), `system` entries
- **Service**: Everything else — `WebFetch`, `WebSearch`, MCP tools, API calls, any tool use not classified as environment

Each category is scored through a multi-step evaluation pipeline:

1. **Sparse index** — The full transcript is compressed into a scannable reference (~10 KB vs 50 KB+ raw). Each interaction gets a one-line summary with its category, tool name, outcome, size, and duration.

2. **Triage** _(LLM call)_ — The sparse index is sent to a judge that flags up to 30 interactions for deep review and identifies patterns (retry loops, redundant calls, wasted reasoning).

3. **Deep evaluation** _(LLM call)_ — All interactions are sent with full content to a judge that scores each on three dimensions:
   - **Success** (0–1): Did it complete without errors?
   - **Weight** (0–1): Was the context size proportional to what was needed?
   - **Context relevance** (0–1): How much of the information was actionable?

   **Speed** (0–1) is computed heuristically from interaction duration — no LLM needed. Thresholds are calibrated per category (environment operations are expected to be near-instant, service calls get more tolerance for network latency).

   The judge also evaluates **necessity** per category: were all interactions needed, or were some unnecessary?

   Interactions the LLM does not evaluate receive default scores (`success: 1.0, speed: 1.0, weight: 1.0, relevance: 1.0`).

4. **Category scoring** — Per-category dimension scores are aggregated and folded with the necessity judgment, then mapped through a log-normal CDF to produce a 0–100 score. The log-normal mapping means bad-to-mediocre improvement scores more than good-to-great. Speed uses a severity-weighted average so that slow outliers pull the score down disproportionately rather than being hidden by many fast interactions. Other dimensions are weighted by context size.

### Composite AXIS Result

```
AXIS Result = Goal Achievement × 0.40 + Environment × 0.20 + Service × 0.20 + Agent × 0.20
```

Weights are configurable via `defaults.scoring_weights` in the config. Use `--no-score` to skip scoring entirely and get raw results only.

### Scoring Pipeline

Scoring runs **in parallel with execution**. As each job completes, its result is immediately scored while other jobs continue running. The scoring pipeline makes 3 LLM calls per run: goal achievement, triage, and deep evaluation. The triage and goal achievement calls run in parallel, then deep eval runs with the triage results. Teardown only runs after scoring finishes, so the LLM judge can verify deployed resources.

### Token Usage

AXIS reports token usage at two levels: a **live estimate** during execution and the **exact count** after the agent finishes.

**Live estimate** — During a run, AXIS estimates tokens from the agent's stdout stream using a conservative `chars / 5` ratio. This drives the `~1,234 tok` counter in the live display. The estimate intentionally underestimates so the counter never has to reverse. Only text that flows through stdout is counted — the agent's system prompt, tool definitions, and input context are invisible to this estimator.

**Exact count** — After the agent process exits, the adapter reads the real token usage from the CLI's final output event and reports it as `metadata.tokenUsage`. This is the authoritative number stored in reports. The live counter animates up to this final value.

| Adapter       | Token source               | Fields reported                     |
| ------------- | -------------------------- | ----------------------------------- |
| `claude-code` | `result` event → `usage`   | `input`, `output`, `cacheReadInput` |
| `codex`       | `turn.completed` → `usage` | `input`, `output`, `cacheReadInput` |
| `gemini`      | `result` event → `stats`   | `input`, `output`                   |

**Baseline system prompt overhead** — Agent CLIs inject their own system prompts (coding persona, tool definitions, safety rules) before your scenario prompt reaches the model. This means every run has a baseline input token cost regardless of prompt length. For example, Gemini CLI uses ~14,000 input tokens and Codex ~10,000 input tokens just for system prompt overhead on a trivial prompt. These tokens are real API cost but are not visible in the AXIS stdout stream — they appear only in the final `tokenUsage` numbers. Keep this in mind when comparing token counts across agents: differences in input tokens often reflect system prompt size rather than agent behavior.

## Reports

Every `axis run` automatically writes a structured report to `.axis/reports/`.

```
.axis/reports/
  2025-04-13-183042/
    report.json                        # Lightweight manifest (no transcripts)
    scenarios/
      hello-world/
        claude-code.json               # Full result + transcript + scores
      cms/create-post/
        claude-code.json
```

**`report.json`** contains the summary, per-result scores, duration, and token usage — everything needed to render a summary table without loading full transcripts.

**`scenarios/{key}/{agent}.json`** contains the complete result including the full transcript, rubric, prompt, and scoring rationale. This is what you see when drilling into a specific scenario with `axis reports <id> <scenarioKey>`.

**`scenarios/{key}/{agent}.raw.ndjson`** — When `--debug` is enabled, the raw NDJSON lines from the agent's stdout are written alongside the scenario result. This is useful for debugging adapter parsing issues — you can diff the raw CLI output against the parsed transcript.

**`scenarios/{key}/{agent}.sparse-index.txt`** — When `--debug` is enabled and scoring is active, the sparse index used for triage and deep evaluation is written as a human-readable text file. Each line represents one interaction with its category, type, and outcome — useful for understanding how the scoring pipeline classified and evaluated the agent's work.

Report IDs are UTC timestamps in `YYYY-MM-DD-HHmmss` format (e.g. `2025-04-13-183042`).

Reports are local artifacts — consider adding `.axis/reports/` and `.axis/skills-cache/` to your `.gitignore`. If you use baselines (see [Baselines](#baselines)), keep `.axis/baselines/` tracked so your team shares the same regression targets.

## Baselines

Baselines are snapshots of AXIS results that you can compare future runs against. They're the foundation for regression detection — if a code change causes an agent's score to drop, the baseline diff will flag it.

Most projects only need one baseline, so baseline commands default to a single baseline named `default`. You can pass an explicit name for multi-baseline workflows (e.g. one per model version or per branch).

Baselines are **accumulated**. Running `axis run -s hello-world` and setting that as a baseline only updates `hello-world` entries — previously stored scenarios are preserved. This means you can build up a baseline incrementally across multiple focused runs.

Baselines are stored at `.axis/baselines/{name}.json` and are designed to be committed to version control so your team shares the same regression targets.

### `axis baseline set`

Create or update a baseline from a report.

```bash
axis baseline set [name] [options]
```

| Option                | Description                               |
| --------------------- | ----------------------------------------- |
| `--from <reportId>`   | Use a specific report (default: `latest`) |
| `-c, --config <path>` | Path to axis.config.json                  |

```bash
axis run                           # Generate a scored report
axis baseline set                  # Save latest report as the default baseline
axis run -s hello-world            # Run a single scenario
axis baseline set                  # Updates only hello-world, preserves others

# Multi-baseline workflows:
axis baseline set claude-4         # Save as a named baseline
axis baseline set gemini-2         # Keep a separate baseline per model
```

### `axis baseline list`

List all baselines with their scenario/agent counts.

```bash
axis baseline list
```

### `axis baseline show`

Display the contents of a baseline.

```bash
axis baseline show [name] [--json]
```

### `axis baseline diff`

Compare a report against a baseline. Exits with code 1 if any regressions are detected.

```bash
axis baseline diff [name] [options]
```

| Option                | Description                                   |
| --------------------- | --------------------------------------------- |
| `--report <reportId>` | Compare a specific report (default: `latest`) |
| `--json`              | Output diff as JSON                           |
| `-c, --config <path>` | Path to axis.config.json                      |

Only scenarios and agents present in **both** the baseline and report are compared. New scenarios (in the report but not the baseline) are counted as informational. Missing scenarios (in the baseline but not the report) are ignored — partial runs don't trigger regressions.

A noise tolerance of 1 point applies: score deltas of 0 or 1 are classified as "unchanged".

### `axis baseline delete`

Delete a baseline.

```bash
axis baseline delete [name]
```

### Comparing on Run

Use `--compare-baseline` with `axis run` to automatically diff after scoring:

```bash
axis run --compare-baseline            # Diff against the default baseline
axis run --compare-baseline=claude-4   # Diff against a named baseline
```

This runs the scenarios, scores them, saves the report, then diffs against the baseline. If any regressions are found, the command exits with code 1 — useful for CI gating.

## Agent Adapters

AXIS is agent-agnostic. Any agent can be used as long as its adapter implements the `AgentAdapter` interface.

### CLI Resolution

The built-in adapters (`claude-code`, `codex`, `gemini`) automatically resolve their CLI tools at startup. If the CLI is installed globally or available on `PATH`, AXIS uses it directly. If not, AXIS falls back to `npx` to download and run the package on demand. This means you don't need to install agent CLIs globally — AXIS handles it for you.

| Adapter       | CLI Command | npx Package                 |
| ------------- | ----------- | --------------------------- |
| `claude-code` | `claude`    | `@anthropic-ai/claude-code` |
| `codex`       | `codex`     | `@openai/codex`             |
| `gemini`      | `gemini`    | `@google/gemini-cli`        |

Custom adapters handle their own command resolution — see [Custom Adapters](#custom-adapters).

### Adapter Interface

```typescript
interface AgentAdapter {
  readonly name: string;
  run(input: AgentInput): Promise<AgentOutput>;
}

interface AgentInput {
  prompt: string;
  config: AgentConfig;
  scenario: Scenario;
  workingDirectory: string;
  env?: Record<string, string>;
  registerCleanup?: (fn: () => void) => void;
}

interface AgentOutput {
  transcript: TranscriptEntry[];
  result: string | null;
  metadata: {
    startTime: string;
    endTime: string;
    durationMs: number;
    tokenUsage?: { input: number; output: number; cacheReadInput?: number };
    totalCostUsd?: number;
    exitCode: number;
    sessionId?: string;
    error?: string;
  };
}

interface TranscriptEntry {
  type: "assistant" | "user" | "tool_use" | "tool_result" | "system" | "error";
  timestamp: string;
  content: Record<string, unknown>;
}
```

### Built-in: Claude Code Adapter

The `claude-code` adapter spawns the `claude` CLI with `--output-format stream-json --verbose`. It parses the NDJSON stream from stdout, maps events to `TranscriptEntry` format, and captures metadata (tokens, timing, cost, exit code).

Adapter-specific flags can be passed via the `flags` config:

```json
{
  "adapter": "claude-code",
  "model": "sonnet",
  "flags": {
    "dangerously-skip-permissions": true
  }
}
```

The `dangerously-skip-permissions` flag defaults to `true` for automated testing.

### Custom Adapters

AXIS supports custom adapters for testing any CLI-based agent. Create an adapter module using the `createAgentAdapter` factory, declare it in your config, and reference it in your agents.

**1. Create the adapter module** (`adapters/my-agent.ts`):

```typescript
import { createAgentAdapter } from "@netlify/axis";

// The type parameter defines the shape of per-run mutable state that your
// streamConfig handlers and getResult callback share.
export default createAgentAdapter<{ stdout: string }>({
  // Unique name for this adapter — used in logs and error messages.
  name: "my-agent",

  // How to find the CLI binary. Return the command and any prefix args
  // (e.g. from npx resolution). Omit to use the built-in npx fallback
  // with `cliCommand`, or to read `command` from the agent config at runtime.
  resolveCommand: () => ({ command: "my-agent-cli", prefixArgs: [] }),

  // Build the CLI arguments for the agent process. Receives the full AgentInput
  // so you can read the prompt, config flags, model, etc.
  buildArgs: (input) => {
    const args: string[] = [];
    const flags = input.config.flags ?? {};
    for (const [key, value] of Object.entries(flags)) {
      if (value === true) args.push(`--${key}`);
      else if (value !== false) args.push(`--${key}`, String(value));
    }
    args.push(input.prompt);
    return args;
  },

  // Factory that creates a fresh state object for each run. This state is
  // passed to streamConfig handlers and getResult so they can accumulate
  // data across the agent's output stream.
  initialState: () => ({ stdout: "" }),

  // How to process the agent's stdout stream. Two modes:
  //   "aggregate" — raw chunks, good for plain-text CLI output
  //   "lines"     — one line at a time, good for NDJSON-streaming agents
  streamConfig: {
    mode: "aggregate",
    onChunk: (chunk, ctx) => {
      ctx.state.stdout += chunk;
    },
  },

  // Called after the agent process exits. Build the final result string
  // and optionally push transcript entries or return metadata overrides.
  // Return { result: null } when the agent produced no usable output.
  getResult: (ctx) => {
    const result = ctx.state.stdout.trim() || null;
    if (result) {
      ctx.transcript.push({
        type: "assistant",
        timestamp: ctx.endTime.toISOString(),
        content: { text: result },
      });
    }
    return { result };
  },
});
```

**2. Declare in config** (`axis.config.json`):

```json
{
  "adapters": {
    "my-agent": "./adapters/my-agent.ts"
  },
  "scenarios": "./scenarios",
  "agents": [{ "adapter": "my-agent" }]
}
```

Adapter paths are resolved relative to the config file. The module must export a valid `AgentAdapter` as its default export or a named `adapter` export.

**3. Run as usual:**

```bash
npx @netlify/axis run
```

The `aggregate` mode in `streamConfig` captures raw stdout as the result and produces a minimal transcript — a single `assistant` entry. For richer transcripts (tool use, reasoning, token usage), use `lines` mode with NDJSON parsing. See the built-in adapters for examples.

For programmatic registration (without config), use the `registerAdapter` export:

```typescript
import { registerAdapter, createAgentAdapter } from "@netlify/axis";

const adapter = createAgentAdapter({
  /* spec */
});
registerAdapter("my-agent", adapter);
```

### Built-in: Codex Adapter

The `codex` adapter spawns `codex exec --json` and parses the NDJSON event stream. It maps Codex events (`item.started`, `item.completed`, `turn.completed`, etc.) to `TranscriptEntry` format, extracts the final `agent_message` as the result, and captures token usage from `turn.completed` events.

```json
{
  "adapter": "codex",
  "model": "o4-mini",
  "flags": {
    "full-auto": true,
    "sandbox": "workspace-write"
  }
}
```

The `full-auto` flag defaults to `true` for automated testing.

#### Codex Isolation

The `codex` adapter sets these environment defaults to prevent loading host configuration:

| Variable                  | Default              | Purpose                                               |
| ------------------------- | -------------------- | ----------------------------------------------------- |
| `CODEX_HOME`              | `<workspace>/.codex` | Config/state uses the clean workspace, not `~/.codex` |
| `CODEX_DISABLE_TELEMETRY` | `1`                  | No telemetry from synthetic test runs                 |

#### Codex Event Mapping

| Codex Event                                                 | Transcript Type       | Notes                             |
| ----------------------------------------------------------- | --------------------- | --------------------------------- |
| `item.completed` (agent_message)                            | `assistant`           | Final text extracted as result    |
| `item.started` (command_execution)                          | `tool_use`            | Command about to run              |
| `item.completed` (command_execution)                        | `tool_result`         | Command output                    |
| `item.completed` (reasoning)                                | `assistant`           | Agent reasoning                   |
| `item.completed` (file_changes, web_search, mcp_tool_calls) | `tool_result`         | Tool outputs                      |
| `error` / `turn.failed`                                     | `error`               | Error events                      |
| `turn.completed`                                            | _(not in transcript)_ | Token usage extracted to metadata |

### Built-in: Gemini Adapter

The `gemini` adapter spawns the `gemini` CLI (Google's Gemini CLI) with `--output-format stream-json` and parses the NDJSON event stream. It maps Gemini events to `TranscriptEntry` format, extracts the final assistant message as the result, and captures token usage from the `result` event.

```json
{
  "adapter": "gemini",
  "model": "gemini-2.5-pro",
  "flags": {
    "yolo": true,
    "sandbox": "docker"
  }
}
```

The `yolo` flag defaults to `true` for automated testing (auto-approves all tool actions).

**Requirements:** Set `GEMINI_API_KEY` (from Google AI Studio). The Gemini CLI is resolved automatically (see [CLI Resolution](#cli-resolution)).

#### Gemini Isolation

The `gemini` adapter sets these environment defaults to prevent loading host configuration:

| Variable                   | Default               | Purpose                                                |
| -------------------------- | --------------------- | ------------------------------------------------------ |
| `GEMINI_CLI_HOME`          | `<workspace>/.gemini` | Config/state uses the clean workspace, not `~/.gemini` |
| `GEMINI_TELEMETRY_ENABLED` | `false`               | No telemetry from synthetic test runs                  |

The adapter also writes `settings.json` into `GEMINI_CLI_HOME` with context discovery disabled:

```json
{
  "context": {
    "discoveryMaxDirs": 0,
    "memoryBoundaryMarkers": []
  }
}
```

This prevents Gemini from scanning the workspace directory tree on startup. Without it, Gemini will explore the project structure before addressing the prompt, adding unnecessary tool calls and latency — especially noticeable in AXIS workspaces which are ephemeral temp directories with no meaningful project structure. MCP server configuration is merged into the same `settings.json` when configured.

#### Gemini Event Mapping

| Gemini Event               | Transcript Type       | Notes                                      |
| -------------------------- | --------------------- | ------------------------------------------ |
| `message` (role=assistant) | `assistant`           | Last assistant message extracted as result |
| `message` (role=user)      | `tool_result`         | User messages (typically tool outputs)     |
| `tool_use`                 | `tool_use`            | Tool invocation with parameters            |
| `tool_result`              | `tool_result`         | Tool output with status                    |
| `error`                    | `error`               | Error events with severity                 |
| `init`                     | _(not in transcript)_ | Session ID extracted to metadata           |
| `result`                   | _(not in transcript)_ | Token usage extracted to metadata          |

## Programmatic API

`@netlify/axis` exports its core functionality for use as a library:

```typescript
import {
  // Core execution
  run,

  // Configuration
  loadConfig,
  discoverScenarios,

  // Scoring
  scoreResults,
  scoreRunResult,
  buildScoredOutput,
  buildSparseIndex,
  categorizeInteraction,

  // Transcript
  normalizeTranscript,
  toTranscriptAnalysis,

  // Reports
  writeReportToStore,
  listReports,
  readReport,
  readScenarioResult,

  // Baselines
  setBaseline,
  readBaseline,
  listBaselines,
  deleteBaseline,
  diffBaseline,
  DEFAULT_BASELINE_NAME,

  // Adapters
  getAdapter,
  registerAdapter,
  createAgentAdapter,
} from "@netlify/axis";
```

### Running scenarios programmatically

```typescript
import { run } from "@netlify/axis";

const output = await run({
  configPath: "axis.config.json",
  scenarioFilter: ["hello-world"],
  agentFilter: ["claude-code"],
  onResult: async (result) => {
    // Called per-job as each completes (before teardown)
    console.log(`${result.scenarioKey}: ${result.output.result}`);
  },
});

console.log(`Completed: ${output.summary.completed}/${output.summary.total}`);
```

### Scoring results

```typescript
import { run, scoreResults } from "@netlify/axis";

const output = await run({ configPath: "axis.config.json" });
const scored = await scoreResults(output, {
  weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
});

console.log(`Average AXIS Result: ${scored.summary.averageAxisScore}`);
```

## Roadmap

- [x] **Core runner** — scenario parsing, agent lifecycle, transcript capture
- [x] **Agent contract spec** — formal interface definition
- [x] **Claude Code adapter** — first agent implementation
- [x] **LLM-as-judge scoring** — rubric evaluation pipeline
- [x] **System-measured scoring** — efficiency and resilience metrics from transcripts
- [x] **CLI output** — human-readable score reports (ink-based live display)
- [x] **JSON output** — structured results for CI
- [x] **Parallel scenario execution** — run scenario suites concurrently
- [x] **Concurrency control** — `--concurrency` flag to limit parallel jobs
- [x] **Custom adapter API** — `createAgentAdapter` factory + config-based loading for any CLI agent
- [x] **Codex adapter** — NDJSON stream adapter for OpenAI Codex CLI
- [x] **Gemini adapter** — NDJSON stream adapter for Google Gemini CLI
- [x] **MCP server setup** — wire `mcp_servers` config through to adapters
- [x] **Skills setup** — wire `skills` config through to adapters
- [x] **Baseline snapshots** — save runs as baselines, diff future runs for regression detection
- [x] **Transcript normalization** — adapter-agnostic signal extraction (tool names, URLs, domains, classifications)
- [x] **Interaction-based scoring** — 4-dimension evaluation (Goal Achievement + Environment + Service + Agent) with sparse index, triage, and deep eval pipeline
- [ ] **Human interruption detection** — detect and penalize agent requests for human intervention
- [ ] **Score thresholds** — CI gating with configurable pass/fail thresholds
- [ ] **Report cleanup** — pruning old reports with `axis reports prune`
- [ ] **Markdown report output** — `axis reports <id> --format md`
- [ ] **Historical trending** — score regression detection and alerting
- [ ] **AXIS Badge** — embeddable score badge for READMEs (like Lighthouse badges)

## Execution Plan

How we build this, broken into phases. Each phase produces a working increment.

### Phase 1: Foundation ✅

The skeleton. Get a scenario running end-to-end with a single agent, even if scoring is basic.

- [x] **Project scaffolding** — TypeScript + Node.js, npm, `@netlify/axis` package structure
- [x] **Config loader** — parse and validate `axis.config.json`, discover scenario files from configured directory
- [x] **Scenario schema** — JSON Schema definition for scenario files, validation, loading
- [x] **Agent contract interface** — TypeScript interface/types for agent adapters (input, output, transcript format)
- [x] **Claude Code adapter** — first concrete adapter: shells out to `claude` CLI, captures structured JSON output, normalizes to contract
- [x] **Setup/teardown executor** — runs `run_script` actions (shell commands) defined in scenarios
- [x] **Runner MVP** — parallel execution: load config → discover scenarios → resolve agent → run setup → launch agent via adapter → capture transcript → run teardown
- [x] **Basic CLI** — `axis run` entry point that executes scenarios and prints raw results

### Phase 2: Scoring ✅

Make the output meaningful. Turn raw transcripts into graded scores.

- [x] **Goal achievement judge** — LLM evaluates transcript + rubric, per-check weighted scoring
- [x] **Interaction classification** — deterministic tool-name-to-category mapping (environment / service / agent)
- [x] **Sparse index** — compressed transcript representation for efficient LLM evaluation
- [x] **Triage + deep eval pipeline** — LLM flags interactions for deep review, scores on success/speed/weight/relevance/necessity
- [x] **Category scoring** — log-normal CDF mapping, per-category dimension aggregation
- [x] **Score aggregation** — weighted composite AXIS result across 4 dimensions
- [x] **CLI report** — ink-based live terminal display with per-job scores
- [x] **JSON report** — structured output file for programmatic consumption
- [x] **Report storage** — persistent `.axis/reports/` with manifest + per-scenario detail files
- [x] **Report viewer** — `axis reports` command for listing and drilling into past results

### Phase 3: Execution Control & Extensibility ✅

Fine-grained control over how jobs run, and proof the adapter contract is truly agent-agnostic.

- [x] **Concurrency control** — `--concurrency <n>` flag and `defaults.concurrency` config to limit parallel jobs
- [x] **Custom adapter API** — `createAgentAdapter` factory + `registerAdapter` for any CLI-based agent
- [x] **Codex adapter** — NDJSON stream adapter for OpenAI Codex CLI
- [x] **Gemini adapter** — NDJSON stream adapter for Google Gemini CLI
- [x] **MCP server setup** — wire `mcp_servers` agent config through to adapter execution
- [x] **Skills setup** — wire `skills` agent config through to adapter execution

### Phase 4: CI & Regression

Make it runnable in CI with automated pass/fail gating and regression detection.

- [ ] **Score thresholds** — `defaults.thresholds` config with per-category minimums, non-zero exit when below
- [x] **Baseline snapshots** — `axis baseline set` saves a run, `axis baseline diff` compares future runs against it
- [ ] **Report cleanup** — `axis reports prune --keep <n>` to manage disk usage

### Phase 5: Output & Ecosystem

Richer output formats and platform features.

- [ ] **Configurable judge** — separate adapter/model for scoring (e.g. run with a custom adapter, judge with `claude-code`)
- [ ] **Markdown report output** — `axis reports <id> --format md` for pasting into PRs/docs
- [ ] **Scenario library** — curated and community-contributed scenario templates
- [ ] **Historical trending** — store results over time, detect regressions
- [ ] **AXIS Badge** — embeddable score badge (like Lighthouse)
- [ ] **Dashboard** — web UI for browsing results, trends, and comparisons
