<div align="center">
  <a href="https://axis.run">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/76547bab-3a2e-498a-b556-99c58b3c553b">
      <img alt="AXIS logo" src="https://github.com/user-attachments/assets/76547bab-3a2e-498a-b556-99c58b3c553b" height="128">
    </picture>
  </a>
  <h1>AXIS — Agent Experience Index Score</h1>
  <a href="https://axis.run"><img alt="Website" src="https://img.shields.io/badge/WEBSITE-axis.run-blueviolet.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.npmjs.com/package/@netlify/axis"><img alt="NPM version" src="https://img.shields.io/npm/v/@netlify/axis?style=for-the-badge&labelColor=000000"></a>
  <a href="https://github.com/netlify/axis/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/netlify/axis?style=for-the-badge&labelColor=000000"></a>
  <a href="https://github.com/netlify/axis/issues"><img alt="Contribute" src="https://img.shields.io/badge/CONTRIBUTE-blueviolet.svg?style=for-the-badge&labelColor=000000"></a>
</div>
<br />

AXIS is an open source tooling and a scoring framework to measure how well services work for AI agents. Think [Lighthouse](https://developer.chrome.com/docs/lighthouse), but for agent experience.

Give AXIS a scenario, an agent, and a prompt. It runs the agent, captures a full transcript, and produces a graded score across four independent dimensions: Goal Achievement, Environment, Service, and Agent.

## Why AXIS

The web has Lighthouse. APIs have contract testing. Performance has k6. But there's no standardized way to answer: "How well does my system work when an AI agent tries to use it?".

As agents become a primary interface for interacting with sites, APIs, and developer platforms, the systems they interact with need to be measured and optimized for that experience — just like we optimize for page load time or accessibility. AXIS is that measurement.

## Quick start

```bash
npm install @netlify/axis
```

`axis.config.json`:

```json
{
  "scenarios": "./scenarios",
  "agents": ["claude-code"]
}
```

`scenarios/hello-world.json`:

```json
{
  "name": "Hello world",
  "prompt": "Navigate to https://example.com and describe what you see on the page.",
  "judge": [
    { "check": "Agent visited the target URL", "weight": 0.5 },
    { "check": "Agent provided a description of the page content", "weight": 0.5 }
  ]
}
```

```bash
axis run
```

AXIS executes the scenario, scores the result, and writes a report to `.axis/reports/`.

## Reducing score volatility

Agents are stochastic, so the same scenario can score differently on two identical runs. Set `runs` above 1 to sample a pair several times:

```bash
axis run --runs 3
```

```json
{
  "settings": { "runs": 3 }
}
```

AXIS keeps every run but headlines a single **representative** one: the real run whose composite sits nearest the median. Since run counts are odd, that run's score _is_ the median, so the headline equals the median of the runs listed beneath it and the live terminal output matches the report exactly. It also keeps the score explainable, since the transcript and audits you drill into belong to the run being reported, which an average would not.

Alongside it the report records the spread (median, range, sigma), each run's four dimension scores, and a **reliability** fraction. A crashed run is excluded from the score and counted against reliability instead, so flakiness never masquerades as low quality; a run whose score was withheld because judging failed leaves the denominator entirely rather than being charged to the agent.

The payoff lands in `--compare-baseline`: a baseline built from repeats knows its own standard deviation, so a regression is a move that exceeds the noise the suite actually measured rather than a fixed 1-point threshold.

Run counts must be odd (1, 3, 5, up to 19). An even sample has no middle run, so the median falls between two runs and the headline belongs to none of them; at `runs: 2` the selection degenerates entirely and always returns run 1 regardless of merit. Even values are rejected rather than rounded.

Repeats default to off. Each extra run is a full agent execution plus its judge calls, so cost scales linearly. See [running tests](https://axis.run/running#multiple-runs) for scheduling, `AXIS_RUN_INDEX`, and the report layout.

## Documentation

Full documentation lives at **[axis.run](https://axis.run)**:

- [Quick start](https://axis.run/quickstart) - install through your first scored run
- [Configuration](https://axis.run/configuration) - `axis.config.json`, scenarios, MCP servers, skills
- [CLI reference](https://axis.run/cli) - `axis run`, `axis reports`, `axis baseline`
- [Running tests](https://axis.run/running) - execution model, multiple runs, workspace isolation, custom adapters, CI integration
- [Scoring framework](https://axis.run/scoring) - the four dimensions, signals, calibration

## Programmatic API

Use the programmatic API when you want to integrate AXIS into an existing test runner, build tool, or CI pipeline rather than calling the CLI directly.

`run({ profile })` and `loadConfig(path, { profile })` select a named profile from the config, the same overlay `axis run --profile` applies. `loadConfig` returns the resolved `config` alongside the pre-merge `baseConfig`, for callers that need the suite layout as a whole rather than the active suite.

## Roadmap

Delivered: scenario runner, four-dimension scoring pipeline, baselines with regression detection, repeated runs with representative-run selection and noise-aware regression bands, MCP/skills wiring, custom adapter API, config profiles for running one repo's scenarios under several agent matrices, built-in adapters for Claude Code, Codex, and Gemini.

Planned:

- **Historical trending** - score regression detection over time
- **AXIS badge** - embeddable score badge for READMEs
- **Configurable judge** - separate adapter/model for scoring, independent of the agent under test
- **Score thresholds** - CI gating with configurable pass/fail thresholds
- **Human interruption detection** - penalize agent requests for human intervention

## Contributing

AXIS is built in the open. Contributions are welcome. New scenarios, agent adapters,
bug fixes, and documentation improvements all help.
<br />
<br />

---

AXIS is open source under the MIT license, created by [Netlify](https://www.netlify.com)
and developed with founding contributors including [Auth0](https://auth0.com) and
[Resend](https://resend.com).

Full docs: [axis.run](https://axis.run)
