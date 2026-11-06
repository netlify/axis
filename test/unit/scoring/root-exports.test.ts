import { describe, expect, it } from "vitest";
import * as axis from "../../../src/index.js";
import { runDeepEval, computeHeuristicSpeed, parseCategoryEvalResponse } from "../../../src/scoring/deep-eval.js";
import { computeCategoryScore, aggregateDimension } from "../../../src/scoring/category-score.js";
import { parseJsonFromText } from "../../../src/scoring/parse-json.js";

describe("package root exports", () => {
  it("re-exports the scoring internals that programmatic consumers import", () => {
    const expected = {
      runDeepEval,
      computeHeuristicSpeed,
      parseCategoryEvalResponse,
      computeCategoryScore,
      aggregateDimension,
      parseJsonFromText,
    };
    for (const [name, fn] of Object.entries(expected)) {
      expect(axis[name as keyof typeof axis], name).toBe(fn);
    }
  });
});
