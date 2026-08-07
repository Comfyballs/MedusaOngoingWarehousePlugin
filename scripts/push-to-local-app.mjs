#!/usr/bin/env node
// Updates one or every yalc-linked local Medusa app to the current plugin
// build, and proves the update actually reached the app. Automates the
// four-step manual ritual (and its two silent failure modes) documented in
// docs/wiki/Dev-Local-App-Testing.md — read that page for the "why".
//
// Usage:
//   yarn push:local                    # push to every app `yalc installations show` knows about
//   yarn push:local <app-path>         # push to one app only
//   yarn push:local -- --dry-run       # print every mutating command instead of running it
//   yarn push:local <app-path> --dry-run
//
// Design: plain node script, no new dependencies — yalc is already vendored
// at node_modules/.bin/yalc. Discovery/read commands (yalc installations
// show, lsof) always run, dry-run or not — they don't touch anything, and
// --dry-run is only useful if the plan it prints is the real one. Only
// mutating steps (build, publish --push, package-manager installs, stale-copy
// removal) are skipped and printed instead under --dry-run.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const PACKAGE_NAME = pkg.name; // "@comfyballs/medusa-plugin-ongoing-warehouse"
const PACKAGE_DIRNAME = PACKAGE_NAME.split("/").pop(); // "medusa-plugin-ongoing-warehouse"
const BUILD_INFO_REL = ".medusa/server/src/modules/ongoing/build-info.js";
const YALC = path.join(repoRoot, "node_modules/.bin/yalc");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const appArg = args.find((a) => a !== "--dry-run");

function readCmd(cmd, cmdArgs, opts = {}) {
  // Read-only discovery — always actually runs, dry-run or not.
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
}

function exec(cmd, cmdArgs, opts = {}) {
  // Mutating step — printed and skipped under --dry-run.
  const label = `${opts.cwd ? `(cwd: ${opts.cwd}) ` : ""}${cmd} ${cmdArgs.join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] would run: ${label}`);
    return;
  }
  console.log(`$ ${label}`);
  execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

function removeDir(target) {
  if (!existsSync(target)) return;
  if (dryRun) {
    console.log(`[dry-run] would remove ${target}`);
    return;
  }
  console.log(`removing ${target}`);
  rmSync(target, { recursive: true, force: true });
}

// --- discover target apps ------------------------------------------------

function discoverLinkedApps() {
  let out;
  try {
    out = readCmd(YALC, ["installations", "show"], { cwd: repoRoot });
  } catch (err) {
    console.error(`Could not run \`yalc installations show\`: ${err.message}`);
    process.exit(1);
  }
  // "Installations of package <name>:\n  /path/one\n  /path/two"
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
}

let targetApps;
if (appArg) {
  const resolved = path.resolve(appArg);
  if (!existsSync(resolved)) {
    console.error(`App path does not exist: ${resolved}`);
    process.exit(1);
  }
  targetApps = [resolved];
} else {
  targetApps = discoverLinkedApps();
  if (targetApps.length === 0) {
    console.error(
      "No linked apps found (`yalc installations show` is empty). Run " +
        "`yalc add @comfyballs/medusa-plugin-ongoing-warehouse` in the target app first, " +
        "or pass an app path explicitly."
    );
    process.exit(1);
  }
}

console.log(`Target app(s): ${targetApps.join(", ")}`);

// --- step 1: build, publish, push ----------------------------------------
// `yalc publish --push` pushes to every installation yalc knows about in one
// call — it is not selectable per-app, so this runs once regardless of how
// many apps were named above.

console.log("\n== Step 1: build + publish + push ==");
exec("yarn", ["build"], { cwd: repoRoot });
exec(YALC, ["publish", "--push", "--no-scripts"], { cwd: repoRoot });

function expectedBuildId() {
  const p = path.join(repoRoot, BUILD_INFO_REL);
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/"id":"([^"]+)"/);
  return m ? m[1] : null;
}

const expectedId = expectedBuildId();
if (!dryRun && !expectedId) {
  console.error(`Could not read a build id from ${BUILD_INFO_REL} after building — aborting.`);
  process.exit(1);
}
console.log(`Build id ${expectedId ?? "(unknown until a real build runs)"}`);

// --- per-app: detect package manager + workspace root ---------------------

function detectInstallTarget(appPath) {
  // Walk up from appPath looking for a workspace root (pnpm-workspace.yaml,
  // or a package.json with a "workspaces" field). Per docs/wiki/Dev-Local-App-Testing.md
  // (pnpm section) and commit 6c852cd: for a pnpm workspace the install MUST run at the
  // workspace root, never inside apps/<pkg> — a package-level .npmrc there (e.g.
  // node-linker=hoisted) can re-layout the whole workspace and duplicate core Medusa
  // packages. The bead that requested this script originally said the opposite
  // ("run from the package, not the root"); that was wrong and the doc corrects it.
  // We generalize the same "always install at the workspace root" rule to yarn/npm
  // workspaces too — it's the standard, always-safe way to install any JS workspace,
  // not just the pnpm-specific case that was empirically caught.
  let dir = appPath;
  const fsRoot = path.parse(dir).root;
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return { pm: "pnpm", installDir: dir };
    }
    const pkgJsonPath = path.join(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      } catch {
        pkgJson = {};
      }
      const isWorkspaceRoot =
        Array.isArray(pkgJson.workspaces) || (pkgJson.workspaces && pkgJson.workspaces.packages);
      if (isWorkspaceRoot) {
        const pm = existsSync(path.join(dir, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(path.join(dir, "yarn.lock"))
            ? "yarn"
            : "npm";
        return { pm, installDir: dir };
      }
    }
    if (dir === fsRoot) break;
    dir = path.dirname(dir);
  }
  // Not a workspace: install target is the app itself, package manager from its own lockfile.
  const pm = existsSync(path.join(appPath, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(appPath, "yarn.lock"))
      ? "yarn"
      : "npm";
  return { pm, installDir: appPath };
}

const INSTALL_CMD = {
  pnpm: ["pnpm", ["install"]],
  yarn: ["yarn", ["install"]],
  npm: ["npm", ["install"]],
};

// --- per-app: prune stale pnpm virtual-store / .ignored copies ------------

function cleanPnpmStaleCopies(installDir) {
  // pnpm resolves a `file:` dependency through its virtual store
  // (node_modules/.pnpm/<encoded-name>@file+…/) and, finding a plain
  // directory under node_modules that it doesn't manage (yalc's push target),
  // shoves its own copy aside into node_modules/.ignored/. Neither is
  // guaranteed to get overwritten by a plain `pnpm install`, so remove both
  // and let the install below rebuild them fresh from .yalc/.
  const encoded = PACKAGE_NAME.replace("/", "+"); // "@comfyballs+medusa-plugin-ongoing-warehouse"
  const dotPnpm = path.join(installDir, "node_modules/.pnpm");
  const ignored = path.join(installDir, "node_modules/.ignored");

  if (existsSync(dotPnpm)) {
    for (const entry of readdirSync(dotPnpm)) {
      if (entry.startsWith(`${encoded}@`)) {
        removeDir(path.join(dotPnpm, entry));
      }
    }
  }
  if (existsSync(ignored)) {
    // A scoped package can be shadowed either flat (".ignored/<name>", or the
    // pnpm-encoded "<@scope+name>@<version>") or nested under its scope
    // (".ignored/@scope/<name>"). Cover both — missing one leaves a stale copy that
    // only the verify step below would catch, and then only as a failure.
    for (const entry of readdirSync(ignored)) {
      if (entry === PACKAGE_DIRNAME || entry.startsWith(`${encoded}@`)) {
        removeDir(path.join(ignored, entry));
      }
    }
    removeDir(path.join(ignored, PACKAGE_NAME));
  }
}

// --- per-app: drop admin/vite caches so the admin bundle rebuilds ---------

function cleanAdminCaches(appPath) {
  // Best-effort: the well-known Medusa admin build output / Vite dep-cache
  // locations under a backend package. Harmless if any are absent.
  const candidates = [".medusa/admin", ".medusa/server/.cache", "node_modules/.vite", "node_modules/.cache"];
  for (const rel of candidates) {
    removeDir(path.join(appPath, rel));
  }
}

// --- per-app: verify every reachable copy carries the new build id --------

function findPackageCopies(appPath, maxDepth = 6) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".yalc") continue; // the store copy, not an installed one
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue; // broken symlink
        }
      }
      if (!isDir) continue;
      if (entry.name === PACKAGE_DIRNAME) {
        results.push(full);
        continue; // don't descend into the package itself
      }
      walk(full, depth + 1);
    }
  }
  walk(appPath, 0);
  return results;
}

function verifyBuildId(appPath, expected) {
  const copies = findPackageCopies(appPath);
  if (copies.length === 0) {
    console.warn(`  (no copies of ${PACKAGE_DIRNAME} found under ${appPath} — is it actually linked here?)`);
    return true;
  }
  const stale = [];
  for (const copy of copies) {
    const infoPath = path.join(copy, BUILD_INFO_REL);
    if (!existsSync(infoPath)) {
      stale.push(`${copy} (no ${BUILD_INFO_REL})`);
      continue;
    }
    const m = readFileSync(infoPath, "utf8").match(/"id":"([^"]+)"/);
    const id = m ? m[1] : null;
    if (id !== expected) {
      stale.push(`${copy} (build ${id ?? "unknown"})`);
    } else {
      console.log(`  OK  ${copy}`);
    }
  }
  if (stale.length > 0) {
    console.error(`  STALE — these copies do not carry build ${expected}:`);
    stale.forEach((s) => console.error(`    ${s}`));
    return false;
  }
  return true;
}

// --- dev-server ports -------------------------------------------------

function printDevServerPorts() {
  console.log("\nDev-server processes listening (restart the one you are browsing):");
  try {
    const out = readCmd("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    const lines = out.split("\n").filter((l) => /\bnode\b/i.test(l));
    if (lines.length === 0) console.log("  (no node process currently listening)");
    else lines.forEach((l) => console.log(`  ${l}`));
  } catch (err) {
    console.log(`  (could not run lsof: ${err.message})`);
  }
}

// --- run steps 2-4 per target app -----------------------------------------

let anyStale = false;
for (const appPath of targetApps) {
  console.log(`\n== ${appPath} ==`);
  const { pm, installDir } = detectInstallTarget(appPath);
  console.log(`Detected package manager: ${pm}; installing at: ${installDir}`);

  console.log("-- Step 2: install --");
  const [cmd, cmdArgs] = INSTALL_CMD[pm];
  exec(cmd, cmdArgs, { cwd: installDir });

  console.log("-- Step 3: clean stale copies + caches --");
  if (pm === "pnpm") {
    cleanPnpmStaleCopies(installDir);
    // Re-sync once more now that the stale copies are gone.
    exec(cmd, cmdArgs, { cwd: installDir });
  }
  cleanAdminCaches(appPath);

  console.log("-- Step 4: verify --");
  if (dryRun) {
    console.log("  [dry-run] would verify every reachable copy carries the new build id");
  } else {
    const ok = verifyBuildId(appPath, expectedId);
    if (!ok) anyStale = true;
  }
}

printDevServerPorts();

if (anyStale) {
  console.error("\npush:local finished with STALE copies — see paths above.");
  process.exit(1);
}
console.log("\npush:local done.");
