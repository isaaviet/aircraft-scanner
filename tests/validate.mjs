#!/usr/bin/env node
/**
 * Run before every commit (or wire into a pre-commit hook / CI step):
 *   node tests/validate.mjs
 *
 * Checks that would otherwise only surface as a silent blank <img> in
 * production:
 *   - every manifest entry's file actually exists in liveries/
 *   - every file in liveries/ has a manifest entry (nothing orphaned)
 *   - every airlineIcao in the manifest is a real code in db/airlines.json
 *     (catches typos like "EK" instead of "UAE" — IATA vs ICAO mixups
 *     are the single most common mistake here)
 *   - every typeCode in the manifest actually appears in db/aircraft.sqlite
 *     as a real type_code (catches "A380" instead of "A388")
 *   - no duplicate (typeCode, airlineIcao) pairs — silently shadows one
 *     of the two liveries otherwise, matcher.js keeps whichever loaded first
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { DatabaseSync } from 'node:sqlite'; // Node 22+. Older Node: swap for better-sqlite3.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIVERIES_DIR = path.join(ROOT, 'liveries');
const MANIFEST_PATH = path.join(LIVERIES_DIR, 'manifest.json');
const AIRLINES_PATH = path.join(ROOT, 'db', 'airlines.json');
const SQLITE_PATH = path.join(ROOT, 'db', 'aircraft.sqlite');

let errors = 0;
let warnings = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); errors++; };
const warn = (msg) => { console.warn(`! ${msg}`); warnings++; };
const ok = (msg) => console.log(`✓ ${msg}`);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const airlines = JSON.parse(readFileSync(AIRLINES_PATH, 'utf8'));

const filesOnDisk = new Set(
  readdirSync(LIVERIES_DIR).filter(f => /\.(webp|png|jpg|jpeg|svg)$/i.test(f))
);
const filesInManifest = new Set();
const seenPairs = new Map();

// Pull the set of real type codes out of the sqlite db once.
let validTypes = new Set();
try {
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const rows = db.prepare('SELECT DISTINCT type_code FROM airframe WHERE type_code IS NOT NULL').all();
  validTypes = new Set(rows.map(r => r.type_code));
  db.close();
} catch (e) {
  warn(`Couldn't open aircraft.sqlite to validate type codes (${e.message}). Skipping that check.`);
}

for (const entry of manifest.liveries || []) {
  const { file, match = {}, accent } = entry;

  if (!file) { fail('entry missing "file"'); continue; }
  filesInManifest.add(file);
  if (!filesOnDisk.has(file)) fail(`manifest references "${file}" but it's not in liveries/`);

  const t = (match.typeCode || '').toUpperCase();
  const a = (match.airlineIcao || '').toUpperCase();
  if (!t && !a) fail(`"${file}": match needs at least typeCode or airlineIcao`);

  if (a) {
    if (a.length !== 3) fail(`"${file}": airlineIcao "${a}" isn't 3 characters — likely an IATA code (2 chars) was used instead of ICAO`);
    else if (!airlines[a]) warn(`"${file}": airlineIcao "${a}" not found in db/airlines.json — could be a defunct/regional carrier not in OpenFlights, double check it's not a typo`);
  }
  if (t && validTypes.size && !validTypes.has(t)) {
    warn(`"${file}": typeCode "${t}" not found among ${validTypes.size} known type codes in aircraft.sqlite — check ICAO DOC8643 spelling (e.g. A388 not A380)`);
  }
  if (accent && !/^#[0-9A-Fa-f]{6}$/.test(accent)) fail(`"${file}": accent "${accent}" isn't a valid #RRGGBB color`);

  if (t && a) {
    const key = `${t}:${a}`;
    if (seenPairs.has(key)) fail(`duplicate match ${key}: "${seenPairs.get(key)}" and "${file}" both claim it — matcher.js will only ever return one`);
    seenPairs.set(key, file);
  }
}

for (const f of filesOnDisk) {
  if (!filesInManifest.has(f)) warn(`"${f}" exists in liveries/ but has no manifest entry — it will never be shown`);
}

console.log('');
if (errors === 0 && warnings === 0) ok(`${filesInManifest.size} liveries validated clean`);
else console.log(`${filesInManifest.size} liveries checked: ${errors} error(s), ${warnings} warning(s)`);

process.exit(errors > 0 ? 1 : 0);
