// Thin re-export of the plugin's REAL link definition (src/links/ongoing-integration-stock-location.ts)
// so medusaIntegrationTestRunner's <cwd>/src/links discovery loads the actual
// defineLink() call under test — not a duplicate. See ../../medusa-config.js.
export { default } from "../../../../src/links/ongoing-integration-stock-location"
