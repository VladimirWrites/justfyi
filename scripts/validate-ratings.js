#!/usr/bin/env node
/**
 * Validator for extension/data/ratings.json.
 *
 * Runs in CI on every push/PR. No external dependencies — pure Node.
 *
 * Fails if:
 *   - the file doesn't parse
 *   - the top level isn't an array of objects
 *   - an entry is missing a required field or has a bad type
 *   - `s` is not in 0..3
 *   - `cat` references an unknown category
 *   - a domain is duplicated
 *   - `rec: true` on an entry without `n` (curation rule)
 *
 * Keep the VALID_CATEGORIES / VALID_STATUSES lists in sync with
 * worker/src/index.js.
 */

const fs = require("node:fs");
const path = require("node:path");

const VALID_STATUSES = [0, 1, 2, 3];
const VALID_CATEGORIES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 999,
]);
const OPTIONAL_BOOLS = ["os", "rec", "lg", "ab", "sb"];

const RATINGS_PATH = path.resolve(
  __dirname, "..", "extension", "data", "ratings.json"
);

const errors = [];
function fail(i, msg) { errors.push(`entry ${i}: ${msg}`); }

const raw = fs.readFileSync(RATINGS_PATH, "utf8");
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`ratings.json failed to parse: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(data)) {
  console.error("ratings.json must be an array");
  process.exit(1);
}

const seen = new Map();
for (let i = 0; i < data.length; i++) {
  const e = data[i];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    fail(i, "not an object"); continue;
  }
  if (typeof e.d !== "string" || !e.d) fail(i, "missing `d` (domain)");
  if (!VALID_STATUSES.includes(e.s)) fail(i, `bad \`s\` ${e.s}`);

  if (e.d) {
    const prev = seen.get(e.d);
    if (prev !== undefined) fail(i, `duplicate domain \`${e.d}\` (first at entry ${prev})`);
    else seen.set(e.d, i);
  }

  // Out-of-scope entries carry only d and s.
  if (e.s === 0) {
    for (const k of Object.keys(e)) {
      if (k !== "d" && k !== "s") fail(i, `out-of-scope entry should not carry \`${k}\``);
    }
    continue;
  }

  // In-scope entries: os boolean + cat (number or non-empty array).
  if (typeof e.os !== "boolean") fail(i, "missing boolean `os`");

  const cats = Array.isArray(e.cat) ? e.cat : (typeof e.cat === "number" ? [e.cat] : null);
  if (!cats || cats.length === 0) fail(i, "missing `cat`");
  else {
    for (const c of cats) {
      if (!Number.isInteger(c)) fail(i, `cat \`${c}\` is not an integer`);
      else if (!VALID_CATEGORIES.has(c)) fail(i, `unknown cat \`${c}\``);
    }
  }

  if (e.n !== undefined && typeof e.n !== "string") fail(i, "`n` must be a string");

  for (const b of OPTIONAL_BOOLS) {
    if (b === "os") continue; // already enforced above
    if (e[b] !== undefined && typeof e[b] !== "boolean") {
      fail(i, `\`${b}\` must be boolean if present`);
    }
  }

  // Curation rule: `rec: true` must have a display name.
  if (e.rec === true && !e.n) fail(i, "recommended entries require `n`");
}

if (errors.length) {
  console.error(`ratings.json validation failed (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`ratings.json OK — ${data.length} entries, ${seen.size} unique domains.`);
