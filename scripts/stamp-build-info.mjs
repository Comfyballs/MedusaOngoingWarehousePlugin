#!/usr/bin/env node
// Overwrites the compiled build-info placeholder in .medusa/server with a real
// build id (UTC timestamp + short git sha + dirty flag), so a linked app can
// report which build it is running instead of grepping node_modules.
//
// Runs as the second half of the "build" script (see package.json) — Yarn 4
// does not chain a "postbuild" script automatically the way npm/Yarn 1 do, so
// this is invoked directly rather than relying on that hook.
//
// Source stays a stable placeholder (src/modules/ongoing/build-info.ts); only
// the compiled .js this script overwrites carries the real values, so nothing
// in the working tree goes dirty from running a build.
//
// Usage: node scripts/stamp-build-info.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiledPath = path.join(
  repoRoot,
  ".medusa/server/src/modules/ongoing/build-info.js"
);

if (!existsSync(compiledPath)) {
  console.error(
    `[stamp-build-info] ${compiledPath} does not exist — did the build step run first?`
  );
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

let sha = null;
let dirty = false;
try {
  sha = git(["rev-parse", "--short", "HEAD"]);
  dirty = git(["status", "--porcelain"]).length > 0;
} catch (err) {
  console.warn(
    `[stamp-build-info] could not read git info (${err.message}); stamping without a sha`
  );
}

const builtAt = new Date().toISOString();
const compactStamp = builtAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const id = [compactStamp, sha ?? "nogit", dirty ? "dirty" : null]
  .filter(Boolean)
  .join("-");

const buildInfo = { id, sha, builtAt, dirty };

const contents = readFileSync(compiledPath, "utf8");
// Replace the tsc-emitted `const buildInfo = {...}` placeholder literal, keep
// everything else (exports.default assignment, source-map comment) untouched.
const stamped = contents.replace(
  /const buildInfo = \{[\s\S]*?\};/,
  `const buildInfo = ${JSON.stringify(buildInfo)};`
);

if (stamped === contents) {
  console.error(
    `[stamp-build-info] did not find a "const buildInfo = {...}" placeholder in ${compiledPath} — compiled output shape changed?`
  );
  process.exit(1);
}

writeFileSync(compiledPath, stamped);
console.log(`[stamp-build-info] stamped build ${id}`);
