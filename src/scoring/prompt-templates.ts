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
  stage: "deep_eval" | "goal_achievement";
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

/**
 * Per-category evaluation guidance for focused judge prompts.
 *
 * Environment and service focus on EXECUTION QUALITY — did the tools/services
 * work correctly? The agent dimension evaluates DECISION QUALITY — did the
 * agent make good choices about what to invoke and how?
 */
export const CATEGORY_GUIDANCE: Record<string, string> = {
  environment: `You are evaluating ENVIRONMENT interactions — file system operations, shell commands, code edits, and local workspace manipulation.

Focus on EXECUTION QUALITY — did the tools work correctly? The agent's choice of what tools to invoke and with what parameters is evaluated separately under the agent dimension.

Key considerations:
- Execution success: Did operations complete without errors? Were results correct?
- Error handling: Were file-not-found, permission errors, or failed commands surfaced clearly?
- Result correctness: Did tools return valid, usable results for what was requested?
- System reliability: Were there unexpected failures, crashes, or timeouts?`,

  service: `You are evaluating SERVICE interactions — API calls, web fetches, external service requests, and network operations.

Focus on EXECUTION QUALITY — did the services respond correctly? The agent's choice of what APIs to call is evaluated separately under the agent dimension.

Key considerations:
- API success: Did calls return valid responses?
- Error handling: Were rate limits, auth errors, and timeouts surfaced clearly?
- Response quality: Did services return correct, complete data for what was requested?
- Reliability: Were there unexpected service failures or degraded responses?`,

  agent: `You are evaluating AGENT interactions — the agent's reasoning, planning, and decision-making quality.

Key considerations:
- Planning: Did the agent form a clear plan before acting, or did it thrash?
- Tool selection: Did the agent choose appropriate tools and parameters? Were invocations right-sized (not reading entire files when sections suffice, not using verbose flags unnecessarily)?
- Necessity: Were ALL interactions across ALL categories necessary? Did the agent invoke tools it didn't need?
- Information use: Did the agent effectively use the information it retrieved?
- Self-correction: When the agent detected errors, did it adjust efficiently?
- Tool discovery: Was tool/capability lookup necessary, or redundant exploration?`,
};

const CATEGORY_EVAL_TEMPLATE: PromptTemplate = {
  name: "category_eval",
  description:
    "Per-category evaluation of interactions. Environment/service evaluate execution quality (success only). Agent evaluates decision quality (success, weight, contextRelevance, necessity). Run once per category in parallel.",
  stage: "deep_eval",
  template: `You are an expert evaluator for AXIS, an AI agent testing framework.

You are evaluating the {{categoryName}} dimension of an agent execution. Focus ONLY on {{categoryName}} interactions, but use the full transcript context to understand the agent's overall behavior.

SCENARIO: {{scenarioName}}

TASK GIVEN TO AGENT:
{{prompt}}

COMPLETE SPARSE INDEX ({{totalInteractions}} total interactions, {{categoryInteractionCount}} are {{categoryName}}):
{{sparseLines}}

{{categoryName}} CATEGORY GUIDANCE:
{{categoryGuidance}}

{{categoryName}} INTERACTION DETAILS ({{categoryInteractionCount}} interactions):
{{interactionContent}}

RAW DATA FILES (for additional detail if needed):
{{dataDir}}

NOTE: Content shown above may be truncated for evaluation purposes. This does NOT mean the agent's actual tool results were truncated — evaluate based on the quality and structure of what is shown, not on apparent truncation boundaries.

EVALUATION DIMENSIONS (score each 0.0 to 1.0):
{{evaluationDimensions}}

{{necessitySection}}

Identify any patterns within {{categoryName}} interactions:
- Repeated failures or retries
- Redundant operations (same action performed multiple times)
- Excessive operations for simple tasks
- Wasted effort that didn't lead to progress

CONTEXT FOR EVALUATION:
- Tool discovery (e.g., ToolSearch, ListTools) and agent configuration reads are required infrastructure — do not flag as unnecessary unless genuinely redundant (same query repeated).
- Byte counts in sparse lines show total I/O transferred, not file content size. Small results are normal for write/edit confirmations.

{{responseFormat}}

Include an audit for EVERY {{categoryName}} interaction listed in the details above.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    {
      name: "categoryName",
      description: "The category being evaluated (environment, service, or agent)",
      type: "string",
    },
    { name: "totalInteractions", description: "Total number of interactions across all categories", type: "number" },
    {
      name: "categoryInteractionCount",
      description: "Number of interactions in this specific category",
      type: "number",
    },
    { name: "sparseLines", description: "Complete sparse index content (all categories)", type: "text" },
    { name: "categoryGuidance", description: "Category-specific evaluation guidance", type: "text" },
    {
      name: "interactionContent",
      description: "Full formatted content for this category's interactions only",
      type: "text",
    },
    {
      name: "dataDir",
      description: "Path to the report directory containing raw data files",
      type: "string",
      optional: true,
    },
    {
      name: "evaluationDimensions",
      description: "Per-category dimension descriptions (success-only for env/service, all for agent)",
      type: "text",
    },
    {
      name: "necessitySection",
      description: "Necessity evaluation instructions (present for agent, empty for env/service)",
      type: "text",
      optional: true,
    },
    {
      name: "responseFormat",
      description: "Expected JSON response format (varies by category)",
      type: "text",
    },
  ],
};

const GOAL_STRING_RUBRIC_TEMPLATE: PromptTemplate = {
  name: "goal_string_rubric",
  description: "Evaluates goal achievement when the rubric is a single string criterion.",
  stage: "goal_achievement",
  template: `You are an expert evaluator for an AI agent testing framework called AXIS.

An AI agent was given a task. You must evaluate how well it performed based on the evidence in its transcript.

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
2. Where possible, independently verify the results — check the filesystem for created/modified files, visit URLs, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.

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
    category_eval: CATEGORY_EVAL_TEMPLATE,
    goal_string_rubric: GOAL_STRING_RUBRIC_TEMPLATE,
    goal_array_rubric: GOAL_ARRAY_RUBRIC_TEMPLATE,
  };
}
