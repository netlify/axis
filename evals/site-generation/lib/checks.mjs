#!/usr/bin/env node
// Script checks for a generated site, run from each scenario's teardown in
// the agent workspace. No dependencies and no browser: regex-level HTML/CSS
// inspection, so treat results as exact counts of what's *declared*, not a
// rendered-page audit. Writes `site-checks.json` (captured as an artifact) and
// a short summary to $AXIS_OUTPUT so it shows in the AXIS report.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const SITE = path.resolve(process.argv[2] ?? "site");
const OUT = path.resolve(process.argv[3] ?? "site-checks.json");

const checks = [];
function record(vertical, id, hits, total, detail = []) {
  checks.push({ vertical, id, hits, total, detail: detail.slice(0, 20) });
}

const files = fs.existsSync(SITE) ? walk(SITE) : [];
const pages = files.filter((f) => f.endsWith(".html"));
const html = new Map(pages.map((f) => [f, fs.readFileSync(f, "utf-8")]));
const css = files.filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(f, "utf-8"));
for (const source of html.values()) css.push(...matchAll(source, /<style[^>]*>([\s\S]*?)<\/style>/gi).map((m) => m[1]));

record("functional", "index-exists", fs.existsSync(path.join(SITE, "index.html")) ? 1 : 0, 1);

// Local references (href/src) resolve to files; in-page anchors resolve to ids.
{
  let ok = 0;
  let total = 0;
  const broken = [];
  for (const [file, source] of html) {
    const ids = new Set(matchAll(source, /\sid=["']([^"']+)["']/gi).map((m) => m[1]));
    for (const [, ref] of matchAll(source, /\s(?:href|src)=["']([^"']*)["']/gi)) {
      if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(ref) || ref === "") continue;
      total++;
      const [target, hash] = ref.split("#");
      const exists = target === "" ? hash === undefined || hash === "" || ids.has(hash) : resolveLocal(file, target);
      if (exists) ok++;
      else broken.push(`${rel(file)}: ${ref}`);
    }
  }
  record("functional", "local-refs-resolve", ok, total, broken);
}

// Scripts parse. Classic scripts are compiled (not run) with vm.Script; module
// scripts can't be, so they're counted as unknown rather than failures.
{
  let ok = 0;
  let total = 0;
  const errors = [];
  const sources = [];
  for (const [file, source] of html) {
    for (const [, attrs, body] of matchAll(source, /<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/type=["']module["']/i.test(attrs) || /\ssrc=/i.test(attrs)) continue;
      if (/type=["'](?!text\/javascript|application\/javascript)[^"']+["']/i.test(attrs)) continue;
      sources.push([`${rel(file)} inline`, body]);
    }
  }
  for (const f of files.filter((f) => f.endsWith(".js"))) sources.push([rel(f), fs.readFileSync(f, "utf-8")]);
  for (const [label, code] of sources) {
    if (/^\s*(import|export)\s/m.test(code)) continue;
    total++;
    try {
      new vm.Script(code, { filename: label });
      ok++;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  record("js-errors", "scripts-parse", ok, total, errors);
}

perPage("mobile", "viewport-meta", (s) => /<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(s));
record(
  "mobile",
  "has-media-queries-or-fluid-layout",
  css.some((c) => /@media|display:\s*(flex|grid)|clamp\(|minmax\(/i.test(c)) ? 1 : 0,
  1,
);
perPage("accessibility", "html-lang", (s) => /<html\b[^>]*\slang=["'][^"']+["']/i.test(s));
perPage("accessibility", "single-h1", (s) => matchAll(s, /<h1[\s>]/gi).length === 1);
perPage("accessibility", "has-landmarks", (s) =>
  ["header", "nav", "main", "footer"].every((t) => new RegExp(`<${t}[\\s>]`, "i").test(s)),
);

// Every <img> has an alt attribute (empty alt is valid for decorative images).
{
  let ok = 0;
  let total = 0;
  const missing = [];
  for (const [file, source] of html) {
    for (const [tag] of matchAll(source, /<img\b[^>]*>/gi)) {
      total++;
      if (/\salt=["'][^"']*["']/i.test(tag)) ok++;
      else missing.push(`${rel(file)}: ${tag.slice(0, 80)}`);
    }
  }
  record("accessibility", "img-alt", ok, total, missing);
}

// Contrast for CSS rules that declare both a text color and a background
// color as hex/rgb literals. Custom properties and inherited colors aren't
// resolved, so this checks declared pairs only.
{
  let ok = 0;
  let total = 0;
  const failing = [];
  const vars = new Map();
  for (const sheet of css) {
    for (const [, name, value] of matchAll(sheet, /(--[\w-]+)\s*:\s*([^;}]+)/g)) vars.set(name, value.trim());
  }
  const resolve = (value) => value.replace(/var\((--[\w-]+)[^)]*\)/g, (_, n) => vars.get(n) ?? "");
  for (const sheet of css) {
    for (const [, selector, body] of matchAll(sheet, /([^{}]+)\{([^{}]*)\}/g)) {
      const fg = /(?:^|;|\s)color\s*:\s*([^;]+)/i.exec(body)?.[1];
      const bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(body)?.[1];
      const a = fg && parseColor(resolve(fg));
      const b = bg && parseColor(resolve(bg));
      if (!a || !b) continue;
      total++;
      const ratio = contrast(a, b);
      if (ratio >= 4.5) ok++;
      else failing.push(`${selector.trim().slice(0, 60)}: ${ratio.toFixed(2)}:1`);
    }
  }
  record("accessibility", "declared-contrast-aa", ok, total, failing);
}

fs.writeFileSync(OUT, JSON.stringify({ site: path.basename(SITE), pages: pages.length, checks }, null, 2));
if (process.env.AXIS_OUTPUT) {
  const lines = checks.map((c) => `| ${c.vertical} | ${c.id} | ${c.hits}/${c.total} |`);
  fs.appendFileSync(
    process.env.AXIS_OUTPUT,
    `### Site checks\n\n| Vertical | Check | Passed |\n| --- | --- | --- |\n${lines.join("\n")}\n`,
  );
}

function perPage(vertical, id, test) {
  const failing = [...html].filter(([, s]) => !test(s)).map(([f]) => rel(f));
  record(vertical, id, html.size - failing.length, html.size, failing);
}

function resolveLocal(fromFile, target) {
  const clean = decodeURIComponent(target.split("?")[0]);
  const abs = clean.startsWith("/") ? path.join(SITE, clean) : path.resolve(path.dirname(fromFile), clean);
  return fs.existsSync(abs) && (fs.statSync(abs).isFile() || fs.existsSync(path.join(abs, "index.html")));
}

function parseColor(value) {
  const v = value.trim().toLowerCase();
  let m = /#([0-9a-f]{3,8})\b/.exec(v);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return [m[1], m[2], m[3]].map(Number);
  if (/\bwhite\b/.test(v)) return [255, 255, 255];
  if (/\bblack\b/.test(v)) return [0, 0, 0];
  return null;
}

function contrast(a, b) {
  const lum = (rgb) => {
    const [r, g, bl] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function matchAll(s, re) {
  return [...s.matchAll(re)];
}

function rel(f) {
  return path.relative(SITE, f) || path.basename(f);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === "node_modules" ? [] : walk(full)) : [full];
  });
}
