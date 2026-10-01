# AGENTS.md

## Project Overview

AXIS (Agent Experience Index Score) is a synthetic testing framework for AI agents. It runs agents against scenarios, captures transcripts, and produces graded scores across four dimensions: goal achievement, environment quality, service quality, and agent quality.

- ESM TypeScript, built with `tsc`, tested with `vitest`, CLI via `commander`
- Live terminal display uses `ink` (React for CLIs), rendered to stderr
- Runner is fully decoupled from display via a `Logger` interface

## Terminology

- **AXIS Result** (not "AXIS Score") -the composite 0–100 number. "AXIS Score" reads as "score score" since AXIS already stands for "Agent Experience Index **Score**".
- Use "AXIS Result" in all user-facing text, display output, and documentation.
- The internal property names (`axisScore`, `averageAxisScore`) are fine as code identifiers.

## Architecture

| Layer    | Key Files                                                  | Purpose                                                                                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI      | `src/cli.ts`                                               | Entry point, ink display, signal handling                                                                                                                                                                                                                                                                                      |
| Runner   | `src/runner/runner.ts`, `lifecycle.ts`, `repo-cache.ts`    | Job orchestration, concurrency, isolation; `runLifecyclePhase` captures `$AXIS_OUTPUT` markdown for `setup`/`teardown`/`beforeAll`/`afterAll` phases; `repo-cache.ts` clones git URLs used by `copy` actions into `.axis/repos/<host>/<owner>/<repo>/<ref>`, once per (repo, ref) per process                                  |
| Adapters | `src/adapters/*.ts`                                        | Spawn agent CLIs, parse NDJSON streams                                                                                                                                                                                                                                                                                         |
| Scoring  | `src/scoring/`                                             | LLM judge + interaction-based evaluation pipeline; `aggregate.ts` collapses a pair's repeated runs into a representative run + spread + reliability                                                                                                                                                                            |
| Reports  | `src/reports/writer.ts`, `reader.ts`, `paths.ts`           | Persistent `.axis/reports/` store; `paths.ts` is the single source of truth for per-run file layout                                                                                                                                                                                                                            |
| Config   | `src/config/loader.ts`, `remote-scenarios.ts`              | Parses `axis.config.*`; walks the scenarios tree (see discovery buckets under Gotchas); `mergeRemoteConfig` clones any git-URL entries in `scenarios` into `.axis/remotes/`, inlines their paths, AND folds each remote repo's `env`/`mcp_servers`/`skills`/`artifacts`/`adapters` into the parent (parent wins on collisions) |
| Display  | `src/ui/format.ts`, `LiveStatus.tsx`, `AnimatedTokens.tsx` | Pure formatting + ink components (incl. live token counter)                                                                                                                                                                                                                                                                    |
| Types    | `src/types/`                                               | Shared interfaces (`agent`, `config`, `output`, `scoring`, `report`)                                                                                                                                                                                                                                                           |

### Profiles and suite selection

`AxisConfig` has three scenario selectors and they compose in a fixed order. `scenarios` is the source (paths, inline entries, remote git URLs). `include` / `exclude` are suite-level key globs. `agents[].scenarios` is the per-agent key glob. Per agent, discovery walks the source, applies `include` then `exclude`, narrows to the agent's own list, then applies the CLI `--scenario` filter. A `-s` or `-a` filter narrows within the active suite; neither can reach a scenario the suite excluded.

`profiles` is a map of named overlays selected with `axis run --profile <name>`. `loadConfig(path, { profile })` merges the chosen overlay over the base before anything downstream runs, so the runner only ever sees one flat resolved config. Plain objects deep-merge; arrays and scalars replace. `include` and `exclude` merge as a pair, so a profile setting either one replaces both and starts from the full pool: without that rule a base `exclude` would cancel a profile's matching `include`.

`loadConfig` returns `baseConfig` alongside `config`. The merge overwrites the base selector with the active profile's, so anything reasoning about suite layout as a whole (rather than the active suite) has to read `include` / `exclude` / `profiles` off `baseConfig`. `assertEveryScenarioIsReachable` in `runner.ts` is the only current consumer.

### Repeated runs

`runs` (CLI `--runs`, scenario `runs`, `settings.runs`, default 1) makes the runner emit one job per repeat. The identity of a job becomes `(scenarioKey, agentName, runIndex)`, but `runIndex` must never leak into `agentName`: that name is a report path segment, a baseline key, and an `-a` filter target.

- **Odd counts only** (`validateRunCount` / `assertValidRunCount` in `config/validator.ts`, `MAX_RUNS = 19`): an even sample has no middle run, so the median of the composites falls between two runs and the headline belongs to none of them. At `runs: 2` selection degenerates outright, because both runs are equidistant from the per-dimension medians and the tie-break always returns run 1. Even values are rejected, never rounded: turning 4 into 3 or 5 would change the sample size and the bill silently. `runs: 0` is rejected too rather than clamped. Note `runCount` (configured, always odd) differs from `runs.length` (present in a report, any value) since a partial `--failed` retry writes only the runs it retried.
- **Runner** (`resolveRunCount`, `orderRunMajor`): jobs are sorted run-major, so every pair's run 1 is queued before any pair's run 2. Repeats of one pair starting simultaneously would maximize contention on a single provider rate limit and turn correlated 429s into apparent agent variance. `Array.prototype.sort` is stable, so sorting on `runIndex` alone preserves discovery order within each pass.
- **Aggregation** (`src/scoring/aggregate.ts`): `selectRepresentative` picks the successful run whose composite sits nearest the median composite, ties to the lowest index. Because counts are odd the median IS one of the composites, so the headline equals the median of the runs listed beneath it. Never synthesize a score, so the headline always has a transcript behind it.
- **One rule, two callers**: `selectNearestMedian` is generic over the item type so report aggregation (over `ScoredRunResult`) and the live CLI (over `JobState`, which carries only a composite) apply the identical rule. That shared function is what makes the terminal and the report agree by construction; `test/unit/ui/LiveStatus.test.ts` pins it. An earlier version selected on weighted L1 distance in four-dimensional space following Lighthouse CI, which disagreed with the median composite on 9-29% of pairs (by up to 14 points) and so needed the four dimensions threaded into `JobState` to stay consistent. Dropped: Lighthouse needs dimension-space selection because its score is a nonlinear curve-mapped blend that hides profiles and it does not surface the metrics; AXIS composites a plain weighted sum and prints all four dimensions in the row.
- **Per-run scores are embedded, and the HTML switches between them**: `ReportRunEntry.score` carries each run's complete score (sparse index included) so the report's detail panel can swap breakdowns client-side. Pre-rendered one `.run-panel` per run, toggled by class, because reports are routinely opened over `file://` where fetching a sibling `result.json` is blocked. That is also why the per-run `result.json` link was dropped from the table. Cost is size: a 20-pair suite at `runs: 3` is ~3 MB of `report.html` against ~0.9 MB at `runs: 1`; if that becomes a problem, render panels lazily rather than trimming the data. The representative's score is duplicated between the pair's top-level `score` and its run entry (~25% of a repeated pair's payload), kept deliberately so `runs[i].score` is never unpredictably absent.
- **Runs table layout**: the representative marker is its own `runs-rep-col` column, not an inline tag beside the run number, which made one row's first cell much wider than its neighbours. What "representative" means lives in a `data-tooltip` on that column's header (reusing the `.info-btn` pattern) rather than a paragraph under the table: the paragraph cost height on every expanded pair and read "showing the representative run below", which went stale the moment a reader switched runs. The header cell takes `position: relative; z-index: 1` so the tooltip paints above the body rows.
- **`.run-panel` is a scoping boundary**: the interaction-link handler resolves its target with `closest(".run-panel") ?? closest(".detail-panel")`. Without the first, a click in run 3's breakdown would scroll run 1's transcript, since all panels share one `.detail-panel`.
- **Per-run dimensions, not medians**: `ReportRunEntry.dimensionScores` records each run's four scores instead of a single `spread.dimensionMedians`. A pair whose composite barely moves can hide a goal score swinging 30 points against a compensating agent score, which only the per-run view shows. A failed run publishes its zeros (it earned them, and `failed` flags it); a withheld run publishes neither composite nor dimensions.
- **Reliability vs withheld**: a run the agent failed counts against `reliability.succeeded`; a run whose score was withheld (judge died or was unparseable) leaves `reliability.total` entirely. Both carry `axisScore: 0` and an error on `metadata`, so they are told apart by the explicit `score.withheld` flag, never by matching error strings.
- **Pair-level totals**: `RunSummary.total`/`completed`/`failed` count pairs, with `runsTotal`/`runsFailed` alongside (omitted at `runs: 1`). A pair is completed when any run scored, failed only when none did. `buildScoredOutput` averages one representative per pair, not every run, or a `runs: 3` pair would weigh 3x in the suite average.
- **Report layout** (`src/reports/paths.ts`): `runs: 1` keeps the historical flat layout byte-for-byte, so old reports stay readable with no migration. Above 1, each run gets `scenarios/{key}/{agent}/run-{i}/` holding `result.json`, `raw.ndjson`, `sparse-index.txt`, `debug.ndjson`, and `artifacts/`. Layout is chosen from `runCount` alone, never from how many runs are present, so paths stay stable while jobs are in flight.
- **Retry is per pair, never per run**: `jobFilter` carries no `runIndex`. A repeated pair's score is a property of its whole sample, so refilling only the failed slots would leave the retry report holding a partial (possibly even-sized) sample, which is exactly what the odd-count rule exists to prevent. `--failed` selects a pair when the pair failed OR any of its runs did, and re-runs all of them.
- **Manifest**: still one entry per pair. Its `score`/`durationMs`/`tokenUsage`/`file` describe the representative; `runCount`/`runs`/`spread`/`reliability` are additive, so baselines, `--failed`, the CLI tables, and the HTML report all keep working untouched.
- **Baselines**: `BaselineEntry` carries `runs`/`stdev`/`reliability`, and `noiseBand()` in `compare.ts` widens the regression tolerance to `max(1, 2 * stdev)`. This is the actual payoff of repeats: the noise threshold stops being a magic constant. A reliability drop is a regression on its own.

### Adapter Pattern

Built-in adapters split into two factories. NDJSON-style adapters (`claude-code`, `codex`) are created via `createAgentAdapter(spec)` from `src/adapters/base/agent-adapter.ts`. ACP-based adapters (`claude-sdk`, `codex-sdk`, `gemini`, `goose`, `opencode`, `qwen-code`, `stakpak`, `blackbox`, `fast-agent`, `mistral-vibe`, `factory-droid`, `poolside`, `vtcode`, `cursor-agent`, `auggie`, `kimi`, `openhands`, `cline`, `kiro-cli`, `kilo`, `qoder`) are created via `createAcpBasedAdapter(spec)` from `src/adapters/base/acp-adapter.ts`. Each adapter is a plain factory function (e.g. `createGeminiAdapter()`) that returns an `AgentAdapter` -no classes, no inheritance. The factory owns the shared plumbing:

- Spawn + cleanup registration (SIGTERM on Ctrl-C); stdin is closed immediately by default, or written with the prompt then closed when `promptVia: "stdin"`
- 10-minute timeout → SIGTERM → SIGKILL after 5s grace (timer cleared on clean exit)
- stderr capped at 100 KB
- `close` event listener registered BEFORE stdout stream to avoid missing it
- Raw output capture (NDJSON lines for `lines` mode, raw chunks for `aggregate`)
- Token estimator wiring via `StreamContext.feedAssistantText`
- CLI resolution (direct command → `npx --yes <pkg>` fallback)
- Error precedence: `extracted.metadata.error` → spawn error → `stderr` → `"Agent process exited with non-zero code"`

The NDJSON-style adapters (`claude-code`, `codex`) use `lines` mode for NDJSON parsing. Custom adapters can use either `lines` or `aggregate` mode (raw stdout capture). ACP-based adapters bypass `streamConfig` entirely - the ACP SDK handles framing.

### Adding a new agent adapter

Call `createAgentAdapter(spec)` with an `AgentAdapterSpec<State>`. The spec is a single typed object -no class inheritance, no protected hooks:

| Spec field         | Purpose                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | Adapter name (registered in `src/adapters/registry.ts`)                                                                                                                                                                                                                                                                                                            |
| `cliCommand?`      | CLI binary for `resolveCommand`; omit if user-supplied                                                                                                                                                                                                                                                                                                             |
| `timeoutMs?`       | Execution timeout (default 10 min)                                                                                                                                                                                                                                                                                                                                 |
| `requiredEnv?`     | Env vars validated by the runner pre-flight (e.g. `ANTHROPIC_API_KEY`)                                                                                                                                                                                                                                                                                             |
| `hasLocalSession?` | Detect a usable local CLI login (e.g. `claude login`, `codex login`). Runner calls this only when `requiredEnv` is missing — explicit API keys always win                                                                                                                                                                                                          |
| `isolationEnv?`    | Isolation vars (e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Signature: `({ workspace, home }) => Record<string, string>`. Point `*_HOME`-style paths under `home`, never `workspace`                                                                                                                                                                                  |
| `prepare?`         | Side effects (mkdir, MCP / skills writers) before spawn                                                                                                                                                                                                                                                                                                            |
| `resolveCommand?`  | Override how the CLI command is resolved                                                                                                                                                                                                                                                                                                                           |
| `buildArgs`        | Build CLI arguments (prefix args from command resolution prepended automatically)                                                                                                                                                                                                                                                                                  |
| `promptVia?`       | How the prompt reaches the CLI: `"argv"` (default) -`buildArgs` places `input.prompt` on the command line; `"stdin"` -the base writes `input.prompt` to the child's stdin and closes it, and `buildArgs` must omit the prompt. `claude-code` and `codex` use `"stdin"`: argv rejects null bytes and caps argument length, and agent transcripts can contain either |
| `initialState`     | Per-run mutable state used by `streamConfig` handlers and `getResult`                                                                                                                                                                                                                                                                                              |
| `streamConfig`     | How to process agent stdout. Discriminated union: `{ mode: "lines", onLine, onEnd? }` or `{ mode: "aggregate", onChunk, onEnd? }`                                                                                                                                                                                                                                  |
| `getResult`        | Build final `{ result, metadata? }` from accumulated state after exit                                                                                                                                                                                                                                                                                              |

The `streamConfig` field uses a discriminated union so the mode and its handler can never get out of sync -no runtime assertions needed. `getResult` returns `null` for "no result" (never `""`). Metadata overrides (e.g. upstream `durationMs`) are spread on top of base-computed fields.

For built-in adapters, register the factory in `src/adapters/registry.ts`. External custom adapters are loaded via the `adapters` field in `axis.config.json` -the runner dynamically imports the module and calls `registerAdapter()` before running any jobs.

#### Authentication: API key preferred, local CLI session as fallback

`claude-code` and `codex` declare `requiredEnv` (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`) AND implement `hasLocalSession`. Pre-flight in `runner.ts` checks env vars first; if missing, it calls `hasLocalSession` and only throws if both signals are absent. **API keys are the preferred path** — they're explicit, work in CI, and don't bill against an individual subscription. The local-session fallback exists for laptop ergonomics: when a developer already has `claude login` / `codex login` set up, they shouldn't have to mint an API key just to try a scenario. The `prepare` hooks in those adapters materialize `~/.claude.json` / `~/.codex/auth.json` (and on macOS, the Keychain entry for Claude Code) into the isolated `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so the CLI authenticates as if it were running normally. For `claude-code`, the copied `~/.claude.json` is **sanitized first** — top-level `mcpServers` and every `projects[*].mcpServers` are stripped so the operator's personal MCP servers don't leak into scenario runs; only the auth anchor (`oauthAccount`) and other non-MCP fields survive. (`codex` is unaffected: it copies only `~/.codex/auth.json`, and Codex MCP config lives in `~/.codex/config.toml`, which is never copied.) New adapters that wrap a CLI with both API-key and login flows should follow the same pattern.

### Error Handling

- `AgentMetadata.error` is the canonical error field for failed runs
- A process that fails to start — `spawn()` throwing synchronously, or the child emitting `error` (e.g. `ENOENT`) — is a failed run with `metadata.error` set, never a thrown error; the runner and scoring treat it like any other failed run
- Runner checks both `exitCode !== 0` and `metadata.error` for failure status
- Friendly error classification in `src/ui/format.ts` via `friendlyError()` -maps common patterns (quota, rate limit, auth, timeout, network) to one-line messages
- Error display: `↳ friendly message` below failed rows in tables, `Error:` line in detail views
- Scoring callbacks in `cli.ts` preserve `"failed"` status -never overwrite to `"done"`

#### Withheld scores (don't grade what you can't trust)

Two silent-failure modes used to leak a fabricated composite (goal 0 + default category scores ≈ 57) that was indistinguishable from a mediocre run. Both are now **withheld**: the run is marked failed instead of scored, so it's excluded from the average, counted as failed (exit 1), retryable via `--failed`, and surfaced loudly.

- **Empty-work signature**: a run that produced no transcript AND no result. `hasEmptyOutput()` in `types/output.ts` defines it; `isFailedRun()` treats it as failed even on a clean exit; the base adapter (`agent-adapter.ts`) stamps `"Agent produced no output"` so the error column is descriptive.
- **Judge death / unparseable judge response**: `callJudge()` throws `ScoringError` when the judge invocation failed or returned nothing; `goal-achievement.ts` and `deep-eval.ts` throw `ScoringError` when a judge response can't be parsed at all (a parsed-but-incomplete response still gets per-item defaults). `scoreRunResult()` catches `ScoringError`, stamps `"Score withheld: …"` on the run, and returns a zero/failed result. Non-`ScoringError` throws propagate (real bugs should fail loud).

`buildScoredOutput()` recomputes `completed`/`failed` from the scored results, so a run that scoring flips to failed is reflected in the summary and exit code.

The withheld path also sets `score.withheld = true`. Multi-run aggregation depends on that flag to keep a judge outage out of the agent's reliability denominator, so a new withhold site must set it rather than relying on the stamped error message.

### Debug Mode

`--debug` enables raw output capture:

- `AgentInput.captureRawOutput` signals adapters to collect raw stdout lines
- `AgentOutput.rawOutput` carries the lines back to the runner
- Report writer strips `rawOutput` from scenario JSON and writes it as `{agent}.raw.ndjson` (or `{agent}/run-{i}/raw.ndjson` for a repeated pair -see `src/reports/paths.ts`)

## Documentation Policy

User-facing documentation lives in `src/docs-site/` (Astro), published at https://axis.run. All changes to the CLI, scoring system, or configuration schema **must** be reflected there -the docs site is canonical and must stay in sync with the implementation.

`README.md` is intentionally lean: tagline, quick start, link tree to the docs site, and the programmatic API surface. Don't expand it back into a full reference -update the docs site instead.

| Change Type                         | Where to update                                               |
| ----------------------------------- | ------------------------------------------------------------- |
| New/modified CLI flags or commands  | `src/docs-site/src/pages/cli.astro`                           |
| New/modified config fields          | `src/docs-site/src/pages/configuration.astro`                 |
| New/modified scenario schema fields | `src/docs-site/src/pages/configuration.astro`                 |
| Scoring algorithm changes           | `src/docs-site/src/pages/scoring.astro`                       |
| Adapter contract / built-in changes | `src/docs-site/src/pages/running.astro`                       |
| Report / baseline format changes    | `src/docs-site/src/pages/running.astro` + `cli.astro`         |
| New/modified public exports         | `README.md` Programmatic API section (kept here, not in docs) |

## Build & Test

```bash
rm -rf dist && npm run build   # Always clean build -stale dist/ causes subtle issues
npm test                       # vitest, all unit tests
```

## Workspace / Home isolation

Per-job temp layout (see `createWorkspace` in `runner.ts`):

```
/tmp/axis-<rand>/
  ├── work/   ← agent cwd (only scenario-provided files; what the agent scans)
  └── home/   ← agent HOME — .codex/, .claude/, .gemini/, .qwen/, user-scoped skills, MCP config
```

- Adapter `isolationEnv` MUST place `*_HOME`-style paths under `home`, never `workspace`, so the agent doesn't see its own config when scanning files
- `HOME` is set to `home`. `AXIS_WORKSPACE` is `workspace`. Lifecycle scripts can read both
- Claude Code's MCP config is written to `home/.claude/mcp.json` and wired with `--mcp-config <path>` (no `.mcp.json` in cwd); it always runs with `--strict-mcp-config` so only AXIS-declared servers load — nothing discovered from a copied `~/.claude.json` or elsewhere on the host
- Claude/Claude-SDK skills go to `CLAUDE_CONFIG_DIR/skills/` (under `home`); Gemini skills go to `GEMINI_CLI_HOME/skills/` (under `home`)
- **Codex skills are the one exception**: Codex only discovers skills under `.agents/skills/` in cwd, so they live in `workspace`. Scenarios opting into Codex skills accept this limited visibility
- Artifact capture walks `workspace` only — agent config never leaks into report artifacts

## Gotchas

- Always clean `dist/` before testing changes -stale JS in dist can mask TypeScript errors
- Use `getUTCHours()` for timestamp IDs -`getHours()` gives local time
- Ink renders async -need 100ms yield before unmount to flush final state
- Gemini CLI streams assistant messages as deltas (`delta: true`) -adapter accumulates them
- Gemini `settings.json` must disable context discovery (`discoveryMaxDirs: 0`) or Gemini will scan the workspace tree before addressing the prompt, adding latency and unnecessary tool calls
- Runner emits initial `onJobUpdate` AFTER pre-flight to avoid ink cursor corruption
- Scenario discovery sorts every walked file into three buckets: has `prompt`/`judge` (load and validate), has other scenario-only fields but neither of those (hard error: an unfinished scenario, see `SCENARIO_INTENT_FIELDS` in `loader.ts`), has neither (skip quietly, verbose-only). Directories named `fixtures` / `scenario-fixtures` are never walked, which is what lets the middle bucket be strict
- Files that can't be classified at all (unparseable JSON, a module that throws on import) are `ScenarioLoadFailure`s: reported with a reason, carried on `RunOutput.loadFailures` into the manifest and HTML, and they make `axis run` exit non-zero. `axis run` also exits non-zero when zero jobs are discovered, so a stale filter can't read as a pass
- `discoverScenarios` takes its logger and `onLoadFailure` through the options arg. The runner deduplicates failures by path because discovery runs once per agent
- Once a config defines `profiles`, a scenario the default suite excludes that no profile includes can never run, and the runner throws. The check is skipped when the base config has no `include` / `exclude`, so plain configs never pay for the extra discovery pass, and `exclude` without `profiles` still means "never run this"
- A function-style config default export is called with `{ profile }`. If such a config returns no `profiles` map, the factory is assumed to have resolved the profile itself and no merge happens. For an object export with no `profiles`, `--profile` is a hard error instead, since nothing could have consumed it
- `agents[].name` overrides the derived `{agent}|{model}` identity verbatim, with no `-2` counter. The `-2`/`-3` counter tracks derived names only, so an explicit name never consumes a slot in it and inserting one cannot renumber its neighbours. But every assigned name, explicit or derived, shares one uniqueness namespace: an agent name is a report path segment and a baseline key, so `normalizeAgents` throws on any collision in either direction rather than letting two entries overwrite each other's results
- Plural option aliases are rewritten on argv before `program.parse()` (`applyOptionAliases` in `cli.ts`), because commander 14 rejects a second long flag outright and has no alias support. The map is keyed **by command**, which is load-bearing: `axis init --scenarios <path>` is a real option meaning "where to write the scenarios directory", so aliasing it to `--scenario` there would silently break init. Rewriting stops at a bare `--`
- `--failed` is combinable with `--profile` but not with `-s`/`-a`. Retry a report under the profile that produced it: a profile can rename agents (`echo` vs `echo|ask-model`) and narrow the suite, so pairs from another suite match nothing and the run exits non-zero with zero jobs rather than silently retrying under the wrong flags. The `loadConfig` call in the `--failed` branch passes the profile purely so an unknown name fails before the report lookup; `configDir` itself does not depend on it
- Suite selectors distinguish omitted from empty. An omitted `include` means every scenario; `include: []` selects nothing, matching the per-agent `scenarios` filter. `exclude: []` drops nothing. A bare `"*"` in either list means every scenario, special-cased because glob `*` does not cross `/` and would otherwise drop namespaced keys like `cms/create-post`
- The `close` event listener must be registered BEFORE readline to avoid missing it
- Live token counter uses `chars / 5` (intentionally conservative) so the UI never has to reverse; runner enforces monotonicity in `updateTokens`
- `runner.ts` contained two literal NUL bytes (written as raw control characters inside template literals rather than `\x00` escapes), which made `grep` treat the file as binary and silently report zero matches. They are gone; use the escape sequence if you need a NUL separator
- Repeats share `settings.limits.run`, which is a whole-run budget: `checkOverallTokenLimit` sums live tokens across every job, so `runs: 3` exhausts it ~3x sooner. `logRepeatBudgetNote` warns at startup rather than letting the run abort partway and look like the agents got slower
- A repeated pair's runs are isolated on disk (own workspace + HOME) but not in shared external state. `AXIS_RUN_INDEX` / `AXIS_RUN_COUNT` are always set for lifecycle scripts (reading `1`/`1` when unrepeated) so setup can namespace real resources per run without branching
- `setupOutput` / `teardownOutput` (captured from `$AXIS_OUTPUT`) live on `RunResult` but `scoreRunResult` returns a fresh `ScoredRunResult` -`cli.ts` re-propagates them onto the scored copy alongside `artifacts`, otherwise they vanish from the manifest
- `copy` actions whose `match` is a git URL are fetched during runner pre-flight (once per repo + ref), not lazily per job, so 15 parallel job setups can't race to clone the same repo. Failures there are logged, not fatal: the cached rejection makes every job that needs the repo fail fast in setup while unrelated jobs still run. Cached clones are never auto-updated -`--refresh-repos` forces a re-clone
- Run-level `beforeAll` / `afterAll` hooks (on `AxisConfig`) fire from `cli.ts` -not the programmatic `run()` API. `beforeAll` runs before `initReport`; `afterAll` runs after `finalizeReport` so `$AXIS_REPORT_DIR/report.json` is on disk. Both abort the run on failure
