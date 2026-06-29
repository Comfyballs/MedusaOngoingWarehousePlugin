// superpowers-setup managed file. setup-version: 2. Do not edit by hand; re-run /init-project to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./doc-status-guard.mjs', import.meta.url));

test('fails on a checkbox under docs/adr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'adr', 'a.md'), '- [ ] todo\n');
  assert.throws(() => execFileSync('node', [guard], { cwd: dir }));
});

test('passes clean docs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  fs.mkdirSync(path.join(dir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'specs', 's.md'), '# fine\n');
  execFileSync('node', [guard], { cwd: dir });
});
