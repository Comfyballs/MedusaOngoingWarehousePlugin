#!/usr/bin/env node
// superpowers-setup managed file. setup-version: 4. Do not edit by hand; re-run /init-project to update.
// Fails if a status marker (checkbox or progress count) appears under docs/specs or docs/adr.
// Plans (docs/plans, docs/superpowers/plans) are exempt ephemeral scaffolding.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MARKERS = [
  /^\s*[-*]\s*\[[ xX]\]/m,          // task checkboxes
  /\b\d+\s*\/\s*\d+\s+(done|complete|tasks?)\b/i, // progress counts like 3/7 done
];

// Strip fenced code blocks first so documented checklist syntax is not flagged.
export function hasMarker(text) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  return MARKERS.some((re) => re.test(withoutFences));
}

// Guard side-effects behind a direct-invocation check so that importing this
// module does NOT trigger any I/O or process.exit calls.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);

if (isMain) {
  // Resolve the repo root so the guard scans the same files whatever the cwd.
  function repoRoot() {
    try { return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); }
    catch { return process.cwd(); }
  }

  const ROOT = repoRoot();
  const GUARDED = ['docs/specs', 'docs/adr'].map((p) => path.join(ROOT, p));

  function walk(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name.endsWith('.md')) acc.push(p);
    }
    return acc;
  }

  const offenders = [];
  for (const root of GUARDED) {
    for (const file of walk(root)) {
      if (hasMarker(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(ROOT, file));
    }
  }

  if (offenders.length) {
    console.error('assert:no-doc-status FAILED. Status markers belong in GitHub Issues, not these files:');
    for (const f of offenders) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('assert:no-doc-status ok');
}
