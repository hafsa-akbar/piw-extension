#!/usr/bin/env node
// Tamper check for downloaded piw_*.json files. Usage: node scripts/verify.js file.json [more.json ...]
// VALID/INVALID is the HMAC verdict over canonical JSON (whitespace, key order, line endings, BOM don't matter);
// soft notes flag cosmetic edits (reformatted, renamed) that leave the data intact. Exits 1 if any file isn't VALID.
// canon and SIG_KEY must match sidepanel.js. Files from extension versions ≤1.1 are unsigned.
const { createHmac } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename } = require("node:path");

const SIG_KEY = "0f4d3a579a13ac7277591e41c8bc7f6c6e20a62e81f402036f00da6c93c563b5";
const canon = (v) => Array.isArray(v) ? `[${v.map((x) => canon(x === undefined ? null : x)).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v);

let bad = 0;
for (const path of process.argv.slice(2)) {
  let verdict; const notes = [];
  try {
    const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
    const data = JSON.parse(raw);
    const { integrity, ...rest } = data;
    verdict = !integrity ? "UNSIGNED" : integrity === createHmac("sha256", SIG_KEY).update(canon(rest)).digest("hex") ? "VALID" : "INVALID";
    if (verdict === "VALID") {
      if (raw !== JSON.stringify(data, null, 2)) notes.push("reformatted (data intact)");
      const name = `piw_${(rest.participant_id || "participant").replace(/\W+/g, "_")}_${(rest.completed_at || "").slice(0, 10)}.json`;
      if (basename(path) !== name) notes.push(`renamed (expected ${name})`);
      if (!(rest.started_at <= rest.completed_at)) notes.push("timestamps out of order");
    }
  } catch (e) { verdict = `UNREADABLE (${e.message})`; }
  if (verdict !== "VALID") bad++;
  console.log(`${verdict === "VALID" ? "✓" : "✗"} ${path}: ${verdict}${notes.length ? " — " + notes.join(", ") : ""}`);
}
process.exit(bad ? 1 : 0);
