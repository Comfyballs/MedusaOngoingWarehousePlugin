/** @type {import('jest').Config} */
// Layer 2 — Medusa integration suite. Boots the `ongoing` module against a REAL
// Postgres via @medusajs/test-utils' moduleIntegrationTestRunner, exercising the
// Medusa-side wiring the fast unit suite mocks: module registration, loaders
// (validate-options), migrations/schema, and the module service against a real DB.
//
// NOT to be confused with jest.integration.config.js (Layer 1 — the LIVE Ongoing
// HTTP harness, `yarn test:live`, *.live.test.ts). That one needs Ongoing sandbox
// credentials; this one needs a running Postgres and never touches Ongoing.
//
// Run with `yarn test:integration`. The default `yarn test` never runs these:
// jest.config.js roots at src/ and only matches __tests__/**/*.test.ts, while these
// specs live in integration-tests/ and end in .spec.ts.
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/integration-tests"],
  testMatch: ["**/integration-tests/**/*.spec.ts"],
  // Fill in conventional Medusa local DB_* defaults before the runner reads them, so
  // `yarn test:integration` boots against a standard local Postgres out of the box
  // (CI overrides by exporting real DB_* env). See integration-tests/setup-env.ts.
  setupFiles: ["<rootDir>/integration-tests/setup-env.ts"],
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest"],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  // buffer-equal-constant-time uses SlowBuffer (removed in Node 26) — same shim as
  // jest.config.js / jest.integration.config.js so Node 26 doesn't crash the transform
  // graph. It lives outside src/, so Jest's automatic __mocks__ discovery misses it —
  // it must be wired explicitly in every config (see docs/wiki/Dev-Gotchas.md).
  moduleNameMapper: {
    "^buffer-equal-constant-time$": "<rootDir>/__mocks__/buffer-equal-constant-time.js",
  },
  // Booting a module and running migrations against Postgres is far slower than a
  // pure unit test; the runner also creates and drops a temp database per run.
  testTimeout: 60_000,
}
