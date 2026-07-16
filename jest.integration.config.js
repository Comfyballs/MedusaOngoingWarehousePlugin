/** @type {import('jest').Config} */
// Live integration suite: exercises OngoingClient against the REAL Ongoing REST API.
// Run explicitly with `yarn test:live` (reads creds from .env.integration). The default
// `yarn test` / CI never runs these — jest.config.js ignores *.live.test.ts.
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.live.test.ts"],
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest"],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  // Load .env.integration → process.env before any test module (creds live there).
  setupFiles: ["<rootDir>/jest.integration.setup.js"],
  moduleNameMapper: {
    "^buffer-equal-constant-time$": "<rootDir>/__mocks__/buffer-equal-constant-time.js",
  },
  // A single order round-trip can wait on Ongoing's sequential-write processing.
  testTimeout: 60_000,
}
