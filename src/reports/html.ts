import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportManifest } from "../types/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PLACEHOLDER = "__AXIS_REPORT_DATA__";

function findTemplate(): string {
  // From dist/reports/ → dist/report-ui/index.html (production)
  const sibling = path.join(__dirname, "..", "report-ui", "index.html");
  if (fs.existsSync(sibling)) return sibling;
  // From src/reports/ → dist/report-ui/index.html (dev/test)
  const fromRoot = path.join(__dirname, "..", "..", "dist", "report-ui", "index.html");
  if (fs.existsSync(fromRoot)) return fromRoot;
  throw new Error(`Report UI template not found. Run "npm run build:report-ui" first.`);
}

/**
 * Generate a self-contained HTML report page from a report manifest.
 * Reads the pre-built Astro template and injects the report data as JSON.
 */
export function generateReportHtml(report: ReportManifest): string {
  const template = fs.readFileSync(findTemplate(), "utf-8");
  // Escape < and > in JSON to prevent </script> from closing the tag prematurely
  const safeJson = JSON.stringify(report).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return template.replace(DATA_PLACEHOLDER, safeJson);
}
