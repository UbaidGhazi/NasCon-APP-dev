'use strict';
/**
 * Maps jest's per-file line coverage onto the six graded backend areas of §9.3
 * and writes COVERAGE.json at the repo root.
 *
 * Declaring a number you cannot back up voids that area's bonus, so this always
 * reports what jest actually measured — never a hand-typed figure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUMMARY = path.join(ROOT, 'coverage', 'coverage-summary.json');

// Which source files count toward which graded area.
const AREAS = {
  fixtures:  [/src[\\/]domain[\\/]fixtures[\\/]/, /src[\\/]routes[\\/]fixtures\.js$/],
  scoring:   [/src[\\/]domain[\\/]scoring\.js$/, /src[\\/]domain[\\/]sports\.js$/,
              /src[\\/]routes[\\/]events\.js$/, /src[\\/]routes[\\/]sports\.js$/,
              /src[\\/]signing\.js$/],
  standings: [/src[\\/]domain[\\/]standings\.js$/, /src[\\/]routes[\\/]standings\.js$/,
              /src[\\/]routes[\\/]leagues\.js$/],
  store:     [/src[\\/]domain[\\/]store\.js$/, /src[\\/]routes[\\/]store\.js$/,
              /src[\\/]pdf\.js$/],
  roster:    [/src[\\/]domain[\\/]roster\.js$/, /src[\\/]routes[\\/]roster\.js$/],
  rbac:      [/src[\\/]security\.js$/, /src[\\/]routes[\\/]rbac\.js$/,
              /src[\\/]middleware\.js$/],
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

function build() {
  if (!fs.existsSync(SUMMARY)) {
    console.error('No coverage summary found — writing zeros. Run jest with --coverage first.');
    return Object.fromEntries(Object.keys(AREAS).map((k) => [k, 0]));
  }

  const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
  const out = {};

  for (const [area, patterns] of Object.entries(AREAS)) {
    let covered = 0;
    let total = 0;
    for (const [file, data] of Object.entries(summary)) {
      if (file === 'total') continue;
      if (!patterns.some((p) => p.test(file))) continue;
      covered += data.lines.covered;
      total += data.lines.total;
    }
    out[area] = total === 0 ? 0 : round1((covered / total) * 100);
  }
  return out;
}

const report = build();
fs.writeFileSync(path.join(ROOT, 'COVERAGE.json'), JSON.stringify(report, null, 2) + '\n');

for (const [area, pct] of Object.entries(report)) {
  const flag = pct >= 85 ? 'bonus earned' : pct === 0 ? 'no files yet' : 'below 85% — no bonus';
  console.log(`  ${area.padEnd(10)} ${String(pct).padStart(5)}%   ${flag}`);
}
