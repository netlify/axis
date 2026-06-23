import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

import react from "@astrojs/react";

export default defineConfig({
  site: "https://axis.run",
  outDir: "../../dist/docs-site",
  integrations: [sitemap(), react()],
});