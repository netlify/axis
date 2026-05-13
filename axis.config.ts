import type { AxisConfig } from "./dist/types/index.js";
export default {
  scenarios: "./scenarios",
  agents: ["codex"],
  settings: {
    limits: {
      scenario: {
        time_minutes: 3,
        tokens: 3000000,
      },
    },
  },
} satisfies AxisConfig;
