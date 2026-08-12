/**
 * Signals that a score must be WITHHELD rather than emitted.
 *
 * Thrown when scoring cannot be trusted to produce a meaningful composite:
 * a judge invocation died with no output, or its response could not be parsed.
 * In these cases emitting a number (goal 0 + default category scores ≈ 57)
 * would be indistinguishable from a genuinely mediocre run and would pollute
 * the gate. `scoreRunResult` catches this and marks the run failed instead, so
 * the score is withheld, the cell can be retried, and a persistent failure
 * surfaces loudly.
 */
export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoringError";
  }
}
