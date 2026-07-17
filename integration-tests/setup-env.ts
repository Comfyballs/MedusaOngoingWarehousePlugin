// Jest setupFile for the Layer 2 integration suite (jest.config.integration.js).
//
// @medusajs/test-utils' moduleIntegrationTestRunner reads the target Postgres from
// DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD (and creates + drops its own throwaway temp
// database per run — it never writes to an existing app database). This file supplies
// the conventional Medusa local defaults so `yarn test:integration` boots against any
// standard local Postgres out of the box (e.g. the docker Postgres from a sibling
// Medusa app — postgres/postgres on 127.0.0.1:5432). CI overrides these by exporting
// real DB_* env before the run; we only fill in what is unset.
//
// runs as a `setupFiles` entry so the env is in place before the runner reads it in
// its beforeAll (env set here propagates inside each worker process, unlike globalSetup).
const DEFAULTS: Record<string, string> = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "5432",
  DB_USERNAME: "postgres",
  DB_PASSWORD: "postgres",
}

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}
