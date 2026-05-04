# AGENTS.md

## Project Overview

AXIS (Agent eXperience Index Score) is a synthetic testing framework for AI agents. It runs agents against scenarios, captures transcripts, and produces graded scores across four dimensions: goal achievement, environment quality, service quality, and agent quality.

- ESM TypeScript, built with `tsc`, tested with `vitest`, CLI via `commander`
- Live terminal display uses `ink` (React for CLIs), rendered to stderr
- Runner is fully decoupled from display via a `Logger` interface

## Terminology

- **AXIS Result** (not "AXIS Score") -the composite 0–100 number. "AXIS Score" reads as "score score" since AXIS already stands for "Agent eXperience Index **Score**".
- Use "AXIS Result" in all user-facing text, display output, and documentation.
- The internal property names (`axisScore`, `averageAxisScore`) are fine as code identifiers.

## Architecture

| Layer    | Key Files                                                  | Purpose                                                              |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| CLI      | `src/cli.ts`                                               | Entry point, ink display, signal handling                            |
| Runner   | `src/runner/runner.ts`                                     | Job orchestration, concurrency, isolation                            |
| Adapters | `src/adapters/*.ts`                                        | Spawn agent CLIs, parse NDJSON streams                               |
| Scoring  | `src/scoring/`                                             | LLM judge + interaction-based evaluation pipeline                    |
| Reports  | `src/reports/writer.ts`, `reader.ts`                       | Persistent `.axis/reports/` store                                    |
| Display  | `src/ui/format.ts`, `LiveStatus.tsx`, `AnimatedTokens.tsx` | Pure formatting + ink components (incl. live token counter)          |
| Types    | `src/types/`                                               | Shared interfaces (`agent`, `config`, `output`, `scoring`, `report`) |

### Adapter Pattern

All three built-in adapters are created via `createAgentAdapter(spec)` from `src/adapters/base/agent-adapter.ts`. Each adapter is a plain factory function (e.g. `createGeminiAdapter()`) that returns an `AgentAdapter` -no classes, no inheritance. The factory owns the shared plumbing:

- Spawn + stdin.end + cleanup registration (SIGTERM on Ctrl-C)
- 10-minute timeout → SIGTERM → SIGKILL after 5s grace (timer cleared on clean exit)
- stderr capped at 100 KB
- `close` event listener registered BEFORE stdout stream to avoid missing it
- Raw output capture (NDJSON lines for `lines` mode, raw chunks for `aggregate`)
- Token estimator wiring via `StreamContext.feedAssistantText`
- CLI resolution (direct command → `npx --yes <pkg>` fallback)
- Error precedence: `extracted.metadata.error` → `stderr` → `"Agent process exited with non-zero code"`

The three built-in adapters (`claude-code`, `codex`, `gemini`) use `lines` mode for NDJSON parsing. Custom adapters can use either `lines` or `aggregate` mode (raw stdout capture).

### Adding a new agent adapter

Call `createAgentAdapter(spec)` with an `AgentAdapterSpec<State>`. The spec is a single typed object -no class inheritance, no protected hooks:

| Spec field        | Purpose                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Adapter name (registered in `src/adapters/registry.ts`)                                                                           |
| `cliCommand?`     | CLI binary for `resolveCommand`; omit if user-supplied                                                                            |
| `timeoutMs?`      | Execution timeout (default 10 min)                                                                                                |
| `requiredEnv?`    | Env vars validated by the runner pre-flight (e.g. `ANTHROPIC_API_KEY`)                                                            |
| `isolationEnv?`   | Workspace isolation vars (e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`)                                                                 |
| `prepare?`        | Side effects (mkdir, MCP / skills writers) before spawn                                                                           |
| `resolveCommand?` | Override how the CLI command is resolved                                                                                          |
| `buildArgs`       | Build CLI arguments (prefix args from command resolution prepended automatically)                                                 |
| `initialState`    | Per-run mutable state used by `streamConfig` handlers and `getResult`                                                             |
| `streamConfig`    | How to process agent stdout. Discriminated union: `{ mode: "lines", onLine, onEnd? }` or `{ mode: "aggregate", onChunk, onEnd? }` |
| `getResult`       | Build final `{ result, metadata? }` from accumulated state after exit                                                             |

The `streamConfig` field uses a discriminated union so the mode and its handler can never get out of sync -no runtime assertions needed. `getResult` returns `null` for "no result" (never `""`). Metadata overrides (e.g. upstream `durationMs`) are spread on top of base-computed fields.

For built-in adapters, register the factory in `src/adapters/registry.ts`. External custom adapters are loaded via the `adapters` field in `axis.config.json` -the runner dynamically imports the module and calls `registerAdapter()` before running any jobs.

### Error Handling

- `AgentMetadata.error` is the canonical error field for failed runs
- Runner checks both `exitCode !== 0` and `metadata.error` for failure status
- Friendly error classification in `src/ui/format.ts` via `friendlyError()` -maps common patterns (quota, rate limit, auth, timeout, network) to one-line messages
- Error display: `↳ friendly message` below failed rows in tables, `Error:` line in detail views
- Scoring callbacks in `cli.ts` preserve `"failed"` status -never overwrite to `"done"`

### Debug Mode

`--debug` enables raw output capture:

- `AgentInput.captureRawOutput` signals adapters to collect raw stdout lines
- `AgentOutput.rawOutput` carries the lines back to the runner
- Report writer strips `rawOutput` from scenario JSON and writes it as `{agent}.raw.ndjson`

## Documentation Policy

User-facing documentation lives in `src/docs-site/` (Astro), published at https://axisproject.ai. All changes to the CLI, scoring system, or configuration schema **must** be reflected there -the docs site is canonical and must stay in sync with the implementation.

`README.md` is intentionally lean: tagline, quick start, link tree to the docs site, and the programmatic API surface. Don't expand it back into a full reference -update the docs site instead.

| Change Type                         | Where to update                                                |
| ----------------------------------- | -------------------------------------------------------------- |
| New/modified CLI flags or commands  | `src/docs-site/src/pages/cli.astro`                            |
| New/modified config fields          | `src/docs-site/src/pages/configuration.astro`                  |
| New/modified scenario schema fields | `src/docs-site/src/pages/configuration.astro`                  |
| Scoring algorithm changes           | `src/docs-site/src/pages/scoring.astro`                        |
| Adapter contract / built-in changes | `src/docs-site/src/pages/running.astro`                        |
| Report / baseline format changes    | `src/docs-site/src/pages/running.astro` + `cli.astro`          |
| New/modified public exports         | `README.md` Programmatic API section (kept here, not in docs)  |

## Build & Test

```bash
rm -rf dist && npm run build   # Always clean build -stale dist/ causes subtle issues
npm test                       # vitest, all unit tests
```

## Gotchas

- Always clean `dist/` before testing changes -stale JS in dist can mask TypeScript errors
- Use `getUTCHours()` for timestamp IDs -`getHours()` gives local time
- Ink renders async -need 100ms yield before unmount to flush final state
- Gemini CLI streams assistant messages as deltas (`delta: true`) -adapter accumulates them
- Gemini `settings.json` must disable context discovery (`discoveryMaxDirs: 0`) or Gemini will scan the workspace tree before addressing the prompt, adding latency and unnecessary tool calls
- Runner emits initial `onJobUpdate` AFTER pre-flight to avoid ink cursor corruption
- The `close` event listener must be registered BEFORE readline to avoid missing it
- Live token counter uses `chars / 5` (intentionally conservative) so the UI never has to reverse; runner enforces monotonicity in `updateTokens`
