# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Medusa v2 **plugin** that integrates Medusa with the **Ongoing Warehouse** WMS (warehouse management system). The goal is to fulfill orders through Ongoing and sync inventory back into Medusa — analogous to Medusa's ShipStation integration, but for Ongoing.

The Ongoing integration is implemented, not scaffolding: a fulfillment provider (`src/providers/ongoing-fulfillment/`) pushes and cancels orders, an `ongoing` module (`src/modules/ongoing/`) persists integration config and a per-`(order, fulfillment)` sync-state ledger, workflows (`src/workflows/`) own every Ongoing-bound mutation, subscribers and cron jobs (`src/subscribers/`, `src/jobs/`) keep order edits/cancellations/shipment status/inventory in sync, a REST client stack (`src/lib/ongoing/`) talks to the Ongoing API, a webhook receiver (`src/api/ongoing/webhooks/[credentialKey]/`) accepts Ongoing status pushes, and an admin UI (`src/admin/`) provides an ops dashboard, settings, and an order-detail widget. See `docs/wiki/Dev-Architecture.md` for the full picture — it's the up-to-date architecture reference; trust it over any stale prose here. The only leftovers from the starter scaffold are the two placeholder routes `src/api/{admin,store}/plugin/route.ts`, which still just return `200` and are unused.

Pinned to Medusa **2.16.0** (see `package.json`); package manager is **yarn 4.6.0**; Node **>= 20**.

**Issue tracking:** GitHub Issues is **retired** (all open issues closed 2026-07-05 with a "moved to beads" comment). Work tracking lives in `bd` (beads) — see the managed **Beads Issue Tracker** section below. In commits and PRs, reference the bead ID (e.g. `MedusaOngoingWarehousePlugin-1783216052060-66-b0ad5eb4`) rather than `Closes #N`.

## Commands

```bash
yarn build        # medusa plugin:build  → compiles to .medusa/server (the published artifact)
yarn dev          # medusa plugin:develop → watch mode; publishes locally via yalc for a linked Medusa app
yarn lint         # medusa lint (eslint flat config, @medusajs/eslint-plugin recommended)

# Tests — three layers (see docs/wiki/Dev-Testing.md):
yarn test              # L1 unit suite (jest.config.js) — fast, no external services
yarn test:integration  # L2 Medusa integration (jest.config.integration.js) — needs a real Postgres (DB_* env)
yarn test:live         # L3 live Ongoing contract (jest.integration.config.js) — needs an Ongoing sandbox (.env.integration)

# Module DB migrations (run from this plugin dir when a src/modules/* model changes):
npx medusa plugin:db:generate   # generate migrations from data models
# In the consuming Medusa app, links/migrations are applied with: npx medusa db:migrate
```

Tests are split by jest config so slow/external suites never run in the default `yarn test`. The unit suite is the every-commit gate; `test:integration` boots the `ongoing` module against Postgres via `moduleIntegrationTestRunner` (Ongoing stubbed); `test:live` hits a real Ongoing sandbox. Note the two similarly-named integration configs: `jest.config.integration.js` (L2, Postgres) vs `jest.integration.config.js` (L3, live Ongoing).

## Architecture

### Plugin packaging (important, non-obvious)
Source lives in `src/`, but the **build output** in `.medusa/server` is what gets published (`package.json` `files: [".medusa/server"]`). The `exports` map in `package.json` is how a consuming Medusa app imports parts of this plugin — note the path shape:

- `@org/plugin/modules/*` → `src/modules/*/index.js`
- `@org/plugin/providers/*` → `src/providers/*/index.js`  ← fulfillment provider goes here
- `@org/plugin/workflows` → `src/workflows/index.js`
- `@org/plugin/admin` → admin extensions

`tsconfig.json` excludes `src/admin` from the server build — admin UI is bundled separately by the Medusa admin pipeline (`src/admin/vite-env.d.ts`, its own `tsconfig.json`). The root `tsconfig` is `Node16` module resolution with decorators enabled.

### Extension points (Medusa v2 plugin structure under `src/`)
Directory `README.md` files still hold the original starter's generic worked examples; the actual Ongoing integration in each extension point is:

- **`src/providers/ongoing-fulfillment/`** — `OngoingFulfillmentProviderService` (extends `AbstractFulfillmentProviderService`, `ONGOING_PROVIDER_ID = "ongoing"`). `createFulfillment` synchronously runs the `push-order-to-ongoing` workflow (a push failure aborts fulfillment creation); `cancelFulfillment` runs `cancel-ongoing-order`. `canCalculate()` is `false` (flat rates). Registered in the consuming app under the `@medusajs/medusa/fulfillment` module's `providers` array.
- **`src/modules/ongoing/`** — the `ongoing` module (`ONGOING_MODULE`). `OngoingModuleService extends MedusaService({ OngoingIntegration, OngoingOrderSync })`. `OngoingIntegration` is one row per warehouse integration (credential key, stock location, sync intervals, reconcile mode); `OngoingOrderSync` is the per-`(order, fulfillment)` sync-state ledger. Migrations live under `migrations/`.
- **`src/workflows/`** — every Ongoing-bound mutation goes through a workflow: `push-order-to-ongoing`, `cancel-ongoing-order`, `sync-order-edit-to-ongoing`, `sync-ongoing-shipment`, `sync-ongoing-inventory`, `refresh-ongoing-order-status`, `retry-ongoing-syncs`, `flag-orphaned-order-syncs`, integration CRUD, and `setup-location` (provisions the fulfillment set/service zone/shipping option). Full table in `docs/wiki/Dev-Architecture.md`.
- **`src/subscribers/`** — `order-canceled.ts`, `order-edit-confirmed.ts`, `order-updated.ts` react to Medusa order events and drive the matching Ongoing sync workflow; all persist-then-emit and never throw.
- **`src/jobs/`** — `status-poll.ts`, `stock-sync.ts`, `retry-failed-syncs.ts`, all running every minute: poll Ongoing order status, reconcile `stocked_quantity` (delta or full sweep), and sweep failed sync rows with exponential backoff/dead-lettering.
- **`src/links/`** — `defineLink` associations: stock-location↔integration, order-sync↔fulfillment, order-sync↔order — preserving module isolation while allowing `query.graph` joins.
- **`src/api/`** — `admin/ongoing/*` routes (integration CRUD, per-order repush/sync, syncs dashboard/bulk-retry/orphan-repair, test-connection, credential-keys) under Medusa's default admin auth; `ongoing/webhooks/[credentialKey]/route.ts` is the Ongoing status-webhook receiver with custom static-secret auth (never core admin/store auth). The starter's placeholder routes `admin/plugin/route.ts` and `store/plugin/route.ts` still return `200` and are unused.
- **`src/admin/`** — ops dashboard (`/ongoing`), settings (`/settings/ongoing`), and an order-detail widget (React, `@medusajs/ui`), sharing one JS-SDK client (`lib/sdk.ts`) and a react-query wrapper.
- **`src/lib/ongoing/`** — the Ongoing REST client stack: `OngoingClient` (Basic auth, retry/backoff, cursor pagination), a node `http`/`https` transport (Node's global `fetch` gets a `500` from Ongoing's WAF — see `docs/wiki/Dev-Gotchas.md`), a per-credential-key `Throttle`, the `OngoingApiError` taxonomy, order-mapper/article-resolution, and the workflow-level retry policy.

### Plugin options
`OngoingPluginOptions` (`src/modules/ongoing/options.ts`): an `integrations` array of `{ key, baseUrl, username, password, goodsOwnerId, webhookSecret? }` — one entry per Ongoing goods owner/credential — plus optional `defaultStockSyncInterval`, `defaultStatusPollInterval`, and `rateLimitConcurrency`. These flow in from the consuming app's `medusa-config` and are validated at module boot by the `validate-options` loader, which fails app startup on misconfiguration rather than failing at first use. Credentials never live in the DB; do not hardcode them.

## Ongoing Warehouse API — integration notes

Reference docs (fetch when implementing):
- OpenAPI spec: `https://developer.ongoingwarehouse.com/REST/v1/openapi.json?version=57`
- Webshop order flow: `https://developer.ongoingwarehouse.com/webshop-flow`
- Inventory: `https://developer.ongoingwarehouse.com/inventory`
- Pagination: `https://developer.ongoingwarehouse.com/paginating-responses`
- Parallel requests: `https://developer.ongoingwarehouse.com/parallel-requests` — Ongoing rate-limits concurrent calls; throttle/serialize batch syncs accordingly.
- Transport system integration: `https://developer.ongoingwarehouse.com/integrate-transport-system`

When implementing, consult these for the exact order/article/inventory payloads and auth scheme rather than guessing. Ongoing is the system of record for warehouse stock and shipping; Medusa pushes orders and pulls back fulfillment/tracking and inventory levels.

## Reference: similar Medusa integrations
- ShipStation fulfillment guide: `https://docs.medusajs.com/resources/integrations/guides/shipstation`
- ShipStation example repo (closest architectural model): `https://github.com/medusajs/examples/tree/main/shipstation-integration`
- Fulfillment provider reference: `https://docs.medusajs.com/resources/references/fulfillment/provider`
- Plugin authoring: `https://docs.medusajs.com/learn/fundamentals/plugins/create`

The `medusa-dev` skills (`building-with-medusa`, `building-admin-dashboard-customizations`) and the MedusaDocs MCP are available — load them when planning or implementing backend modules/providers or admin UI.

## Code review before merging (required)

**Before merging any PR, a Medusa-aware code review MUST happen first.** Do not squash/merge a PR until it has been reviewed by an agent (or session) that has loaded the **`medusa-dev:building-with-medusa`** skill; for PRs touching `src/admin/**`, also load **`medusa-dev:building-admin-dashboard-customizations`**. A generic review misses Medusa-specific defects this skill catches: mutations not wrapped in workflows, PUT/PATCH routes, broken module isolation / cross-module service calls, wrong `query.graph` vs `query.index` usage, non-`async` service methods, `MedusaError` vs generic `Error`, price-format (stored as-is, not cents), and workflow-composition rules (no async/arrow/conditionals in `createWorkflow`).

The reviewer runs `yarn lint`, `yarn build`, and the test suite, and confirms the diff against the skill's rule categories. Merge only after the review is clean (or its findings are addressed). This is in addition to the generic `superpowers:requesting-code-review` skill.

**Documentation freshness is part of every PR review.** Docs live as GitHub-wiki-compatible pages in `docs/wiki/` (`User-*`, `Dev-*`, `Home.md`, `_Sidebar.md`, `Documentation-Guidelines.md`); `docs/wiki/` is the source of truth and the GitHub wiki is a publish target (see `docs/wiki/Dev-Documentation-Maintenance.md`). If a PR changes a plugin option, a public extension-point shape (provider methods, module models, route paths, workflow/job/subscriber behavior), the admin UI, or an install/build/test command, the corresponding `docs/wiki/` page(s) must be updated in the same PR — block the merge on a missing doc update the same way you would block on a missing test. If the docs still match, state that explicitly in the review. Doc edits follow `docs/wiki/Documentation-Guidelines.md`.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)



<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
