#!/usr/bin/env node
// superpowers-setup managed file. setup-version: 4. Do not edit by hand; re-run /init-project to update.
// PreToolUse hook: blocks Edit/Write to docs/specs or docs/adr when the
// pending content contains a status marker (checkbox or progress count).
// Reads hook JSON from stdin; exits 2 with a stderr reason to block, exits 0 to allow.
import fs from 'node:fs';
import path from 'node:path';
import { hasMarker } from './doc-status-guard.mjs';

// Guarded directories (as path segments, relative to any repo root).
// A file is guarded if its normalized path contains one of these as a directory.
const GUARDED_SEGMENTS = ['docs/specs', 'docs/adr'];

function isGuarded(filePath) {
  if (!filePath) return false;
  // Normalize separators to forward-slash for reliable substring matching.
  const normalized = filePath.split(path.sep).join('/');
  return GUARDED_SEGMENTS.some((seg) =>
    normalized.includes(`/${seg}/`) || normalized.includes(`/${seg}`)
  );
}

async function main() {
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8'); // fd 0, not '/dev/stdin' — the latter is non-portable for piped stdin (works on macOS, fails on Linux)
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed stdin — allow (fail open)
  }

  const toolInput = input?.tool_input ?? {};
  const filePath = toolInput.file_path ?? '';

  if (!isGuarded(filePath)) {
    process.exit(0); // not a guarded path — allow
  }

  // For Write: content is in tool_input.content
  // For Edit: pending content is in tool_input.new_string
  const content = toolInput.content ?? toolInput.new_string ?? '';

  if (hasMarker(content)) {
    process.stderr.write(
      `doc-status-guard: status markers (checkboxes or progress counts) are not allowed in ${filePath}.\n`
      + 'Status belongs in GitHub Issues, not in docs/specs or docs/adr.\n'
      + 'Move tracking to a GitHub Issue instead.\n',
    );
    process.exit(2);
  }

  process.exit(0); // content is clean — allow
}

try {
  await main();
} catch {
  // A PreToolUse guard must never crash a session — fail open.
  process.exit(0);
}
