/**
 * Declarative prompt templates for the AXIS scoring pipeline.
 *
 * Each template uses `{{variable}}` placeholders that are substituted at
 * runtime via `interpolate()`. The raw templates (with placeholders intact)
 * are exposed via `getPromptTemplates()` so documentation UIs can display
 * the exact prompts used during scoring.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a single placeholder variable within a prompt template. */
export interface PromptVariable {
  /** The placeholder name as it appears in `{{name}}`. */
  name: string;
  /** Human-readable description of what this variable contains. */
  description: string;
  /** Type hint for documentation purposes — not enforced at runtime. */
  type: "string" | "number" | "text";
  /** Whether the variable may legitimately resolve to an empty string. */
  optional?: boolean;
}

/** A self-describing prompt template for one stage of the scoring pipeline. */
export interface PromptTemplate {
  /** Unique identifier (also the record key returned by `getPromptTemplates`). */
  name: string;
  /** Human-readable description of what the prompt does. */
  description: string;
  /** Which scoring pipeline stage uses this prompt. */
  stage: "triage" | "deep_eval" | "goal_achievement";
  /** The template string with `{{variable}}` placeholders. */
  template: string;
  /** Metadata about each placeholder the template accepts. */
  variables: PromptVariable[];
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Replace `{{key}}` placeholders in `template` with values from `vars`.
 *
 * Throws if any placeholder in the template has no corresponding key in
 * `vars`. Numbers are coerced to strings via `String()`.
 */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: {{${key}}}`);
    }
    return String(vars[key]);
  });
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const TRIAGE_TEMPLATE: PromptTemplate = {
  name: "triage",
  description:
    "Scans the compressed transcript for patterns, classifies interactions, and flags areas of concern for deep evaluation.",
  stage: "triage",
  template: `You are an expert evaluator for AXIS, an AI agent testing framework.

You are analyzing an agent's execution trace to identify areas that need deeper evaluation.

SCENARIO: {{scenarioName}}

TASK GIVEN TO AGENT:
{{prompt}}

SPARSE INDEX ({{totalInteractions}} interactions):
{{sparseLines}}

STATS:
- Environment interactions: {{envInteractions}}
- Service interactions: {{svcInteractions}}
- Agent interactions: {{agentInteractions}}
- Errors: {{totalErrors}}
- Total duration: {{totalDurationMs}}ms

CONTEXT FOR EVALUATION:
- Tool discovery (e.g., ToolSearch, ListTools) and agent configuration reads are required infrastructure — do not flag as unnecessary unless genuinely redundant (same query repeated).
- Byte counts in sparse lines show total I/O transferred, not file content size. Small results are normal for write/edit confirmations.
- Tool durations include system overhead (SDK roundtrips, sandbox setup, process spawning) — do not flag interactions solely for being slow unless the agent caused the slowness through redundant or unnecessary work.
- If a service call (API request, web fetch) returned structured, usable content and the agent used it to complete the task, do not flag it for concerns about hypothetical missing content or page size.

INSTRUCTIONS:
Analyze this agent execution trace and identify areas of concern.

For each interaction you want to flag for deep evaluation, specify:
1. The interaction ID (#N)
2. Why it needs deeper review
3. Which dimensions to evaluate: success, speed, weight, relevance, necessity

Also identify any patterns across interactions:
- Repeated failures or retries
- Redundant service calls (same endpoint called multiple times)
- Excessive environment operations for simple tasks
- Wasted agent reasoning that didn't lead to progress
- Unnecessary interactions given prior context

Respond with ONLY valid JSON:
{
  "flaggedInteractions": [
    {"id": 1, "reason": "description of concern", "concerns": ["success", "relevance"]},
    ...
  ],
  "patterns": [
    {"description": "pattern description", "interactionIds": [1, 2, 3], "severity": "high"},
    ...
  ],
  "categoryNotes": {
    "environment": "summary of environment interaction quality",
    "service": "summary of service interaction quality",
    "agent": "summary of agent reasoning quality"
  }
}

Flag at most {{maxFlags}} interactions. Focus on the most significant issues.
Non-flagged interactions will receive default passing scores.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "totalInteractions", description: "Total number of interactions in the sparse index", type: "number" },
    { name: "sparseLines", description: "Truncated sparse index content", type: "text" },
    { name: "envInteractions", description: "Count of environment interactions", type: "number" },
    { name: "svcInteractions", description: "Count of service interactions", type: "number" },
    { name: "agentInteractions", description: "Count of agent interactions", type: "number" },
    { name: "totalErrors", description: "Total error count", type: "number" },
    { name: "totalDurationMs", description: "Total execution duration in milliseconds", type: "number" },
    { name: "maxFlags", description: "Maximum interactions to flag for deep review", type: "number" },
  ],
};

const DEEP_EVAL_TEMPLATE: PromptTemplate = {
  name: "deep_eval",
  description:
    "Comprehensive evaluation of ALL interactions for success, weight, contextRelevance, and necessity per category.",
  stage: "deep_eval",
  template: `You are an expert evaluator for AXIS, an AI agent testing framework.

You are performing a comprehensive evaluation of ALL interactions from an agent execution.

SCENARIO: {{scenarioName}}

TASK GIVEN TO AGENT:
{{prompt}}
{{triageSection}}
COMPLETE SPARSE INDEX ({{totalInteractions}} interactions):
{{sparseLines}}

STATS:
- Environment interactions: {{envInteractions}}
- Service interactions: {{svcInteractions}}
- Agent interactions: {{agentInteractions}}
- Errors: {{totalErrors}}
- Total duration: {{totalDurationMs}}ms

FULL INTERACTION CONTENT:
{{interactionContent}}

NOTE: Content shown above may be truncated for evaluation purposes. This does NOT mean the agent's actual tool results were truncated — evaluate based on the quality and structure of what is shown, not on apparent truncation boundaries.

EVALUATION DIMENSIONS (score each 0.0 to 1.0):
- success: Did the interaction complete without errors? Were the results correct and usable? Evaluate based on the actual content returned, not assumptions about what a "complete" result should look like. For service calls (API requests, web fetches), if the call returned structured, usable content and the agent used it successfully, score success high — do not speculate about content that might be missing or hypothesize about JS-gated pages or truncation.
- weight: Was the tool invocation right-sized for the operation? Evaluate whether the agent sent an appropriate amount of data to the tool and received a proportionate response. For environment tools (file writes, edits, shell commands), judge the tool operation — not the semantic quality of the content the agent chose to write. A 2KB file write is right-sized if the agent intended to write 2KB of content. For service calls, if the call returned the data the agent needed, it is right-sized — do not penalize because a page returned fewer bytes than expected. (1.0 = right-sized, 0.3 = bloated/wasteful)
- contextRelevance: Was the tool's output relevant and usable for the task? If the tool succeeded and the agent used the output to make progress, score 1.0. Only reduce this score if the output was genuinely irrelevant noise that the agent could not use. Do NOT reduce this score for content quality judgments (e.g., whether a summary was condensed enough, whether fetched content was comprehensive enough) — those are evaluated by goal achievement, not here. Agent-internal operations (tool discovery, planning) are necessary infrastructure — score based on whether they were needed. (1.0 = all useful/necessary, 0.0 = all noise)

For each CATEGORY present, also evaluate necessity:
- necessity (0.0 to 1.0): Were the interactions that the agent performed in this category necessary? Evaluate only what the agent actually did — do not penalize for hypothetical steps it could have taken. 1.0 = all interactions were necessary, 0.0 = all were unnecessary.
- List any interaction IDs that were unnecessary.

CONTEXT FOR EVALUATION:
- Tool discovery (e.g., ToolSearch, ListTools) and agent configuration reads are required infrastructure — do not flag as unnecessary unless genuinely redundant (same query repeated).
- Byte counts in sparse lines show total I/O transferred, not file content size. Small results are normal for write/edit confirmations.
- If a service call (API request, web fetch) returned structured, usable content and the agent used it to complete the task, do not flag it for concerns about hypothetical missing content or page size.

Respond with ONLY valid JSON:
{
  "audits": [
    {"id": 1, "category": "environment", "success": 0.9, "weight": 0.8, "contextRelevance": 0.6, "rationale": "brief explanation"},
    ...
  ],
  "necessity": [
    {"category": "environment", "score": 0.85, "unnecessaryIds": [4], "rationale": "brief explanation"},
    {"category": "service", "score": 0.7, "unnecessaryIds": [5, 6], "rationale": "brief explanation"},
    {"category": "agent", "score": 0.95, "unnecessaryIds": [], "rationale": "brief explanation"}
  ]
}

Include an audit for EVERY interaction listed above.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    {
      name: "triageSection",
      description: "Formatted triage analysis from the previous pass (empty when no triage data)",
      type: "text",
      optional: true,
    },
    { name: "totalInteractions", description: "Total number of interactions in the sparse index", type: "number" },
    { name: "sparseLines", description: "Complete sparse index content", type: "text" },
    { name: "envInteractions", description: "Count of environment interactions", type: "number" },
    { name: "svcInteractions", description: "Count of service interactions", type: "number" },
    { name: "agentInteractions", description: "Count of agent interactions", type: "number" },
    { name: "totalErrors", description: "Total error count", type: "number" },
    { name: "totalDurationMs", description: "Total execution duration in milliseconds", type: "number" },
    { name: "interactionContent", description: "Full formatted content for all interactions", type: "text" },
  ],
};

const GOAL_STRING_RUBRIC_TEMPLATE: PromptTemplate = {
  name: "goal_string_rubric",
  description: "Evaluates goal achievement when the rubric is a single string criterion.",
  stage: "goal_achievement",
  template: `You are an expert evaluator for an AI agent testing framework called AXIS.

An AI agent was given a task. You must evaluate how well it performed by reviewing its transcript AND by independently verifying the results yourself.

SCENARIO: {{scenarioName}}

TASK GIVEN TO AGENT:
{{prompt}}

---

AGENT TRANSCRIPT (condensed):
{{transcript}}

---

AGENT'S FINAL RESULT:
{{finalResult}}

---

RUBRIC:
{{rubric}}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — visit URLs, check endpoints, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. Score based on what you can verify, not just what the agent claims.

When done, respond with ONLY valid JSON on its own line:
{"score": <0-10>, "rationale": "<1-2 sentence explanation>"}

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "transcript", description: "Condensed agent transcript", type: "text" },
    { name: "finalResult", description: "The agent's final result text", type: "text" },
    { name: "rubric", description: "The evaluation criterion as a single string", type: "text" },
  ],
};

const GOAL_ARRAY_RUBRIC_TEMPLATE: PromptTemplate = {
  name: "goal_array_rubric",
  description: "Evaluates goal achievement when the rubric has multiple weighted criteria.",
  stage: "goal_achievement",
  template: `You are an expert evaluator for an AI agent testing framework called AXIS.

An AI agent was given a task. You must evaluate how well it performed by reviewing its transcript AND by independently verifying the results yourself.

SCENARIO: {{scenarioName}}

TASK GIVEN TO AGENT:
{{prompt}}

---

AGENT TRANSCRIPT (condensed):
{{transcript}}

---

AGENT'S FINAL RESULT:
{{finalResult}}

---

RUBRIC CRITERIA:
{{rubricText}}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — visit URLs, check endpoints, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. For each criterion, provide a score from 0 to 10 and a brief rationale.

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met.

When done, respond with ONLY valid JSON on its own line:
{"grades": [{"criterion_index": 0, "score": <0-10>, "rationale": "<string>"}, ...]}`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "transcript", description: "Condensed agent transcript", type: "text" },
    { name: "finalResult", description: "The agent's final result text", type: "text" },
    { name: "rubricText", description: "Formatted rubric criteria with weights", type: "text" },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all scoring prompt templates keyed by name.
 *
 * The templates contain `{{variable}}` placeholders — use `interpolate()`
 * to substitute runtime values, or display the raw template text in
 * documentation UIs.
 */
export function getPromptTemplates(): Record<string, PromptTemplate> {
  return {
    triage: TRIAGE_TEMPLATE,
    deep_eval: DEEP_EVAL_TEMPLATE,
    goal_string_rubric: GOAL_STRING_RUBRIC_TEMPLATE,
    goal_array_rubric: GOAL_ARRAY_RUBRIC_TEMPLATE,
  };
}
