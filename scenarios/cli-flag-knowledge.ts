import type { ScenarioInput } from "../src/types/scenario.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "cli-flag-knowledge",
  name: "Pick the right axis run flags for common situations",

  prompt:
    "Write `commands.md` in the workspace root. For each of the following five situations, give the exact single-line `axis run` command (or `axis baseline` command where appropriate) that would do the job. Use real AXIS CLI flags. Do not invent flags. Do not write multi-step procedures.\n\n" +
    "1. Run only scenarios whose key starts with `cms/`, against every configured agent.\n" +
    "2. Run only the `claude-code` agent against every scenario, with detailed per-step logging.\n" +
    "3. Run everything but skip the LLM judges (raw results only, no scoring).\n" +
    "4. Re-run only the failed scenario/agent pairs from the most recent report.\n" +
    "5. Run everything and immediately diff the results against the saved `main` baseline.",

  judge: [
    { check: "File `commands.md` exists in the workspace root", weight: 0.05 },
    {
      check: "Situation 1 uses `axis run --scenario 'cms/*'` (or `-s 'cms/*'`); no extra unrelated flags",
      weight: 0.2,
    },
    {
      check:
        "Situation 2 uses `axis run --agent claude-code` (or `-a claude-code`) together with `--verbose` (or `-v`); no extra unrelated flags",
      weight: 0.2,
    },
    { check: "Situation 3 uses `axis run --no-score`; no extra unrelated flags", weight: 0.15 },
    {
      check: "Situation 4 uses `axis run --failed` (with `latest` or no argument); no extra unrelated flags",
      weight: 0.15,
    },
    {
      check: "Situation 5 uses `axis run --compare-baseline` (with `main` or no argument); no extra unrelated flags",
      weight: 0.15,
    },
    {
      check:
        "Does NOT invent flags such as `--filter`, `--only`, `--agents`, `--scenarios`, `--retry`, `--rerun`, `--diff`, `--baseline`, or `--skip-score`",
      weight: 0.1,
    },
  ],

  artifacts: ["commands.md"],
}) satisfies ScenarioInput;
