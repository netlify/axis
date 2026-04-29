/** Snapshot of a single scenario×agent score for baseline comparison. */
export interface BaselineEntry {
  axisScore: number;
  goalAchievement: number;
  environment: number;
  service: number;
  agent: number;
  durationMs: number;
  tokens: number;
  fromReportId: string;
  timestamp: string;
}

/** Scenario key → agent name → baseline entry. */
export type BaselineResults = Record<string, Record<string, BaselineEntry>>;

/** A named baseline — accumulated collection of score snapshots. */
export interface Baseline {
  name: string;
  createdAt: string;
  updatedAt: string;
  results: BaselineResults;
}

/** A single row in a baseline comparison. */
export interface BaselineComparisonEntry {
  scenarioKey: string;
  agentName: string;
  baseline: number;
  current: number;
  delta: number;
  categories: {
    goalAchievement: { baseline: number; current: number; delta: number };
    environment: { baseline: number; current: number; delta: number };
    service: { baseline: number; current: number; delta: number };
    agent: { baseline: number; current: number; delta: number };
  };
}

/** Result of comparing a report against a baseline. */
export interface BaselineComparison {
  baselineName: string;
  reportId: string;
  entries: BaselineComparisonEntry[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    /** Scenarios in the report that don't exist in the baseline. */
    newScenarios: number;
  };
}
