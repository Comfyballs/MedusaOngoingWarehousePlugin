# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Medusa v2 **plugin** that integrates Medusa with the **Ongoing Warehouse** WMS (warehouse management system). The goal is to fulfill orders through Ongoing and sync inventory back into Medusa — analogous to Medusa's ShipStation integration, but for Ongoing.

The repo is currently the unmodified Medusa plugin **starter scaffold**: directory `README.md` files explain each extension point, and the only real code is two placeholder routes (`src/api/{admin,store}/plugin/route.ts` returning `200`). The Ongoing integration has not been written yet — treat the directories as empty extension points to fill in.

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
Each directory's `README.md` has a worked example. The likely shape of the Ongoing integration:

- **`src/providers/`** — the core. Implement a **Fulfillment Module Provider** (extend `AbstractFulfillmentProviderService`). This is where Ongoing order creation, shipping-option/rate logic, label/tracking, and cancellation live. See the Medusa fulfillment-provider reference. Registered in the consuming app under the `@medusajs/medusa/fulfillment` module's `providers` array.
- **`src/modules/`** — a custom module if Ongoing-specific data needs persisting (e.g. mapping Medusa IDs ↔ Ongoing order/article IDs, sync state). A module = `models/` (data models via `model.define`) + `service.ts` (extends `MedusaService`) + `index.ts` (exports `Module(NAME, { service })`).
- **`src/workflows/`** — multi-step orchestration (e.g. push order to Ongoing, poll/receive shipment confirmation, write tracking back). Workflows are the idiomatic place for the API calls + compensation, called from subscribers/jobs/routes.
- **`src/subscribers/`** — react to Medusa events (e.g. `order.placed`, fulfillment created) to trigger Ongoing sync.
- **`src/jobs/`** — scheduled polling (e.g. periodic inventory/stock sync from Ongoing → Medusa, since Ongoing is the source of truth for on-hand stock).
- **`src/links/`** — `defineLink` associations between custom-module models and core models (product/order/fulfillment) while preserving module isolation.
- **`src/api/`** — REST routes. `admin/` and `store/` namespaces; file-based routing (`route.ts` exporting `GET`/`POST`/etc.); webhook receiver from Ongoing would live here.
- **`src/admin/`** — admin dashboard widgets/pages (React, `@medusajs/ui`, `defineWidgetConfig`).

### Plugin options
Ongoing credentials (API base URL, username, password, goods-owner id) should flow in as **plugin options** from the consuming app's `medusa-config` and be passed down to the provider/module via its constructor `options`. Do not hardcode credentials.

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
