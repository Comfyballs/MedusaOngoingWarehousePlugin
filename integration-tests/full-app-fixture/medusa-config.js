// Fixture `medusa-config.js` for the wh5.8/wh5.9 full-app harness
// (integration-tests/full-app.spec.ts, run via medusaIntegrationTestRunner).
//
// This is NOT a real consuming app and is never published — it exists only so
// medusaIntegrationTestRunner has a `cwd` to boot a real Medusa app from (core
// modules + our `ongoing` module + the `ongoing-fulfillment` provider), proving
// registration-by-source-path works with the exact shapes documented in
// docs/wiki/User-Setup-Guide.md (provider id "ongoing", the module resolved
// straight from source rather than a built `.medusa/server` package — see
// bead onk). `databaseUrl` is overwritten by the test runner's
// configLoaderOverride before boot; the placeholder here is never used.
//
// `src/links/*.ts` in this fixture directory are thin re-exports of the
// plugin's REAL link definitions in `../../../src/links/` (not copies) — see
// that directory for why: medusaIntegrationTestRunner discovers module links
// by scanning `<cwd>/src/links`, and we want the actual `defineLink()` calls
// under test, not a duplicate.
//
// IMPORTANT: this MUST go through `defineConfig()` (matching the real
// docs/wiki/User-Setup-Guide.md snippet), not a bare object literal —
// `defineConfig()` (@medusajs/framework/utils, see
// node_modules/@medusajs/utils/dist/common/define-config.js `resolveModules`)
// is what injects Medusa's ~20 core modules (stock_location, product, order,
// fulfillment[default "manual" provider], etc.) that a real consuming app's
// medusa-config.ts gets "for free". Nearly all of them have
// `defaultPackage: false` in @medusajs/modules-sdk's ModulesDefinition, so
// medusaIntegrationTestRunner's own lower-level `mergeDefaultModules` fallback
// (module-sdk-only, used by moduleIntegrationTestRunner) does NOT add them —
// a bare `module.exports = {...}` here boots with almost no core modules
// registered at all (confirmed: `getLinksExecutionPlanner` errored "Service
// stock_location was not found" before this fix). Our own `modules` array
// entries below REPLACE (not merge with) defineConfig's matching default
// entries by service name (@medusajs/utils `transformModules`, last-in-wins) —
// e.g. this drops the default "manual" fulfillment provider, exactly as a
// real app's config that only lists the "ongoing" provider would.
const { defineConfig } = require("@medusajs/framework/utils")
const path = require("path")

const ONGOING_MODULE_PATH = path.join(__dirname, "../../src/modules/ongoing")
const ONGOING_PROVIDER_PATH = path.join(__dirname, "../../src/providers/ongoing-fulfillment")

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    http: {
      storeCors: "*",
      adminCors: "*",
      authCors: "*",
      jwtSecret: "full-app-fixture-jwt-secret",
      cookieSecret: "full-app-fixture-cookie-secret",
    },
  },
  admin: {
    disable: true,
  },
  modules: [
    {
      // Explicit `key` (== ONGOING_MODULE from src/modules/ongoing/index.ts) so
      // @medusajs/utils' defineConfig/transformModules doesn't have to
      // synchronously `require()` + introspect __joinerConfig() to name this
      // module — it isn't a known @medusajs package name so that lookup would
      // otherwise be the only way it resolves a service name.
      key: "ongoing",
      resolve: ONGOING_MODULE_PATH,
      options: {
        integrations: [
          {
            key: "test-wh",
            baseUrl: "https://ongoing.test/api/v1",
            username: "user",
            password: "pass",
            goodsOwnerId: 7,
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          {
            resolve: ONGOING_PROVIDER_PATH,
            id: "ongoing",
            options: {},
          },
          // The core "manual" provider is also registered so the wh5.8 link-
          // resolution test can create a REAL core fulfillment record (needed for
          // the OngoingOrderSync<->fulfillment link) WITHOUT going through the
          // ongoing provider's createFulfillment — which currently throws in a real
          // app (bug ei4: a fulfillment provider runs in the fulfillment module's
          // isolated container and cannot resolve the sibling "ongoing" module).
          // wh5.9a still asserts the "ongoing" provider itself registered.
          {
            resolve: "@medusajs/fulfillment-manual",
            id: "manual",
            options: {},
          },
        ],
      },
    },
  ],
})
