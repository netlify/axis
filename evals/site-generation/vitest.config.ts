import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from the repo's vitest config so `npm test` and CI are unaffected:
//   npx vitest run --config evals/site-generation/vitest.config.ts
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
  },
});
