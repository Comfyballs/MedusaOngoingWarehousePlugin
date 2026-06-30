/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest"],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  // buffer-equal-constant-time uses SlowBuffer which was removed in Node.js v26.
  // This shim preserves the API without the removed API.
  moduleNameMapper: {
    "^buffer-equal-constant-time$": "<rootDir>/__mocks__/buffer-equal-constant-time.js",
  },
}
