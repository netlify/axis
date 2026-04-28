# AXIS — Agent eXperience Index Score

AXIS is a synthetic testing framework for measuring how well systems support AI agent interaction. Think [Lighthouse](https://developer.chrome.com/docs/lighthouse), but instead of scoring user experience, AXIS scores **agent experience**.

Given a scenario, an agent, and a prompt — AXIS runs the agent, captures a full transcript of the interaction, and produces a graded score across four independent dimensions: Goal Achievement, Environment, Service, and Agent.

## Why AXIS

The web has Lighthouse. APIs have contract testing. Performance has k6. But there's no standardized way to answer: _"How well does my system work when an AI agent tries to use it?"_

As agents become a primary interface for interacting with websites, APIs, and developer platforms, the systems they interact with need to be measured and optimized for that experience — just like we optimize for page load time or accessibility.

## Quick Start

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
  "name": "Hello World",
  "prompt": "Navigate to https://example.com and describe what you see on the page.",
  "rubric": [
    { "check": "Agent visited the target URL", "weight": 0.5 },
    { "check": "Agent provided a description of the page content", "weight": 0.5 }
  ]
}
```

```bash
axis run
```

AXIS executes the scenario, scores the result, and writes a report to `.axis/reports/`.

## Documentation

Full documentation lives at **https://axis-docs.netlify.app**:

- [Overview](https://axis-docs.netlify.app/) — what AXIS measures and why
- [Quick Start](https://axis-docs.netlify.app/quickstart) — install through your first scored run
- [Configuration](https://axis-docs.netlify.app/configuration) — `axis.config.json`, scenarios, MCP servers, skills
- [CLI Reference](https://axis-docs.netlify.app/cli) — `axis run`, `axis reports`, `axis baseline`
- [Running Tests](https://axis-docs.netlify.app/running) — execution model, workspace isolation, custom adapters, CI integration
- [Scoring Framework](https://axis-docs.netlify.app/scoring) — the four dimensions, signals, calibration

## Programmatic API

`@netlify/axis` exports its core functionality for use as a library:

```typescript
import { run, scoreResults } from "@netlify/axis";

const output = await run({ configPath: "axis.config.json" });
const scored = await scoreResults(output);

console.log(`Average AXIS Result: ${scored.summary.averageAxisScore}`);
```

The package also exports `loadConfig`, `discoverScenarios`, `setBaseline`, `diffBaseline`, `createAgentAdapter`, `registerAdapter`, and the underlying scoring primitives (`buildSparseIndex`, `categorizeInteraction`, `normalizeTranscript`). See [`src/index.ts`](./src/index.ts) for the full surface.

## Roadmap

Delivered: scenario runner, four-dimension scoring pipeline, baselines with regression detection, MCP/skills wiring, custom adapter API, built-in adapters for Claude Code, Codex, and Gemini.

Planned:

- **Configurable judge** — separate adapter/model for scoring, independent of the agent under test
- **Score thresholds** — CI gating with configurable pass/fail thresholds
- **Human interruption detection** — penalize agent requests for human intervention
- **Report cleanup** — `axis reports prune` for managing disk usage
- **Markdown report output** — `axis reports <id> --format md` for PR/doc embedding
- **Historical trending** — score regression detection over time
- **AXIS Badge** — embeddable score badge for READMEs
