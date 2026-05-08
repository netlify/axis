// Generates src/docs-site/public/sample-report.html by injecting the
// existing mock report data into the prebuilt report-ui template. The
// homepage iframes this file so visitors can interact with a real AXIS
// report without running anything.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

const TEMPLATE = resolve(PROJECT_ROOT, "dist", "report-ui", "index.html");
const MOCK_DATA = resolve(PROJECT_ROOT, "src", "report-ui", "public", "mock-data.json");
const OUTPUT = resolve(__dirname, "..", "public", "sample-report.html");

if (!existsSync(TEMPLATE)) {
  console.error(`[sample-report] template not found at ${TEMPLATE}`);
  console.error(`[sample-report] run "npm run build:report-ui" from the project root first.`);
  process.exit(1);
}

if (!existsSync(MOCK_DATA)) {
  console.error(`[sample-report] mock data not found at ${MOCK_DATA}`);
  process.exit(1);
}

const template = readFileSync(TEMPLATE, "utf-8");
const data = JSON.parse(readFileSync(MOCK_DATA, "utf-8"));
const sampleData = { ...data, reportId: "sample" };

const safeJson = JSON.stringify(sampleData).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const html = template.replace("__AXIS_REPORT_DATA__", () => safeJson);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, html);
console.log(`[sample-report] wrote ${OUTPUT} (${(html.length / 1024).toFixed(1)} KB)`);
