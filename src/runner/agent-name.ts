/** Characters that are unsafe in the model portion of a generated agent name. */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]+/g;

/**
 * Sanitize a model identifier for use in the generated agent name.
 *
 * Provider-prefixed models (e.g. OpenRouter's "anthropic/claude-3.5-sonnet")
 * contain slashes that would break the report filesystem layout
 * (`scenarios/{key}/{agent}.json`) and the `|` name split used to recover the
 * base agent. The raw model string is still passed verbatim to the agent CLI
 * via `--model`; only the derived display/identifier name is sanitized here.
 *
 * Slashes and other unsafe characters collapse to a single hyphen, so
 * "anthropic/claude-3.5-sonnet" becomes "anthropic-claude-3.5-sonnet".
 */
export function sanitizeModelForName(model: string): string {
  return model.replace(UNSAFE_NAME_CHARS, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build the base agent name from an adapter name and optional model.
 * Returns `{agent}|{sanitizedModel}` when a model is set, or `{agent}` otherwise.
 */
export function buildAgentBaseName(agent: string, model?: string): string {
  return model ? `${agent}|${sanitizeModelForName(model)}` : agent;
}
