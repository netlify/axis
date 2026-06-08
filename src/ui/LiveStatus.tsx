import { Box, Text } from "ink";
import type { JobState } from "../types/output.js";
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
  return job.status === "setup" || job.status === "running" || job.status === "teardown" || job.status === "scoring";
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

  const activeScenarios = groupByScenario(jobs.filter(isActive));

  const allFinished = done + failed === total && total > 0;
  const scoredJobs = jobs.filter((j) => j.axisScore !== undefined);
  const avgScore =
    scoredJobs.length > 0 ? Math.round(scoredJobs.reduce((sum, j) => sum + j.axisScore!, 0) / scoredJobs.length) : null;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text> </Text>
      <Text bold>
        AXIS — {scenarioCount} scenario{scenarioCount !== 1 ? "s" : ""} · {agentCount} agent
        {agentCount !== 1 ? "s" : ""}
      </Text>
      <Text>{"─".repeat(50)}</Text>
      {activeScenarios.length > 0 ? (
        activeScenarios.map(({ scenarioKey, agents }) => (
          <ScenarioGroup key={scenarioKey} scenarioKey={scenarioKey} agents={agents} />
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

function ScenarioGroup({ scenarioKey, agents }: { scenarioKey: string; agents: JobState[] }) {
  return (
    <Box flexDirection="column">
      <Text bold>{scenarioKey}</Text>
      {agents.map((job) => (
        <AgentRow key={`${job.scenarioKey}:${job.agentName}`} job={job} />
      ))}
      <Text> </Text>
    </Box>
  );
}

const COL_AGENT_LIVE = 25;

function AgentRow({ job }: { job: JobState }) {
  const icon = STATUS_ICONS[job.status] ?? "?";
  const variant = getVariantName(job.scenarioKey);

  const label =
    (job.status === "done" || job.status === "failed") && job.axisScore !== undefined
      ? `${job.axisScore} / 100`
      : (STATUS_LABELS[job.status] ?? job.status);

  const color =
    job.status === "done"
      ? "green"
      : job.status === "failed"
        ? "red"
        : job.status === "running" || job.status === "scoring"
          ? "yellow"
          : undefined;

  // The timer and token counter are both visible in every state where they
  // have a value. The timer shows live-elapsed during running/scoring and
  // the final `durationMs` afterwards. The token counter keeps animating
  // until it catches up to the final real total even after the job is done.
  const active = job.status === "running" || job.status === "scoring";
  const hasTime = job.runStartedAt !== undefined || job.durationMs !== undefined;
  const hasTokens = (job.liveTokens ?? 0) > 0;

  // Build the agent display name with optional variant suffix
  const agentDisplay = variant ? `${job.agentName} @${variant}` : job.agentName;

  return (
    <Box>
      <Text color={color}>
        {"  "}
        {icon} {agentDisplay.padEnd(COL_AGENT_LIVE)} {label.padEnd(15)}
      </Text>
      {hasTime ? (
        <Box marginRight={1}>
          <LiveDuration startedAt={job.runStartedAt} finalMs={job.durationMs} active={active} color={color} />
        </Box>
      ) : null}
      {hasTokens ? <AnimatedTokens target={job.liveTokens ?? 0} active={active} isFinal={job.tokensFinal} /> : null}
    </Box>
  );
}

function groupByScenario(jobs: JobState[]): Array<{ scenarioKey: string; agents: JobState[] }> {
  const map = new Map<string, JobState[]>();
  for (const job of jobs) {
    const baseKey = getBaseKey(job.scenarioKey);
    const list = map.get(baseKey) ?? [];
    list.push(job);
    map.set(baseKey, list);
  }
  return Array.from(map, ([scenarioKey, agents]) => ({ scenarioKey, agents }));
}
