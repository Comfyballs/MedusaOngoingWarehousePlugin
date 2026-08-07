/**
 * Build identity for this compiled artifact.
 *
 * This file's compiled output (`.medusa/server/src/modules/ongoing/build-info.js`)
 * is overwritten by `scripts/stamp-build-info.mjs` as part of `yarn build`, replacing
 * this placeholder with the real UTC timestamp, short git sha, and dirty flag. Source
 * stays a stable placeholder so the tree has nothing to accidentally commit dirty.
 */
export interface OngoingBuildInfo {
  /** UTC-timestamp + short-sha (+ "-dirty") identifier, unique per build. */
  id: string
  /** Short git sha the build was produced from, or null if unavailable. */
  sha: string | null
  /** ISO-8601 UTC build timestamp, or null if unstamped. */
  builtAt: string | null
  /** Whether the working tree had uncommitted changes at build time. */
  dirty: boolean
}

const buildInfo: OngoingBuildInfo = {
  id: "dev",
  sha: null,
  builtAt: null,
  dirty: false,
}

export default buildInfo
