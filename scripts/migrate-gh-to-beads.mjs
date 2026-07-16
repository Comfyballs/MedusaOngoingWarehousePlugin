#!/usr/bin/env node
// Migrate Comfyballs/medusa-b2b GitHub Issues → beads.
// Design: docs/superpowers/specs/2026-07-05-gh-to-beads-migration-design.md
// Plan:   ~/.claude/plans/make-a-plan-based-peppy-rossum.md
//
// Usage:
//   node scripts/migrate-gh-to-beads.mjs --dry-run
//   node scripts/migrate-gh-to-beads.mjs
//   node scripts/migrate-gh-to-beads.mjs --phase=postProcess
//   node scripts/migrate-gh-to-beads.mjs --verify-idempotent
//
// Idempotent: every write is guarded by a "does this already exist?" read.

import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const OWNER = "Comfyballs";
const REPO = "MedusaOngoingWarehousePlugin";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const VERIFY = args.has("--verify-idempotent");
const phaseArg = [...args].find((a) => a.startsWith("--phase="));
const ONLY_PHASE = phaseArg?.split("=")[1];

const unresolvedRefs = []; // reported at the end

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function shSafe(cmd) {
  try { return sh(cmd); } catch (e) { return { error: e, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" }; }
}
function bd(args, opts = {}) {
  return execFileSync("bd", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
function ghJson(args) {
  return JSON.parse(gh(args));
}
function log(...m) { console.log("[migrate]", ...m); }
function warn(...m) { console.warn("[migrate:warn]", ...m); }

// ---------- Phase 1: preflight ----------
function preflight() {
  log("preflight");
  const status = shSafe("gh auth status");
  if (status.error) throw new Error("gh not authenticated: " + status.stderr);
  const owner = bd(["config", "get", "github.owner"]).trim();
  const repo = bd(["config", "get", "github.repo"]).trim();
  if (owner !== OWNER || repo !== REPO) {
    throw new Error(`bd github config mismatch: got ${owner}/${repo}, want ${OWNER}/${REPO}`);
  }
  if (!process.env.GITHUB_TOKEN) {
    log("GITHUB_TOKEN not set; pulling from `gh auth token`");
    process.env.GITHUB_TOKEN = gh(["auth", "token"]).trim();
  }
  log(`ok — ${OWNER}/${REPO}, dry=${DRY}, phase=${ONLY_PHASE ?? "all"}`);
}

// ---------- Phase 2: createEpics ----------
function fetchMilestones() {
  return ghJson([
    "api",
    `/repos/${OWNER}/${REPO}/milestones?state=all&per_page=100`,
    "--paginate",
  ]);
}

function listEpics() {
  const out = shSafe(`bd list --type=epic --json`);
  if (out.error) return [];
  try { return JSON.parse(out.stdout || out) ?? []; } catch { return []; }
}

function createEpics() {
  log("createEpics");
  const milestones = fetchMilestones();
  log(`  fetched ${milestones.length} milestones`);
  const existing = listEpics();
  const byTitle = new Map(existing.map((e) => [e.title, e.id]));

  const map = {}; // milestoneNumber → beadId

  for (const m of milestones) {
    const title = m.title; // e.g. "M4: Lifecycle"
    if (byTitle.has(title)) {
      map[m.number] = byTitle.get(title);
      log(`  epic exists: ${title} → ${byTitle.get(title)}`);
      continue;
    }
    if (DRY) {
      log(`  DRY would create epic: ${title}`);
      map[m.number] = `<dry-run:${title}>`;
      continue;
    }
    const desc = m.description || `Imported from GH milestone #${m.number}`;
    const out = execFileSync(
      "bd",
      ["create", "--type=epic", `--title=${title}`, `--description=${desc}`, "--priority=2", "--silent"],
      { encoding: "utf8" },
    );
    const id = out.trim().split(/\s+/).pop();
    map[m.number] = id;
    log(`  created epic: ${title} → ${id}`);
  }
  return map;
}

// ---------- Phase 3: pullIssues ----------
function pullIssues() {
  log("pullIssues");
  const flags = DRY ? ["github", "sync", "--pull-only", "--dry-run"] : ["github", "sync", "--pull-only"];
  const out = execFileSync("bd", flags, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(out);
}

// ---------- Phase 4: postProcess ----------
function fetchIssues() {
  // one paginated fetch of every issue (state=all) so we don't hit gh once per bead
  return ghJson([
    "api",
    `/repos/${OWNER}/${REPO}/issues?state=all&per_page=100`,
    "--paginate",
  ]).filter((i) => !i.pull_request); // /issues includes PRs; drop them
}

function listAllBeads() {
  const out = shSafe(`bd list --status=all --json`);
  if (out.error) {
    // fallback: no --status=all supported? try plain list
    return JSON.parse(bd(["list", "--json"]));
  }
  return JSON.parse(out.stdout || out);
}

function ghNumberFromExternalRef(ref) {
  if (!ref) return null;
  // bd github sync stores the issue URL, e.g. https://github.com/Comfyballs/medusa-b2b/issues/198
  const url = String(ref).match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (url) return Number(url[1]);
  const short = String(ref).match(/gh-(\d+)/);
  return short ? Number(short[1]) : null;
}

function showBead(id) {
  const arr = JSON.parse(bd(["show", id, "--json"]));
  return Array.isArray(arr) ? arr[0] : arr;
}

function depList(id) {
  const r = shSafe(`bd dep list ${id} --json`);
  if (r.error) return [];
  try {
    const parsed = JSON.parse(r.stdout || r);
    return Array.isArray(parsed) ? parsed : parsed.dependencies ?? [];
  } catch { return []; }
}

function parentLink(beads, issueByNumber, milestoneMap) {
  log("  parent-link");
  let updated = 0, skipped = 0;
  for (const b of beads) {
    const n = ghNumberFromExternalRef(b.external_ref);
    if (!n) continue;
    const issue = issueByNumber.get(n);
    if (!issue?.milestone) continue;
    const epicId = milestoneMap[issue.milestone.number];
    if (!epicId) continue;
    const detail = showBead(b.id);
    if (detail.parent === epicId || detail.parent_id === epicId) { skipped++; continue; }
    if (DRY) { log(`    DRY parent ${b.id} → ${epicId}`); updated++; continue; }
    bd(["update", b.id, `--parent=${epicId}`]);
    updated++;
  }
  log(`    updated=${updated} skipped=${skipped}`);
}

function typeNormalize(beads) {
  log("  type-normalize");
  const TYPE_MAP = { "type:bug": "bug", "type:task": "task", "type:feature": "feature", "type:epic": "epic" };
  let updated = 0;
  for (const b of beads) {
    const labels = b.labels ?? [];
    const typeLabel = labels.find((l) => TYPE_MAP[l]);
    if (!typeLabel) continue;
    const desired = TYPE_MAP[typeLabel];
    const currentType = b.issue_type ?? b.type;
    const needsType = currentType !== desired;
    if (DRY) {
      log(`    DRY ${b.id}: type ${currentType}→${desired}, drop ${typeLabel}`);
      updated++;
      continue;
    }
    if (needsType) bd(["update", b.id, `--type=${desired}`]);
    // remove the label. bd supports --remove-label per --help; try that first.
    const r = shSafe(`bd update ${b.id} --remove-label=${typeLabel}`);
    if (r.error) warn(`    could not remove label ${typeLabel} from ${b.id}: ${r.stderr}`);
    updated++;
  }
  log(`    touched=${updated}`);
}

function statusNormalize(beads) {
  log("  status-normalize");
  let dropped = 0;
  for (const b of beads) {
    const labels = b.labels ?? [];
    if (!labels.includes("status:backlog")) continue;
    if (DRY) { log(`    DRY drop status:backlog from ${b.id}`); dropped++; continue; }
    const r = shSafe(`bd update ${b.id} --remove-label=status:backlog`);
    if (r.error) warn(`    could not remove status:backlog from ${b.id}: ${r.stderr}`);
    dropped++;
  }
  log(`    dropped=${dropped}`);
}

function crossRefs(beads) {
  log("  cross-refs");
  const beadByGhNumber = new Map();
  for (const b of beads) {
    const n = ghNumberFromExternalRef(b.external_ref);
    if (n) beadByGhNumber.set(n, b.id);
  }
  const RE = /(?<![\w/])#(\d+)/g; // #N but not part of a URL/word
  let added = 0, skipped = 0;
  for (const b of beads) {
    const selfN = ghNumberFromExternalRef(b.external_ref);
    const body = b.description ?? "";
    if (!body) continue;
    // dependency_count on bd list is unreliable — always fetch dep list.
    const dl = depList(b.id);
    const src = Array.isArray(dl) ? dl : dl.dependencies ?? [];
    const existingDeps = new Set(src.map((d) => d.target_id ?? d.to_id ?? d.target ?? d.to ?? d.id ?? d));
    const seenThisBead = new Set();
    for (const m of body.matchAll(RE)) {
      const n = Number(m[1]);
      if (n === selfN) continue;
      if (seenThisBead.has(n)) continue;
      seenThisBead.add(n);
      const targetId = beadByGhNumber.get(n);
      if (!targetId) {
        unresolvedRefs.push({ from: b.id, ghRef: `#${n}` });
        continue;
      }
      if (existingDeps.has(targetId)) { skipped++; continue; }
      if (DRY) { log(`    DRY dep add ${b.id} related→ ${targetId} (#${n})`); added++; continue; }
      const r = shSafe(`bd dep add ${b.id} ${targetId} --type=related`);
      if (r.error) warn(`    dep add failed ${b.id}→${targetId}: ${r.stderr}`);
      else added++;
    }
  }
  log(`    added=${added} skipped=${skipped} unresolved=${unresolvedRefs.length}`);
}

function postProcess(milestoneMap) {
  log("postProcess");
  const beads = listAllBeads();
  log(`  ${beads.length} beads total`);
  const issues = fetchIssues();
  const issueByNumber = new Map(issues.map((i) => [i.number, i]));
  parentLink(beads, issueByNumber, milestoneMap);
  typeNormalize(beads);
  statusNormalize(beads);
  crossRefs(beads);
}

// ---------- Phase 5: report ----------
function report() {
  log("report");
  const beads = listAllBeads();
  const closed = beads.filter((b) => b.status === "closed").length;
  const open = beads.length - closed;
  log(`  total=${beads.length}  open=${open}  closed=${closed}`);
  if (unresolvedRefs.length) {
    log(`  unresolved #N refs (likely PRs or foreign repos):`);
    for (const u of unresolvedRefs) log(`    ${u.from}: ${u.ghRef}`);
  }
  log(`\nNext: manual review, then cutover (see plan §Cutover).`);
}

// ---------- verify-idempotent ----------
function snapshot() {
  // hash the sorted JSON of every bead + its deps
  const beads = listAllBeads()
    .map((b) => showBead(b.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const h = createHash("sha256").update(JSON.stringify(beads)).digest("hex");
  return h;
}

function verifyIdempotent() {
  log("verify-idempotent");
  const before = snapshot();
  const map = createEpics();
  pullIssues();
  postProcess(map);
  const after = snapshot();
  if (before !== after) {
    console.error(`FAIL — state changed: ${before} → ${after}`);
    process.exit(1);
  }
  log(`ok — snapshot stable: ${before.slice(0, 12)}`);
}

// ---------- main ----------
function shouldRun(name) { return !ONLY_PHASE || ONLY_PHASE === name; }

function main() {
  preflight();
  if (VERIFY) { verifyIdempotent(); return; }
  let map = {};
  if (shouldRun("createEpics")) map = createEpics();
  if (shouldRun("pullIssues")) pullIssues();
  if (shouldRun("postProcess")) {
    if (Object.keys(map).length === 0) map = createEpics(); // rebuild map on partial run
    postProcess(map);
  }
  if (shouldRun("report")) report();
}

main();
