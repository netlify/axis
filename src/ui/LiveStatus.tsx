import { Box, Text } from "ink";
import type { JobState } from "../types/output.js";
import { selectNearestMedian } from "../scoring/aggregate.js";
import { getBaseKey, getVariantName, STATUS_ICONS, STATUS_LABELS } from "./format.js";
import { AnimatedTokens } from "./AnimatedTokens.js";
import { LiveDuration } from "./LiveDuration.js";

interface LiveStatusProps {
  jobs: JobState[];
  skippedCount?: number;
}

/** A job is "active" when it's mid-flight — counts toward the live scenario list. */
function isActive(job: JobState): boolean {
  if (job.inTeardown) return true;
  return (
    job.status === "setup" ||
    job.status === "starting" ||
    job.status === "running" ||
    job.status === "teardown" ||
    job.status === "scoring"
  );
}

/** True once a job can no longer change. */
function isFinished(job: JobState): boolean {
  return job.status === "done" || job.status === "failed";
}

/**
 * One scenario/agent pair and every run of it, ordered by run index.
 *
 * The row is the pair, not the run: a pair configured with `runs: 3` stays one
 * line with three chips, so a large suite doesn't triple in height just
 * because repeats were turned on.
 */
export interface Pair {
  /** Full scenario key, including any `@variant` suffix. */
  scenarioKey: string;
  agentName: string;
  runs: JobState[];
}

export function LiveStatus({ jobs, skippedCount = 0 }: LiveStatusProps) {
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const pending = jobs.filter((j) => j.status === "pending").length;
  const scoring = jobs.filter((j) => j.status === "scoring").length;
  const tearingDown = jobs.filter((j) => j.inTeardown).length;
  const total = jobs.length;

  const scenarioCount = new Set(jobs.map((j) => getBaseKey(j.scenarioKey))).size;
  const agentCount = new Set(jobs.map((j) => j.agentName)).size;

  const allFinished = done + failed === total && total > 0;
  const pairs = groupIntoPairs(jobs);
  // Filter by pair rather than by run, so a pair that is mid-flight still
  // shows the chips for the runs of it that already landed.
  const displayedScenarios = allFinished
    ? groupByScenario(pairs)
    : groupByScenario(pairs.filter((p) => p.runs.some(isActive)));

  // One score per pair, so a repeated pair doesn't outvote a single-run one in
  // the suite average. Each pair's score comes from the same representative
  // rule the report applies, so this average matches the report's.
  const pairScores = pairs.map(pairScore).filter((s): s is number => s !== null);
  const avgScore =
    pairScores.length > 0 ? Math.round(pairScores.reduce((sum, s) => sum + s, 0) / pairScores.length) : null;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text> </Text>
      <Text bold>
        AXIS — {scenarioCount} scenario{scenarioCount !== 1 ? "s" : ""} · {agentCount} agent
        {agentCount !== 1 ? "s" : ""}
      </Text>
      <Text>{"─".repeat(50)}</Text>
      {displayedScenarios.length > 0 ? (
        displayedScenarios.map(({ scenarioKey, pairs: scenarioPairs }) => (
          <ScenarioGroup key={scenarioKey} scenarioKey={scenarioKey} pairs={scenarioPairs} />
        ))
      ) : allFinished ? null : (
        <>
          <Text dimColor>Waiting for scenarios to start…</Text>
          <Text> </Text>
        </>
      )}
      <Text>{"─".repeat(50)}</Text>
      {allFinished && avgScore !== null ? (
        <Text bold>Average AXIS Result: {avgScore} / 100</Text>
      ) : (
        <Text>{formatProgress({ done, failed, pending, total, scoring, tearingDown })}</Text>
      )}
      {skippedCount > 0 ? <Text dimColor>{skippedCount} marked to be skipped</Text> : null}
      <Text> </Text>
    </Box>
  );
}

/**
 * The pair's headline score: the composite of the scored run nearest the
 * median, or null before anything has scored.
 *
 * This runs the same `selectNearestMedian` rule the report uses to pick the
 * representative run, over the same composites, so the number in the terminal
 * and the number in the report are the same run's score by construction. It is
 * provisional while runs are still landing, and converges as they arrive.
 */
export function pairScore(pair: Pair): number | null {
  const scored = pair.runs.filter((r): r is JobState & { axisScore: number } => r.axisScore !== undefined);
  const chosen = selectNearestMedian(
    scored,
    (run) => run.axisScore,
    (run) => run.runIndex ?? 0,
  );
  return chosen?.axisScore ?? null;
}

/**
 * Everything the row needs, derived from a pair's runs.
 *
 * Pulled out of the component so the collapse rules (which run's status wins,
 * what the label says, how time and tokens total up) are unit-testable without
 * rendering ink.
 */
export interface PairSummary {
  status: JobState["status"];
  label: string;
  /** Median composite across scored runs, or null when none scored. */
  score: number | null;
  /** True while any run is still moving. */
  active: boolean;
  /** Final total duration once every run has landed, otherwise undefined. */
  finalMs?: number;
  /**
   * Start time to tick from. Back-dated by the duration of runs that already
   * finished, so a repeated pair's timer reads as total agent time rather than
   * resetting on each run.
   */
  startedAt?: number;
  liveTokens: number;
  tokensFinal: boolean;
}

export function summarizePair(pair: Pair): PairSummary {
  const { runs } = pair;
  const repeated = runs.length > 1;

  // The pair's state is the state of whichever run is still moving; once every
  // run has landed it is a pass if any run succeeded.
  const activeRun = runs.find(isActive);
  const allFinished = runs.every(isFinished);
  const anyDone = runs.some((r) => r.status === "done");
  const status: JobState["status"] = activeRun
    ? activeRun.status
    : allFinished
      ? anyDone
        ? "done"
        : "failed"
      : "pending";

  const score = pairScore(pair);
  const label = repeated
    ? buildRepeatedLabel(runs, allFinished, score)
    : allFinished && runs[0].axisScore !== undefined
      ? `${runs[0].axisScore} / 100`
      : (STATUS_LABELS[status] ?? status);

  const finishedMs = runs.reduce((sum, r) => (isFinished(r) ? sum + (r.durationMs ?? 0) : sum), 0);

  return {
    status,
    label,
    score,
    active: status === "starting" || status === "running" || status === "scoring",
    ...(allFinished ? { finalMs: finishedMs } : {}),
    ...(activeRun?.runStartedAt !== undefined
      ? { startedAt: activeRun.runStartedAt - finishedMs }
      : runs[0].runStartedAt !== undefined
        ? { startedAt: runs[0].runStartedAt }
        : {}),
    liveTokens: runs.reduce((sum, r) => sum + (r.liveTokens ?? 0), 0),
    tokensFinal: runs.every((r) => r.tokensFinal || r.status === "failed"),
  };
}

function formatProgress(counts: {
  done: number;
  failed: number;
  pending: number;
  total: number;
  scoring: number;
  tearingDown: number;
}): string {
  const { done, failed, pending, total, scoring, tearingDown } = counts;
  const parts: string[] = [`${done + failed}/${total} complete`];
  if (done > 0) parts.push(`${done} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (scoring > 0) parts.push(`scoring ${scoring}…`);
  if (tearingDown > 0) parts.push(`tearing down ${tearingDown}…`);
  return parts.join(" · ");
}

function ScenarioGroup({ scenarioKey, pairs }: { scenarioKey: string; pairs: Pair[] }) {
  return (
    <Box flexDirection="column">
      <Text bold>{scenarioKey}</Text>
      {pairs.map((pair) => (
        <AgentRow key={`${pair.scenarioKey}:${pair.agentName}`} pair={pair} />
      ))}
      <Text> </Text>
    </Box>
  );
}

const COL_AGENT_LIVE = 25;
const COL_LABEL = 15;

/** Ink color for a run's state, shared by the row icon and its chips. */
function statusColor(status: JobState["status"]): string | undefined {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "starting" || status === "running" || status === "scoring") return "yellow";
  return undefined;
}

function AgentRow({ pair }: { pair: Pair }) {
  const { runs } = pair;
  const repeated = runs.length > 1;
  const variant = getVariantName(pair.scenarioKey);
  const agentDisplay = variant ? `${pair.agentName} @${variant}` : pair.agentName;

  const summary = summarizePair(pair);
  const icon = STATUS_ICONS[summary.status] ?? "?";
  const color = statusColor(summary.status);
  // The timer and token counter are both visible in every state where they
  // have a value; for a repeated pair they total the pair's whole spend.
  const hasTime = summary.startedAt !== undefined || summary.finalMs !== undefined;

  return (
    <Box>
      <Text color={color}>
        {"  "}
        {icon} {agentDisplay.padEnd(COL_AGENT_LIVE)} {summary.label.padEnd(COL_LABEL)}
      </Text>
      {repeated ? (
        <Box marginRight={1}>
          <RunChips runs={runs} />
        </Box>
      ) : null}
      {hasTime ? (
        <Box marginRight={1}>
          <LiveDuration startedAt={summary.startedAt} finalMs={summary.finalMs} active={summary.active} color={color} />
        </Box>
      ) : null}
      {summary.liveTokens > 0 ? (
        <AnimatedTokens target={summary.liveTokens} active={summary.active} isFinal={summary.tokensFinal} />
      ) : null}
    </Box>
  );
}

/**
 * `2/3 · med 86` while runs are still landing, `86 / 100` once they all have.
 * The progress fraction is what makes a repeated pair legible mid-run: without
 * it, a row sitting on "running" gives no clue how much of the pair is left.
 */
export function buildRepeatedLabel(runs: JobState[], allFinished: boolean, score: number | null): string {
  if (allFinished) return score !== null ? `${score} / 100` : "failed";
  const finished = runs.filter(isFinished).length;
  return `${finished}/${runs.length} · ${score !== null ? `med ${score}` : "—"}`;
}

/**
 * Per-run chips: `[87✓ 84✓ ●]`. A finished run shows its score so the spread
 * is readable at a glance; an unscored or failed run shows only its icon.
 */
function RunChips({ runs }: { runs: JobState[] }) {
  return (
    <Box>
      <Text dimColor>[</Text>
      {runs.map((run, i) => (
        <Box key={run.runIndex ?? i}>
          {i > 0 ? <Text dimColor> </Text> : null}
          <Text color={statusColor(run.status)}>
            {run.status === "done" && run.axisScore !== undefined ? `${run.axisScore}` : ""}
            {STATUS_ICONS[run.status] ?? "?"}
          </Text>
        </Box>
      ))}
      <Text dimColor>]</Text>
    </Box>
  );
}

/** Collapse jobs into pairs, preserving first-seen order and run sequence. */
export function groupIntoPairs(jobs: JobState[]): Pair[] {
  const map = new Map<string, Pair>();
  for (const job of jobs) {
    const key = `${job.scenarioKey} ${job.agentName}`;
    const existing = map.get(key);
    if (existing) {
      existing.runs.push(job);
    } else {
      map.set(key, { scenarioKey: job.scenarioKey, agentName: job.agentName, runs: [job] });
    }
  }
  for (const pair of map.values()) {
    pair.runs.sort((a, b) => (a.runIndex ?? 1) - (b.runIndex ?? 1));
  }
  return [...map.values()];
}

/** Group pairs under their base scenario key, so variants share one heading. */
function groupByScenario(pairs: Pair[]): Array<{ scenarioKey: string; pairs: Pair[] }> {
  const map = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const baseKey = getBaseKey(pair.scenarioKey);
    const list = map.get(baseKey) ?? [];
    list.push(pair);
    map.set(baseKey, list);
  }
  return Array.from(map, ([scenarioKey, groupPairs]) => ({ scenarioKey, pairs: groupPairs }));
}
