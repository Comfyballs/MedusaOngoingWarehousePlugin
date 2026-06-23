# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Medusa v2 **plugin** that integrates Medusa with the **Ongoing Warehouse** WMS (warehouse management system). The goal is to fulfill orders through Ongoing and sync inventory back into Medusa — analogous to Medusa's ShipStation integration, but for Ongoing.

The repo is currently the unmodified Medusa plugin **starter scaffold**: directory `README.md` files explain each extension point, and the only real code is two placeholder routes (`src/api/{admin,store}/plugin/route.ts` returning `200`). The Ongoing integration has not been written yet — treat the directories as empty extension points to fill in.

Pinned to Medusa **2.16.0** (see `package.json`); package manager is **yarn 4.6.0**; Node **>= 20**.

## Commands

```bash
yarn build        # medusa plugin:build  → compiles to .medusa/server (the published artifact)
yarn dev          # medusa plugin:develop → watch mode; publishes locally via yalc for a linked Medusa app
yarn lint         # medusa lint (eslint flat config, @medusajs/eslint-plugin recommended)

# Module DB migrations (run from this plugin dir when a src/modules/* model changes):
npx medusa plugin:db:generate   # generate migrations from data models
# In the consuming Medusa app, links/migrations are applied with: npx medusa db:migrate
```

There is no test setup wired up yet (`@medusajs/test-utils` is a dependency but no test script or test files exist). If adding tests, follow Medusa's integration-test conventions and add a `test` script to `package.json`.

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
