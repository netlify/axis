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

/** Per-category evaluation guidance for focused judge prompts. */
export const CATEGORY_GUIDANCE: Record<string, string> = {
  environment: `You are evaluating ENVIRONMENT interactions — file system operations, shell commands, code edits, and local workspace manipulation.

Key considerations:
- File reads/writes: Was the operation necessary? Was it right-sized (not reading entire files when a section would suffice)?
- Shell commands: Did they succeed? Were they idempotent or did they cause side effects?
- Code edits: Were they precise (targeted edits vs. rewriting entire files)?
- Error recovery: Did the agent handle file-not-found, permission errors, or failed commands well?
- Workspace hygiene: Did the agent clean up temp files, avoid polluting the workspace?`,

  service: `You are evaluating SERVICE interactions — API calls, web fetches, external service requests, and network operations.

Key considerations:
- API calls: Were they well-formed? Did the agent handle rate limits, auth errors, and timeouts?
- Web fetches: Did the agent fetch relevant pages? Were redundant fetches avoided?
- Data handling: Was response data used effectively or was it fetched and ignored?
- Error recovery: Did the agent retry appropriately on transient failures?
- Efficiency: Were batch operations used when available instead of multiple individual calls?`,

  agent: `You are evaluating AGENT interactions — the agent's own reasoning, planning, tool discovery, and communication.

Key considerations:
- Planning: Did the agent form a clear plan before acting, or did it thrash?
- Tool discovery: Was tool/capability lookup necessary, or was it redundant exploration?
- Reasoning quality: Was the agent's reasoning focused and productive?
- Human interaction: Were questions to the user clear and necessary, or could the agent have proceeded independently?
- Self-correction: When the agent detected errors, did it adjust its approach efficiently?`,
};

const CATEGORY_EVAL_TEMPLATE: PromptTemplate = {
  name: "category_eval",
  description:
    "Per-category evaluation of interactions for success, weight, contextRelevance, necessity, and patterns. Run once per category (environment, service, agent) in parallel.",
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
- success: Did the interaction complete without errors? Were the results correct and usable? Evaluate based on the actual content returned, not assumptions about what a "complete" result should look like.
- weight: Was the tool invocation right-sized for the operation? Evaluate whether the agent sent an appropriate amount of data to the tool and received a proportionate response. (1.0 = right-sized, 0.3 = bloated/wasteful)
- contextRelevance: Was the tool's output relevant and usable for the task? If the tool succeeded and the agent used the output to make progress, score 1.0. Only reduce this score if the output was genuinely irrelevant noise that the agent could not use. (1.0 = all useful/necessary, 0.0 = all noise)

Also evaluate NECESSITY for the {{categoryName}} category as a whole:
- necessity (0.0 to 1.0): Were the {{categoryName}} interactions necessary for the task? Evaluate only what the agent actually did — do not penalize for hypothetical steps it could have taken. 1.0 = all interactions were necessary, 0.0 = all were unnecessary.
- List any interaction IDs that were unnecessary.

Identify any patterns within {{categoryName}} interactions:
- Repeated failures or retries
- Redundant operations (same action performed multiple times)
- Excessive operations for simple tasks
- Wasted effort that didn't lead to progress

CONTEXT FOR EVALUATION:
- Tool discovery (e.g., ToolSearch, ListTools) and agent configuration reads are required infrastructure — do not flag as unnecessary unless genuinely redundant (same query repeated).
- Byte counts in sparse lines show total I/O transferred, not file content size. Small results are normal for write/edit confirmations.

Respond with ONLY valid JSON:
{
  "audits": [
    {"id": 1, "success": 0.9, "weight": 0.8, "contextRelevance": 0.6, "rationale": "brief explanation"},
    ...
  ],
  "necessity": {"score": 0.85, "unnecessaryIds": [4], "rationale": "brief explanation"},
  "patterns": [
    {"description": "pattern description", "interactionIds": [1, 2, 3], "severity": "high"},
    ...
  ]
}

Include an audit for EVERY {{categoryName}} interaction listed in the details above.`,
  variables: [
    { name: "scenarioName", description: "Name of the test scenario", type: "string" },
    { name: "prompt", description: "The original task prompt given to the agent", type: "text" },
    { name: "categoryName", description: "The category being evaluated (environment, service, or agent)", type: "string" },
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
