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

Evaluate ONLY whether the environment itself executed reliably. You are NOT judging whether the agent picked the right command or whether the output was useful for the task — those are the agent's decisions, evaluated separately under the agent dimension. If the agent ran \`ls\` and got back a list of files, that is a SUCCESS for the environment regardless of whether \`ls\` was a smart move.

Key considerations:
- Did commands run to completion, or did the shell/filesystem/tool error out (file-not-found, permission denied, syntax errors, exit code != 0, crashes, timeouts)?
- Were error messages surfaced clearly, or did they obscure what went wrong?
- Were there unexpected failures or flakiness from the environment itself (not from the agent's choice of input)?

Do NOT lower scores because:
- The output was unrelated to the task (that's the agent's tool choice — judged elsewhere)
- The agent could have used a better command (that's the agent's decision — judged elsewhere)
- The result wasn't what the agent "needed" (that's relevance — judged elsewhere)`,

  service: `You are evaluating SERVICE interactions — API calls, web fetches, external service requests, and network operations.

Evaluate ONLY whether the services themselves responded reliably. You are NOT judging whether the agent picked the right API or whether the response was useful for the task — those are the agent's decisions, evaluated separately under the agent dimension. A successful API call that returned valid data is a SUCCESS for the service even if the agent didn't need to make the call.

Key considerations:
- Did API calls complete and return well-formed responses?
- Were rate limits, auth errors, 5xx responses, network timeouts, or malformed payloads surfaced clearly?
- Were there unexpected service failures or degraded responses from the service itself?

Do NOT lower scores because:
- The agent didn't need to call this service (that's necessity — judged elsewhere)
- The response wasn't relevant to the task (that's the agent's choice — judged elsewhere)`,

  agent: `You are evaluating AGENT decisions — every tool invocation across ALL categories (environment, service, and agent-internal) is an agent decision, plus the agent's own reasoning and planning.

You audit EVERY interaction in the run, not just the ones tagged "agent". For each one ask: was this the right call to make, was it right-sized, did the result help the task?

Key considerations:
- Tool selection: Did the agent choose appropriate tools and parameters for what it was trying to accomplish? Even a shell \`ls\` is the agent's choice — was it warranted?
- Right-sizing (weight): Were invocations proportionate? Reading an entire file when a section suffices, running a verbose command when a focused one would do, fetching all records when one was needed, etc. score worse.
- Information use (contextRelevance): Did the output of the tool actually serve the task? If the agent invoked something whose output it ignored or that returned noise, mark it down. If the agent productively used the result, score 1.0.
- Necessity: Were ALL interactions across ALL categories necessary? Did the agent invoke tools it didn't need?
- Planning and self-correction: Did the agent form a coherent plan, and when something errored, did it adjust efficiently?
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

IMPORTANT: The sparse index and interaction details above are the COMPLETE authoritative record of this agent's execution. Base your scores strictly on the evidence presented. If an interaction succeeded and produced useful results, score it 1.0 — do not hedge or reduce scores based on speculation about unseen information.

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

const GOAL_STRING_JUDGE_TEMPLATE: PromptTemplate = {
  name: "goal_string_judge",
  description: "Evaluates goal achievement when the judge is a single string criterion.",
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

EXECUTION STATS:
{{executionStats}}

---

JUDGE:
{{judge}}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — check the filesystem for created/modified files, visit URLs, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. Evaluate ONLY what the criterion asks for. If the criterion is fully satisfied, score 10 — do not deduct for adjacent concerns, code-quality preferences, defensive-coding ideas, alternative implementations, or anything else the criterion did not request. Out-of-scope observations are not grounds for a lower score.

When done, respond with ONLY valid JSON on its own line:
{"score": <0-10>, "rationale": "<1-2 sentence explanation>"}

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met. Reserve scores below 10 for cases where the criterion itself is incomplete or wrong, not for unrelated nitpicks.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "transcript", description: "Condensed agent transcript", type: "text" },
    { name: "finalResult", description: "The agent's final result text", type: "text" },
    { name: "executionStats", description: "Human-readable duration and token usage for the run", type: "string" },
    { name: "judge", description: "The evaluation criterion as a single string", type: "text" },
  ],
};

const GOAL_ARRAY_JUDGE_TEMPLATE: PromptTemplate = {
  name: "goal_array_judge",
  description: "Evaluates goal achievement when the judge has multiple weighted criteria.",
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

EXECUTION STATS:
{{executionStats}}

---

JUDGE CRITERIA:
{{judgeText}}

---

INSTRUCTIONS:
1. Review the transcript to understand what the agent did.
2. Where possible, independently verify the results — visit URLs, check endpoints, confirm that the claimed outcomes actually exist. Do not trust the transcript alone.
3. For each criterion, provide a score from 0 to 10 and a brief rationale.
4. Evaluate each criterion ONLY against what it asks for. If a criterion is fully satisfied, score it 10 — do not deduct for adjacent concerns, code-quality preferences, defensive-coding ideas, alternative implementations, or anything else the criterion did not request. Out-of-scope observations are not grounds for a lower score. Concerns about a different criterion belong to that criterion, not this one.

Score guide: 0 = not met at all, 5 = partially met, 10 = fully met. Reserve scores below 10 for cases where the criterion itself is incomplete or wrong, not for unrelated nitpicks.

When done, respond with ONLY valid JSON on its own line:
{"grades": [{"criterion_index": 0, "score": <0-10>, "rationale": "<string>"}, ...]}`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "transcript", description: "Condensed agent transcript", type: "text" },
    { name: "finalResult", description: "The agent's final result text", type: "text" },
    { name: "executionStats", description: "Human-readable duration and token usage for the run", type: "string" },
    { name: "judgeText", description: "Formatted judge criteria with weights", type: "text" },
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
    goal_string_judge: GOAL_STRING_JUDGE_TEMPLATE,
    goal_array_judge: GOAL_ARRAY_JUDGE_TEMPLATE,
  };
}
