export { run } from "./runner/runner.js";
export type { RunOutput, RunResult, RunOptions } from "./runner/runner.js";
export { loadConfig, discoverScenarios } from "./config/loader.js";
export { getAdapter, registerAdapter } from "./adapters/registry.js";
export { createAgentAdapter } from "./adapters/base/agent-adapter.js";
export type {
  AgentAdapterSpec,
  SetupContext,
  StreamContext,
  ResultContext,
  AdapterResult,
} from "./adapters/base/agent-adapter.js";
export { createAcpBasedAdapter } from "./adapters/base/acp-adapter.js";
export type { AcpAdapterSpec } from "./adapters/base/acp-adapter.js";
export { scoreResults, scoreRunResult, buildScoredOutput } from "./scoring/index.js";
export { buildSparseIndex } from "./scoring/sparse-index.js";
export { getPromptTemplates, interpolate } from "./scoring/prompt-templates.js";
export type { PromptTemplate, PromptVariable } from "./scoring/prompt-templates.js";
export { categorizeInteraction } from "./transcript/categorize.js";
export { normalizeTranscript, toTranscriptAnalysis } from "./transcript/index.js";
export type {
  NormalizedEntry,
  NormalizedTranscript,
  ExtractedUrl,
  EntryAnalysis,
  TranscriptAnalysis,
} from "./transcript/index.js";
export { writeReportToStore, initReport, writeScenarioRawData, finalizeReport } from "./reports/writer.js";
export { listReports, readReport, readScenarioResult } from "./reports/reader.js";
export { generateReportHtml } from "./reports/html.js";
export {
  setBaseline,
  readBaseline,
  listBaselines,
  deleteBaseline,
  compareBaseline,
  DEFAULT_BASELINE_NAME,
} from "./baselines/index.js";
export * from "./types/index.js";
