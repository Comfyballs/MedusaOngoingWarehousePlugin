# Ongoing Warehouse Fulfillment Plugin — Design

**Date:** 2026-06-23
**Status:** Approved design (revised after Medusa-v2 technical review + Ongoing API research), ready for implementation planning
**Target:** Medusa v2 (2.16.0) plugin

## 1. Purpose

A Medusa v2 plugin that integrates Medusa with the **Ongoing Warehouse** WMS so that
orders are fulfilled through Ongoing and inventory is synced back into Medusa. It must
support **multiple Ongoing warehouses**, each bound to **exactly one** Medusa stock
location.

Scope:

- Send new orders to Ongoing (`ProcessOrder` / `PUT /api/v1/orders`) when a fulfillment is
  created in Medusa.
- Receive tracking + shipment confirmation back from Ongoing (polling **and** webhook).
- Send order updates (full edit re-sync) to Ongoing, gated by Ongoing order status codes.
- Cancel orders in Ongoing when cancelled in Medusa.
- Pull stock quantities from Ongoing (`GetInventoryByQuery`) into Medusa.
- Operator visibility: persisted sync state, retry UI on the order, and a dashboard.

Out of scope for now (documented extension points):

- Pushing articles to Ongoing (`ProcessArticle`) — SKU matching used instead; article
  mapping is structured so this can be added without rework.
- Returns / label retrieval — provider methods stubbed as extension points.
- Storing Ongoing credentials in the DB (encrypted) — credentials live in environment
  variables for now.
- Hard-blocking Medusa order edits when Ongoing status disallows them — flagged stretch
  goal; baseline is skip-with-warning.

## 2. Ongoing API reference (researched)

REST v1 base: `https://<host>/api/v1`. Auth: HTTP Basic (username/password) + `goodsOwnerId`
in payloads. OpenAPI: `.../REST/v1/openapi.json?version=57`.

Key operations and **verified** semantics:

- **`PUT /api/v1/orders`** (`ProcessOrder`, body `PostOrderModel`) — **idempotent upsert keyed
  by `orderNumber`** (+ `goodsOwnerId`): if no order with that `orderNumber` exists it is
  created, otherwise updated. This is what makes order push and edit re-sync safe to retry.
- **`GET /api/v1/orders` / GetOrdersByQuery** — poll order status + tracking. Status filtering
  uses numeric ranges (`orderStatusFrom` / `orderStatusTo`). Tracking is returned as
  `orderTracking` plus **`parcels[]` with per-parcel `parcelTracking`** → an order can have
  **multiple tracking numbers** (multi-parcel shipments).
- **`GET /api/v1/orders/statuses`** — returns the installation's order statuses. **Status codes
  are installation-specific, not a fixed global enum** — fetch them at runtime; the admin rules
  editor is populated from this endpoint rather than hardcoding codes.
- **`GetInventoryByQuery`** — returns multiple distinct quantity fields per article (not one
  "available"):
  - `NumberOfItemsDecimal` — total physical stock in the warehouse (on-hand).
  - `AllocatedNumberOfItems` — allocated to orders, unpicked.
  - `SellableNumberOfItems` — items that can still be sold.
  - `ToReceiveNumberOfItems` — expected on inbound purchase orders (future stock).
  - (others: `NumberOfBookedItemsDecimal`, `NumberOfLockedItems`, `LockedForSaleNumberOfItems`,
    `PickedToBeCollectedNumberOfItems`, `ReceivedToBeFinishedNumberOfItems`.)
  - `GetInventoryPerWarehouse` summarizes per article **and warehouse** for multi-warehouse setups.
- **`ProcessArticle`** — create/update articles (deferred).

Ongoing rate-limits concurrent requests; batch syncs must be throttled/serialized per
integration (`https://developer.ongoingwarehouse.com/parallel-requests`). The client must also
honor `429` + `Retry-After`.

## 3. Architecture overview

A **single** Ongoing fulfillment provider is registered in `medusa-config` (Medusa requires
static provider registration). All provider methods, jobs, and workflows resolve *which*
warehouse to talk to via the order's/fulfillment's **stock location**, then load that
integration's settings from the `ongoing` module and its credentials from plugin options.
One registration + runtime-managed bindings = N warehouses.

Two bindings coexist per location:

- **Medusa-native:** stock location → fulfillment set → service zone → shipping option
  (`provider_id`) → fulfillment. A provider is usable at a location only because a shipping
  option referencing it lives in a service zone of a fulfillment set attached to that location.
- **Plugin:** an `OngoingIntegration` record whose `stock_location_id` is **unique** (enforces
  one integration ⇄ one location), supplying non-secret settings + a credential-set reference.

**Setup workflow (new, required):** creating an `OngoingIntegration` must also provision the
native binding — a fulfillment set + service zone + at least one shipping option pointing at the
Ongoing provider for that location. Without it the provider is never invoked. The admin
"create integration" action runs a `setupOngoingLocationWorkflow` that creates/links these (or
links to an existing fulfillment set), and surfaces what it created.

### Credential handling

Credentials are **not** stored in the DB. They are supplied via plugin options sourced from
environment variables in the consuming app's `medusa-config`:

```ts
options: {
  integrations: [{
    key: "warehouse-a",              // referenced by OngoingIntegration.credential_key
    baseUrl: process.env.ONGOING_A_URL,
    username: process.env.ONGOING_A_USER,
    password: process.env.ONGOING_A_PASS,
    goodsOwnerId: process.env.ONGOING_A_GOODS_OWNER,
    webhookSecret: process.env.ONGOING_A_WEBHOOK_SECRET, // HMAC secret (preferred) or API key
  }],
  defaultStockSyncInterval?: string,
  defaultStatusPollInterval?: string,
  rateLimitConcurrency?: number,     // per-integration cap for batch calls
}
```

Boot-time validation (new): on module load, validate that every `integrations[]` entry has all
required fields and that URLs/creds are present; fail loudly. At runtime, fail with a clear error
if an `OngoingIntegration.credential_key` references a key not present in options.

## 4. Module: `ongoing` (`src/modules/ongoing`)

### Models

**`OngoingIntegration`** (no secrets):

- `credential_key` (**unique**, `.unique()` at DB level) — references a plugin-options set.
- `enabled`
- `stock_location_id` (**unique**) — one integration ⇄ one location.
- `stock_sync_enabled`, `stock_sync_interval`
- `status_poll_interval`
- `stock_reconcile_mode` — how Medusa `stocked_quantity` is computed from Ongoing + Medusa
  reservations; one of `sellable_plus_reserved` (A, **default**) | `precise` (B) | `onhand` (raw).
  All three ship. See §9.
- `edit_sync_rules` (JSON) — per edit-type (`address_contact`, `line_items`) → allowed status
  codes (configured against the live `GET /orders/statuses` list).
- `shipped_status_codes` (JSON) — which status codes mean "dispatched" (drives shipment sync).
- `cancellable_status_codes` (JSON) — which codes still permit cancellation.
- `last_stock_sync_at`, `last_status_poll_at` — for the dispatcher.
- `sync_lock_until` (nullable) — per-integration in-progress lock (multi-instance safety).

**`OngoingOrderSync`**:

- `integration_id`
- `medusa_order_id`, `medusa_fulfillment_id`
- `ongoing_order_number` (the upsert key we generate), `ongoing_order_id`
- `latest_status_code`, `latest_status_text`
- `sync_state` — `pending | sent | shipped | cancelled | error`
- `error_class` — `retryable | terminal` (drives retry; see §11)
- `last_synced_at`, `last_error`, `retry_count`
- `shipped_at` (idempotency guard for shipment apply)

**`OngoingArticleMap`** — *future extension point* (SKU matching used for now).

### Service

Extends `MedusaService` (auto CRUD for both models) plus helpers:
`getIntegrationByLocation(locationId)`, `getCredentials(credentialKey)`,
`acquireSyncLock(integrationId, ttl)` / `releaseSyncLock`, `recordSync(...)`.

### Links (`src/links`)

- `OngoingOrderSync` ⇄ `order`
- `OngoingOrderSync` ⇄ `fulfillment`
- `OngoingIntegration` ⇄ `stock_location` (graph traversal; the unique `stock_location_id`
  column is kept for the constraint and for direct service-level filtering, set in the same
  workflow that creates the link). **Note:** `query.graph` cannot filter by linked-module
  fields — all lookups filter on the stored id columns (`medusa_order_id`, `stock_location_id`),
  not across links.

## 5. Fulfillment provider (`src/providers/ongoing-fulfillment`)

Extends `AbstractFulfillmentProviderService`. **Verified signatures drive the design:**

- `getFulfillmentOptions(): Promise<FulfillmentOption[]>` — returns stable option ids. (A single
  provider returns one option list regardless of location; if Ongoing carriers differ per
  warehouse this is a known limitation — see §13.)
- `validateOption(data): Promise<boolean>` — **must override** (base throws); without it admins
  can't create shipping options for the provider.
- `validateFulfillmentData(optionData, data, context)` — `context` carries `from_location`,
  `shipping_address`, `items`, `currency_code`; use for early validation.
- `createFulfillment(data, items, order, fulfillment)` → `{ data, labels? }`. **`order` may be
  `undefined` and `items` are thin**, so this method only: (a) reads `fulfillment.id` +
  `fulfillment.location_id`, (b) runs `pushOrderToOngoing` (which **re-queries the full order**
  via `query.graph` by the linked order id to build the Ongoing payload), (c) returns
  `data: { ongoing_order_number, ongoing_order_id, location_id, credential_key }`. **Confirm at
  implementation time that `fulfillment.location_id` is hydrated** in the partial DTO (log during
  a dev fulfillment); handle missing/undefined.
- `cancelFulfillment(data)` — **receives only `data`** (no fulfillment/location arg). Resolves the
  warehouse from the `{ ongoing_order_number, location_id, credential_key }` stashed in `data` on
  create, then runs `cancelOngoingOrder`. Must be idempotent.
- `createReturnFulfillment`, `getFulfillmentDocuments` — stubbed extension points.
- `canCalculate` → `false` (flat Ongoing rates; revisit if calculated rates are needed).

## 6. Workflows (`src/workflows`)

- `setupOngoingLocationWorkflow` — provisions/links the native fulfillment-set/service-zone/
  shipping-option binding for a location.
- `pushOrderToOngoing` — re-queries the order, maps to `PostOrderModel`, `PUT /api/v1/orders`
  (upsert by generated `orderNumber`), records `OngoingOrderSync`.
- `syncOrderEditToOngoing` — status-gated `PUT /api/v1/orders` upsert (same idempotent endpoint).
- `cancelOngoingOrder` — cancel in Ongoing if `latest_status_code ∈ cancellable_status_codes`;
  idempotent.
- `syncOngoingShipment` — apply tracking + mark Medusa fulfillment shipped via Medusa's
  **`createOrderShipmentWorkflow`** (so reservations finalize and `order.shipment_created`
  fires). Handles **multiple parcel tracking numbers**. **Idempotent**: no-op if
  `OngoingOrderSync.shipped_at` already set. **Shared by both the poll job and the webhook route.**
- `syncOngoingInventory` — per-integration stock pull (see §9).
- `retryFailedSyncs` — re-attempt `sync_state=error AND error_class=retryable` with exponential
  backoff.

Every Ongoing call has compensation / error capture writing `OngoingOrderSync`
(`sync_state`, `error_class`, `last_error`).

### Order-number (upsert key) scheme

`ongoing_order_number` is generated **per Medusa fulfillment** (a Medusa order can have multiple
fulfillments, possibly across locations → one Ongoing order each), e.g.
`<order.display_id>-<fulfillment short id>`. Stable across retries (idempotent upsert) and unique
per Ongoing order.

## 7. Inbound: tracking + status

- **Poll job** — per integration on its `status_poll_interval`: `GetOrdersByQuery` updates
  `latest_status_code` (used for edit-gating) and, when the code ∈ `shipped_status_codes`, calls
  `syncOngoingShipment`.
- **Webhook route** — public `POST /ongoing/webhooks/:credentialKey`, authenticated by an
  **HMAC signature** over the body using the integration's `webhookSecret` (preferred; falls back
  to API-key header if Ongoing can't sign). **`crypto.timingSafeEqual`** comparison; **uniform
  `401`** for unknown key and bad signature (no warehouse enumeration); basic replay protection.
  Calls the same `syncOngoingShipment`.

**Poll/webhook concurrency:** both paths converge on the idempotent `syncOngoingShipment`, guarded
by `OngoingOrderSync.shipped_at` + a row-level lock, so shipment/tracking is applied exactly once.
**Webhook payload shape needs verification** against Ongoing before coding the parser.

## 8. Order updates — full edit re-sync, gated

Subscriber on **`order-edit.confirmed`** (payload `{ order_id, actions[] }`) — **not**
`order.updated`:

1. Resolve `OngoingOrderSync` + `latest_status_code` (read cached; refresh from Ongoing only if
   older than a bound, with timeout — don't block the event path).
2. Classify the edit from `actions[]` (address/contact vs line-items) and consult
   `edit_sync_rules` for the current status code:
   - **Allowed** → run `syncOrderEditToOngoing` (idempotent `PUT /orders` upsert).
   - **Blocked** → skip + emit a warning event; surface in the admin order widget.
3. (Stretch) optionally hard-block the Medusa edit when disallowed.

**Cancellation** is event-`order.canceled` (single-L) and provider `cancelFulfillment` — two
triggers that both route to the idempotent `cancelOngoingOrder`, which converges safely.

Subscribers never throw (log + record error), are idempotent, and re-query full data from the
`{ id }`-style event payload.

## 9. Stock sync

A dispatcher job runs frequently; for each enabled integration whose `stock_sync_interval` has
elapsed (`now − last_stock_sync_at`) and that is not locked, it acquires `sync_lock_until` and runs
`syncOngoingInventory`:

- `GetInventoryByQuery` (paginated), throttled by a per-integration concurrency limiter +
  `429`/`Retry-After` handling. Fields used: `SellableNumberOfItems` (`sellable`),
  `AllocatedNumberOfItems` (`alloc`), `ToReceiveNumberOfItems`.
- Match Ongoing article ⇄ Medusa variant SKU.
- **Reconcile `stocked_quantity` so Medusa's derived `available` reflects both systems'
  reservations without double-counting.** `sellable` already nets out Ongoing-side allocations/
  locks (so it's the base); Medusa reservations that Ongoing does **not** already know about must
  additionally reduce availability. Let `M_res` = Medusa `reserved_quantity` at the location:

  - **`sellable_plus_reserved` (Approach A, default):**
    `stocked_quantity = sellable + min(M_res, alloc)`
    ⇒ `available = sellable − max(0, M_res − alloc)`.
    Adds reserved back but caps the add-back at Ongoing's `alloc`, so a Medusa reservation that is
    already an Ongoing allocation isn't subtracted twice, while manual/un-synced Medusa
    reservations still reduce availability. **Known bounded inaccuracy:** when a SKU has *both*
    manual Medusa reservations *and* direct-in-Ongoing orders, `min` overestimates the overlap and
    slightly overstates availability (minor oversell risk).
  - **`precise` (Approach B, shipped as a selectable per-integration mode):** correlate Medusa
    reservations to synced Ongoing
    orders via `OngoingOrderSync` to get `M_res_synced` (reservations already represented as
    Ongoing allocations); `stocked_quantity = sellable + M_res_synced`. Exact, but a per-SKU
    reservation↔order correlation cost.
  - **`onhand` (raw):** `stocked_quantity = NumberOfItemsDecimal`, Medusa owns reservations
    entirely (ignores Ongoing allocations) — for stores with no direct-Ongoing orders.

  Clamp `stocked_quantity` to `≥ 0`.
- Map `ToReceiveNumberOfItems` → Medusa `incoming_quantity`.
- Writes are absolute; read `M_res` and write `stocked_quantity` inside **one workflow step**
  (re-read `M_res` immediately before writing) to minimize the clobber window against concurrent
  reservations. The write only touches `stocked_quantity`, never reservations.

Update `last_stock_sync_at`; release the lock.

## 10. Admin UI (`src/admin`)

- **Settings page** — list integrations; create/edit form picks an available `credential_key`,
  assigns the stock location (runs `setupOngoingLocationWorkflow`), sets stock + poll intervals,
  `stock_source_field`, and the `edit_sync_rules` / `shipped_status_codes` / `cancellable_status_codes`
  editors **populated from `GET /orders/statuses`** via a **Test connection** action.
- **Order widget** — Ongoing order number/id, current status code/text, tracking (parcels), last
  sync/error, **re-push / retry** button.
- **Dashboard page** — failed/pending syncs across all orders with **bulk retry**, plus
  per-integration connection health.

## 11. Cross-cutting

- **Ongoing REST client** (`src/.../lib`): Basic auth + `goodsOwnerId`, pagination, per-integration
  concurrency limiter, `429`/`Retry-After` backoff, typed wrappers, and an **error taxonomy** that
  classifies failures as `retryable` (network, 429, 5xx) vs `terminal` (validation, missing article,
  4xx). Only `retryable` is retried by `retryFailedSyncs`.
- **Idempotency** — order push/edit via `orderNumber` upsert; shipment apply guarded by
  `shipped_at`; cancel is idempotent. All workflows safe under retry / duplicate events.
- **Field mapping** (new requirement) — an explicit Medusa→`PostOrderModel` mapping: shipping
  address (ISO-2 country code, postal, phone), consignee/contact, line items (SKU→article number,
  quantity), weights/units, currency. Prices sent **as-is** (Medusa is not minor-units). A
  validation step fails fast with an operator-readable error (`sync_state=error`,
  `error_class=terminal`) on missing/invalid fields.
- **SKU collisions** — SKU is not guaranteed unique across Medusa variants. If a SKU resolves to
  >1 variant (stock sync) or can't be uniquely resolved (order push), record a `terminal` error
  surfaced in the dashboard rather than guessing. (Configurable "require unique SKU" assumption.)
- **Partial / multi-shipment orders** — one Ongoing order per Medusa fulfillment; shipment sync
  handles N parcel tracking numbers per fulfillment.
- **Dispatcher** — Medusa job schedules are static, so per-integration intervals use a frequent
  dispatcher comparing `now − last_*_at`, with persisted timestamps + a `sync_lock_until` lock for
  multi-instance/overlap safety. (Alternative considered: fixed interval tiers — simpler, less
  flexible; chosen against because per-integration intervals were a stated requirement.)
- **Soft-delete** — links to `stock_location`/`order`/`fulfillment` cascade appropriately; stale
  sync rows are not resurrected.
- **Observability** — structured logs with correlation ids (medusa order ⇄ ongoing order number),
  success/failure counters, and `ongoing.sync.*` events feeding the dashboard.

## 12. Testing

- **Integration tests** (`@medusajs/test-utils`) against a **mocked Ongoing REST client** —
  fulfillment push (upsert), edit gating, cancellation, shipment sync via `createOrderShipmentWorkflow`
  (poll + webhook, including the double-apply guard), stock sync.
- **Unit tests** — status-code gating, the stock reconciliation formulas (Approach A `min` cap,
  the bounded-inaccuracy mixed scenario, clamp-to-zero), the upsert `orderNumber` scheme,
  webhook HMAC + timing-safe compare, error-taxonomy classification, SKU-collision handling,
  pagination/throttle/429 client behavior.
- Add a `test` script to `package.json` (none exists yet).

## 13. Open items to verify during implementation

1. **`fulfillment.location_id` hydration** in the `createFulfillment` partial DTO (2.16.0).
2. **Ongoing webhook payload shape + auth** (does Ongoing sign? per-warehouse URL support?).
3. **Exact order-edit events / action types** for address vs contact vs line-item changes in 2.16.0
   (map to the `edit_sync_rules` categories).
4. **Per-warehouse carrier options** — whether `getFulfillmentOptions` (no args) can express
   warehouse-specific carriers; flagged limitation if not.
5. Confirm `createOrderShipmentWorkflow` is the correct entry point for applying tracking +
   releasing reservations.

## 14. Packaging notes

Per the repo's `package.json` `exports` map and build output in `.medusa/server`:

- Fulfillment provider → `src/providers/ongoing-fulfillment/index.ts`
- Module → `src/modules/ongoing/index.ts`
- Workflows → `src/workflows/index.ts`
- Admin → bundled separately (excluded from the server `tsconfig`)

Models use `.unique()` for `credential_key` and `stock_location_id`. Run
`npx medusa plugin:db:generate` after defining models; the consuming app applies migrations +
links with `npx medusa db:migrate`.
