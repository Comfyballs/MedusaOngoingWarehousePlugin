# Ongoing Warehouse Fulfillment Plugin — Design

**Date:** 2026-06-23
**Status:** Approved design, ready for implementation planning
**Target:** Medusa v2 (2.16.0) plugin

## 1. Purpose

A Medusa v2 plugin that integrates Medusa with the **Ongoing Warehouse** WMS so that
orders are fulfilled through Ongoing and inventory is synced back into Medusa. It must
support **multiple Ongoing warehouses**, each bound to **exactly one** Medusa stock
location.

Scope:

- Send new orders to Ongoing (`ProcessOrder`) when a fulfillment is created in Medusa.
- Receive tracking + shipment confirmation back from Ongoing (polling **and** webhook).
- Send order updates (full edit re-sync) to Ongoing, gated by Ongoing order status codes.
- Cancel orders in Ongoing when cancelled in Medusa.
- Pull stock quantities from Ongoing (`GetInventoryByQuery`) into Medusa.
- Operator visibility: persisted sync state, retry UI on the order, and a dashboard.

Out of scope for now (documented extension points):

- Pushing articles to Ongoing (`ProcessArticle`) — SKU matching used instead; the
  article mapping is structured so this can be added without rework.
- Returns / label retrieval — provider methods stubbed as extension points.
- Storing Ongoing credentials in the DB (encrypted) — credentials live in environment
  variables for now.
- Hard-blocking Medusa order edits when Ongoing status disallows them — flagged stretch
  goal; baseline is skip-with-warning.

## 2. Ongoing API reference

REST v1 (OpenAPI `https://developer.ongoingwarehouse.com/REST/v1/openapi.json?version=57`).
Auth: HTTP Basic (username/password) + `goodsOwnerId` in payloads. Key operations:

- `ProcessOrder` — create/upsert an order in Ongoing.
- `GetOrdersByQuery` — poll order status (3-digit status codes) + tracking.
- `GetInventoryByQuery` — read stock levels per article.
- `ProcessArticle` — create/update articles (deferred).

Ongoing rate-limits concurrent requests; batch syncs must be throttled/serialized per
integration (see `https://developer.ongoingwarehouse.com/parallel-requests`).

## 3. Architecture overview

A **single** Ongoing fulfillment provider is registered in `medusa-config` (Medusa
requires static provider registration). All provider methods, jobs, and workflows
resolve *which* warehouse to talk to via the order's **stock location**, then load that
integration's settings from the `ongoing` module and its credentials from plugin options.
This yields N warehouses with one provider registration plus runtime-managed bindings.

Two bindings coexist per location:

- **Medusa-native:** stock location → fulfillment set → service zone → shipping option →
  Ongoing provider (lets operators create fulfillments at that location).
- **Plugin:** an `OngoingIntegration` record whose `stock_location_id` is **unique**
  (enforces one integration ⇄ one location), supplying non-secret settings and a
  reference to a credential set.

### Credential handling

Credentials are **not** stored in the DB. They are supplied via plugin options sourced
from environment variables in the consuming app's `medusa-config`:

```ts
options: {
  integrations: [{
    key: "warehouse-a",              // referenced by OngoingIntegration.credential_key
    baseUrl: process.env.ONGOING_A_URL,
    username: process.env.ONGOING_A_USER,
    password: process.env.ONGOING_A_PASS,
    goodsOwnerId: process.env.ONGOING_A_GOODS_OWNER,
    webhookApiKey: process.env.ONGOING_A_WEBHOOK_KEY,
  }],
  // optional global defaults:
  defaultStockSyncInterval?: string,
  defaultStatusPollInterval?: string,
  rateLimitConcurrency?: number,     // per-integration cap for batch calls
}
```

The DB holds only non-secret operational config. (Future extension: optionally store
encrypted credentials in the DB so warehouses can be added without a redeploy.)

## 4. Module: `ongoing` (`src/modules/ongoing`)

### Models

**`OngoingIntegration`** (no secrets):

- `credential_key` (unique) — references a plugin-options credential set.
- `enabled`
- `stock_location_id` (unique) — one integration ⇄ one location.
- `stock_sync_enabled`, `stock_sync_interval`
- `status_poll_interval`
- `edit_sync_rules` (JSON) — per edit-type (`address_contact`, `line_items`) → allowed or
  blocked 3-digit Ongoing status codes.

**`OngoingOrderSync`**:

- `integration_id`
- `medusa_order_id`, `medusa_fulfillment_id`
- `ongoing_order_id`, `ongoing_order_number`
- `latest_status_code`, `latest_status_text`
- `sync_state` — `pending | sent | shipped | cancelled | error`
- `last_synced_at`, `last_error`, `retry_count`

**`OngoingArticleMap`** — *future extension point* (SKU matching used for now).

### Service

Extends `MedusaService` with the two models, plus helpers:

- `getIntegrationByLocation(stockLocationId)` — resolves the integration + its credential
  set from plugin options.
- `getCredentials(credentialKey)` — reads the matching plugin-options entry.
- `recordSync(...)` — upsert `OngoingOrderSync` state/errors.

### Links (`src/links`)

- `OngoingOrderSync` ⇄ `order`
- `OngoingOrderSync` ⇄ `fulfillment`
- `OngoingIntegration` ⇄ `stock_location` (graph queries)

## 5. Fulfillment provider (`src/providers/ongoing-fulfillment`)

Extends `AbstractFulfillmentProviderService`:

- `getFulfillmentOptions` / `validateFulfillmentData` — basic shipping-option support.
- `createFulfillment` → runs `pushOrderToOngoing` workflow (`ProcessOrder`). SKU ⇄ Ongoing
  article-number matched; a missing article fails with a clear error and sets
  `sync_state=error`.
- `cancelFulfillment` → runs `cancelOngoingOrder` workflow (only if Ongoing status still
  permits cancellation).
- Returns / labels (`createReturnFulfillment`, `getFulfillmentDocuments`) — stubbed
  extension points.

The provider resolves the integration via the fulfillment's stock location.

## 6. Workflows (`src/workflows`)

- `pushOrderToOngoing` — `ProcessOrder` create; records `OngoingOrderSync`.
- `syncOrderEditToOngoing` — status-gated `ProcessOrder` upsert.
- `cancelOngoingOrder` — cancel in Ongoing if permitted.
- `syncOngoingShipment` — apply tracking + mark Medusa fulfillment shipped. **Shared by
  both the poll job and the webhook route.**
- `syncOngoingInventory` — per-integration stock pull.
- `retryFailedSyncs` — re-attempt `error`-state syncs with exponential backoff.

Every Ongoing call has compensation / error capture that writes to `OngoingOrderSync`.

## 7. Inbound: tracking + status

- **Poll job** — per integration on its `status_poll_interval`: `GetOrdersByQuery`
  updates `latest_status_code` (used for edit-gating) and, when shipped, calls
  `syncOngoingShipment`.
- **Webhook route** — public `POST /ongoing/webhooks/:credentialKey`, authenticated by an
  **API-key header** compared against that integration's `webhookApiKey`. Calls the same
  `syncOngoingShipment`.

Webhook = low latency; poll = reliable backfill.

## 8. Order updates — full edit re-sync, gated

Subscriber on order-edit / order-update events:

1. Resolve the `OngoingOrderSync` + `latest_status_code` (refresh from Ongoing if stale).
2. Consult `edit_sync_rules` for the edit type (`address_contact` vs `line_items`):
   - **Allowed** for the current status code → run `syncOrderEditToOngoing`
     (`ProcessOrder` upsert).
   - **Blocked** → skip and emit a warning event; surface it in the admin order widget.
3. (Stretch goal) optionally hard-block the Medusa edit when disallowed.

Cancellation is handled via `cancelOngoingOrder` (provider `cancelFulfillment` /
order-cancel subscriber).

## 9. Stock sync

A dispatcher job runs frequently and, for each enabled integration whose
`stock_sync_interval` has elapsed, runs `syncOngoingInventory`:

- `GetInventoryByQuery` (paginated), throttled by a per-integration concurrency limiter
  per Ongoing's parallel-request limits.
- Match Ongoing article ⇄ Medusa variant SKU.
- Set Medusa **`stocked_quantity = Ongoing available + Medusa reserved`** at the bound
  location. Ongoing's reported *available* is treated as the source of truth, and adding
  back Medusa's reserved avoids double-counting allocations.

## 10. Admin UI (`src/admin`)

- **Settings page** — list integrations; create/edit form that picks an available
  `credential_key` (from configured options), assigns the stock location, sets stock +
  poll intervals and the `edit_sync_rules` editor, shows the webhook URL, and offers a
  **Test connection** action (uses env-sourced creds).
- **Order widget** — Ongoing order id, current status code/text, tracking, last
  sync/error, and a **re-push / retry** button.
- **Dashboard page** — failed/pending syncs across all orders with **bulk retry**, plus
  per-integration connection health.

## 11. Cross-cutting

- **Ongoing REST client** (`src/.../lib`): Basic auth + `goodsOwnerId`, pagination,
  rate-limit throttling, typed wrappers for the four operations.
- **Plugin options:** `integrations[]` (with credentials from env), optional default
  intervals, `rateLimitConcurrency`. Per-warehouse operational settings live in the DB.
- **Failure handling:** every sync attempt recorded; `retryFailedSyncs` job with
  exponential backoff; dashboard + order widget surface state.
- **Dispatcher pattern:** Medusa jobs have a single fixed schedule each, so per-integration
  intervals are realized by a frequently-running dispatcher that checks each integration's
  interval and last-run timestamp.

## 12. Testing

- **Integration tests** via `@medusajs/test-utils` against a **mocked Ongoing REST
  client** — fulfillment push, shipment sync (poll + webhook), edit gating, cancellation,
  stock sync.
- **Unit tests** for: status-code gating logic, the `available + reserved` stock
  reconciliation, webhook API-key auth, and the pagination/throttle client behavior.
- Add a `test` script to `package.json` (none exists yet).

## 13. Packaging notes

Per the repo's `package.json` `exports` map and build output in `.medusa/server`:

- Fulfillment provider → `src/providers/ongoing-fulfillment/index.ts`
- Module → `src/modules/ongoing/index.ts`
- Workflows → `src/workflows/index.ts`
- Admin → bundled separately (excluded from the server `tsconfig`)

Run `npx medusa plugin:db:generate` after defining the module models; the consuming app
applies migrations/links with `npx medusa db:migrate`.
