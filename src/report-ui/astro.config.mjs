import { defineConfig } from "astro/config";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  build: {
    inlineStylesheets: "always",
  },
  vite: {
    plugins: [viteSingleFile()],
  },
});
