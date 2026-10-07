import { callJudge, type JudgeCallOptions } from "./judge.js";
import { ScoringError } from "./errors.js";
import type { RunResult } from "../types/output.js";

/**
 * Call the judge and parse its reply, retrying up to `options.limits.retries`
 * times when the score would otherwise be withheld: the invocation failed or
 * `parse` rejected the reply (both surface as {@link ScoringError}). Any other
 * error is a bug and propagates immediately. The final failure keeps its
 * message, with the attempt count appended when retries were made.
 */
export async function callJudgeAndParse<T>(
  runResult: RunResult,
  prompt: string,
  options: JudgeCallOptions,
  parse: (responseText: string) => T,
): Promise<T> {
  const attempts = 1 + Math.max(0, Math.floor(options.limits?.retries ?? 0));
  for (let attempt = 1; ; attempt++) {
    try {
      return parse(await callJudge(runResult, prompt, options));
    } catch (err) {
      if (!(err instanceof ScoringError)) throw err;
      if (attempt >= attempts) {
        throw attempts > 1 ? new ScoringError(`${err.message} (after ${attempts} attempts)`) : err;
      }
      options.logger?.verbose?.(
        `Retrying ${options.scenarioName} for ${runResult.scenarioKey} (${runResult.agentName}), ` +
          `attempt ${attempt + 1}/${attempts}: ${err.message}`,
      );
    }
  }
}
