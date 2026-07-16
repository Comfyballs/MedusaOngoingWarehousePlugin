// Loads .env.integration (git-ignored) into process.env for the live suite.
// Kept dependency-light: dotenv ships with Medusa. Absent file is fine — the
// live tests self-skip when ONGOING_LIVE !== "1".
const path = require("path")
require("dotenv").config({ path: path.resolve(__dirname, ".env.integration") })
