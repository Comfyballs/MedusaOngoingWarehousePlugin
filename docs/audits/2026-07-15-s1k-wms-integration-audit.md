# WMS Integration Architecture Audit — Ongoing Warehouse Plugin

> **ARCHIVED / HISTORICAL — not a live punch-list.** This audit is a point-in-time snapshot from 2026-07-15. The three criticals it identifies (C1 fictional pagination, C2 nonexistent inventory endpoint, C3 wrong tracking-field paths) were fixed in commit `76c187d` ("fix(ongoing): make the Ongoing REST client conform to OpenAPI v57", beads `ji6`/`dtw`/`5vu`/`4s4`) and subsequent work (`sw8` delta inventory sync, `3e8` batched reconcile). Kept for historical record only — do not treat its findings as current state; see `docs/wiki/Dev-Architecture.md` for the up-to-date architecture reference.

- **Bead:** `MedusaOngoingWarehousePlugin-s1k`
- **Date:** 2026-07-15
- **Scope:** Holistic, outside-in audit of the plugin against Ongoing Warehouse's recommended integration patterns and Medusa v2 architectural conventions (judged with the `medusa-dev:building-with-medusa` skill loaded).
- **Method:** Full read of `src/` (providers, modules, workflows, subscribers, jobs, api, links, lib); all 13 required external resources fetched; independent research round (Ongoing webhook docs, Ongoing REST OpenAPI v57 downloaded and machine-inspected, npm/GitHub plugin survey). The graphify graph (`graphify-out/GRAPH_REPORT.md`) was read but is **stale** — generated 2026-06-23 from the 5-file starter scaffold (6 nodes, "GET()" as the only god node); it predates the entire integration and provided no usable structure signal.

---

## Executive summary

The plugin's **Medusa-side architecture is strong** — arguably above reference quality: deterministic idempotency keys, PUT-upsert order push, persisted sync-state rows with classified errors and CAS-guarded retry sweeps, hybrid webhook+poll shipment detection, per-integration advisory locks, workflows for all order-path mutations, and correct module/link isolation. It compares favorably with the ShipStation example and every public Medusa 3PL plugin surveyed.

The **Ongoing-side HTTP client, however, was never verified against Ongoing's actual REST spec**, and machine-inspection of `openapi.json?version=57` confirms three conformance defects, two of them critical:

1. **Pagination is fictional.** The client paginates with `page`/`pageSize` query params that appear **zero times** in the OpenAPI spec. Ongoing paginates by ID-cursor (`orderIdFrom`/`maxOrdersToGet`, `articleSystemIdFrom`/`maxArticlesToGet`), last page = empty response. Today every "page" request is the identical request, so any result set ≥ the assumed page size (50) makes `paginate()` loop forever inside the every-minute jobs.
2. **The inventory endpoint does not exist.** `GET /articles/inventory` is not in the spec; inventory comes from `GET /api/v1/articles` (`inventoryInfo`) or `/articles/inventoryPerWarehouse`. Stock sync will 404 (terminal) on every tick against a real Ongoing instance.
3. **Poll-path tracking numbers are always empty.** The client reads `parcels[].parcelTracking.code`/`parcels[].trackingNumber`; the real shape is `parcels[].tracking.waybill` (plus a top-level `tracking[]` and `trackingUrl` that are currently discarded).

Secondary gaps: throttling is per-client-instance (a new `OngoingClient` per `getClient()` call), so the "sequential per goods owner" rule Ongoing documents is not actually enforced process-wide; no article sync (`PUT /articles` / `ProcessArticle`, step 1 of Ongoing's webshop flow); no `wayOfDelivery`/transporter mapping; inventory reconcile is N+1 per SKU; delta sync via `stockInfoChangedFrom` is unused. Returns and label/document retrieval are intentionally stubbed extension points.

**Bottom line:** ship-blocking work is concentrated in one file (`src/lib/ongoing/client.ts`) and is cheap to fix; the surrounding architecture is sound and does not need restructuring. An integration test pass against a live/demo Ongoing tenant should follow the client fixes, since these defects are precisely the class that unit tests with stubbed fetch cannot catch.

---

## Current architecture (as-built mental model)

- **Order push:** Admin creates a fulfillment → `OngoingFulfillmentProviderService.createFulfillment` (`src/providers/ongoing-fulfillment/service.ts`) resolves the integration bound to `fulfillment.location_id` and synchronously runs `pushOrderToOngoing` (`src/workflows/push-order-to-ongoing.ts`): re-query order via fulfillment → resolve integration context → map to `PostOrderModel` (`src/lib/ongoing/order-mapper.ts`, prices as-is per Medusa's price rule) → `PUT /orders` with a deterministic `orderNumber` = `<display_id>-<fulfillment_id>` (`src/lib/ongoing/order-number.ts`), persisted to `OngoingOrderSync` *before* the PUT (pending → sent/error). External IDs are stashed in `fulfillment.data`.
- **Cancel:** `order.canceled` subscriber and `cancelFulfillment` both run the idempotent, status-gated `cancelOngoingOrderWorkflow` (gate on `cancellable_status_codes`; `status_not_cancellable` throws from the provider so Medusa never marks the fulfillment cancelled while Ongoing keeps shipping — #109 fix).
- **Edits:** `order.updated` (address/contact, burst-aware order-change union) and `order-edit.confirmed` (line items) subscribers gate on per-integration `edit_sync_rules` × `latest_status_code`, re-PUT the same `orderNumber` (upsert), and persist/clear `edit_blocked_*` state (persist-then-emit).
- **Shipment in:** every-minute `status-poll` job sweeps `getOrdersByStatus(100–999)` per due integration under an advisory lock, refreshes `latest_status_code`, and on a shipped code runs `syncOngoingShipmentWorkflow` → core `createOrderShipmentWorkflow` (idempotent via `shipped_at` + Medusa's "Shipment has already been created" swallow). A webhook route (`src/api/ongoing/webhooks/[credentialKey]/route.ts`, timing-safe `X-Auth-Token`, goodsOwnerId cross-check) feeds the same workflow for low latency; the poll is the reconciliation backstop.
- **Inventory in:** every-minute `stock-sync` job per due integration → `getInventory()` → `reconcileInventoryLevelsStep` writes `stocked_quantity` (+`incoming_quantity`) per SKU under three modes (`sellable_plus_reserved` default, `precise`, `onhand`).
- **Retry:** `retry-failed-syncs` job sweeps `sync_state=error AND error_class=retryable`, exponential backoff 5→60 min, cap 5 attempts, CAS-guarded native UPDATE (`attemptRetrySyncTransition`) → re-invokes `pushOrderToOngoing` or dead-letters to `terminal`. HTTP layer has its own 3-retry/`Retry-After`-aware backoff for transient failures.
- **Data model:** `OngoingIntegration` (per-warehouse config: status codes, rules, intervals, lock) + `OngoingOrderSync` (sync state machine), linked to stock-location/order/fulfillment via `defineLink` (`src/links/`). Credentials live in plugin options keyed by `credential_key`, never in the DB.

---

## Per-dimension findings

### 1. Order push flow vs Ongoing's webshop flow

**What we do:** Push at fulfillment-creation time (not `order.placed`), synchronously inside the provider so failure aborts the fulfillment; deterministic `orderNumber` persisted before the PUT; edits re-PUT the same number; cancels gated by `cancellable_status_codes` with an attempt-on-unknown-status fallback.

**Best practice:** Ongoing's [webshop flow](https://developer.ongoingwarehouse.com/webshop-flow) is `ProcessArticle` → `GetInventory` → `ProcessOrder` → `GetOrdersByQuery`. The [OpenAPI spec](https://developer.ongoingwarehouse.com/REST/v1/openapi.json?version=57) confirms `PUT /api/v1/orders` is an upsert ("created if it does not already exist, or updated if it already exists") returning `PostOrderResponse {orderId, message}`, and `DELETE /orders/{orderId}` is only allowed "if the warehouse has not started working on it" — exactly what the status-gate models.

**Verdict: Strong, with two omissions.**
- Pushing per-fulfillment (rather than per-order at placement) is a deliberate, defensible divergence — it matches Medusa's fulfillment-provider model (ShipStation guide does the same) and gives partial-fulfillment support most plugins lack. The client's `putOrder` correctly guards a 2xx-without-`orderId` (#108).
- **Gap (article sync):** step 1 of Ongoing's flow — pushing articles (`PUT /api/v1/articles`) — is absent (deferred per spec §1/§13). Order PUTs referencing unknown articleNumbers will fail or depend on goods-owner-side auto-creation. → Recommendation R7.
- **Gap (wayOfDelivery):** `PostOrderModel` omits `wayOfDelivery`/transporter ("M2 baseline" comment in `order-mapper.ts`). The [transport-system doc](https://developer.ongoingwarehouse.com/integrate-transport-system) shows transport bookings trigger off orders whose transporter data was set upstream by the webshop — without it, warehouse staff must pick a carrier manually per order. → R6.
- Minor: `delivery_date` is hardcoded to push-time `new Date()` (`src/workflows/steps/map-order-to-ongoing.ts:28`) — acceptable "ship ASAP" semantics; report-only.

### 2. Inventory sync direction/cadence

**What we do:** Ongoing → Medusa only, per-integration interval (default 10 min) under a lock; `SellableNumberOfItems` based; three reconcile modes; writes `stocked_quantity` + `incoming_quantity` (from `ToReceiveNumberOfItems`); emits `INVENTORY_SYNCED`.

**Best practice:** Ongoing's [inventory doc](https://developer.ongoingwarehouse.com/inventory): "If you are integrating with a web shop … SellableNumberOfItems is the field to use." Medusa's [third-party sync best practices](https://docs.medusajs.com/learn/best-practices/third-party-sync): workflows + scheduled jobs, batch processing, only request needed fields, Maps for O(1) lookups, constant memory.

**Verdict: Right direction and right quantity semantics; wrong endpoint and inefficient shape.**
- **CRITICAL (C2):** `client.getInventory()` calls `GET /articles/inventory` — **that path does not exist** in the REST spec (verified by machine inspection: inventory-ish paths are `/api/v1/articles` with `inventoryInfo`, `/articles/inventoryPerWarehouse`, `/articles/historicalInventory`). Every stock-sync tick will 404 (classified terminal) against a real tenant. The optional filter also uses `articleNumber=` CSV; the spec's CSV param is `articleNumbers` (plural). → R1/R2.
- The mode design is genuinely better than reference plugins: `sellable_plus_reserved` correctly reconstructs Medusa's `stocked = sellable + reserved` invariant so Medusa's own reservations don't double-deduct; `precise` even scopes reservations to already-synced orders.
- **N+1:** `reconcileInventoryLevelsStep` does `listInventoryItems` + `listInventoryLevels` (+`listReservationItems` in precise mode) *per row*, and one `updateInventoryLevels` call per row despite the API taking an array — contra the third-party-sync guidance on batching. → R8.
- **Delta sync unused:** the spec exposes `stockInfoChangedFrom` on `GET /articles` — a changed-since cursor that would shrink each tick from "entire catalogue" to actual deltas. → R5.

### 3. Fulfillment provider contract completeness

**What we do:** `getFulfillmentOptions` (2 static options), `validateOption`, `validateFulfillmentData` (pass-through), `canCalculate` → false, `createFulfillment` (sync push + data stash), `cancelFulfillment` (idempotent, throws on `status_not_cancellable`), `createReturnFulfillment` (explicit no-op stub — base class throws), `getFulfillmentDocuments` (empty).

**Best practice:** The [fulfillment provider reference](https://docs.medusajs.com/resources/references/fulfillment/provider) and the [ShipStation guide](https://docs.medusajs.com/resources/integrations/guides/shipstation) implement options/validate/calculate/create/cancel and stash external IDs in `data` (ShipStation also skips `createReturnFulfillment`/`getFulfillmentDocuments`). The [Fulfillment Module docs](https://docs.medusajs.com/resources/commerce-modules/fulfillment) frame providers + workflow composition as the integration surface.

**Verdict: Complete for scope; two intentional stubs, one polish item.**
- No `calculatePrice` is correct for flat-rate Ongoing (vs ShipStation's rate-shopping) and is documented.
- The `data` stash pattern matches the reference exactly; `cancelFulfillment`'s throw/no-throw contract analysis against `FulfillmentModuleService.cancelFulfillment` (2.16.0) is unusually rigorous.
- Returns (`createReturnFulfillment`) and label/document retrieval are stubbed extension points; Ongoing *does* have a `returnOrders` resource in the spec, so returns are a real feature gap, not an API limitation. → R11.
- Nit (report-only): `OngoingFulfillmentData` types `medusa_order_id`/`medusa_fulfillment_id`, but `createFulfillment` never stashes them — cancellation works via `ongoing_order_number` alone; either stash them or drop them from the type.

### 4. Workflow design: compensation, retries, error propagation

**What we do:** All order-path mutations run in workflows composed per the SDK rules (`function`, `transform`, `when`, no awaits/conditionals). Error handling is record-then-rethrow inside step invokes (documented rationale: a throwing invoke gives compensation `undefined`), classified `retryable`/`terminal`, dead-lettered at 5 attempts via a CAS-guarded native UPDATE. Core `createOrderShipmentWorkflow` is invoked from inside a step (canonical pattern), with a written audit (#113) proving no duplicate `SHIPMENT_CREATED` on outer retries.

**Best practice:** [Medusa workflows reference](https://docs.medusajs.com/resources/medusa-workflows-reference) — core flows from `@medusajs/core-flows` executed from jobs/subscribers/steps; [third-party sync](https://docs.medusajs.com/learn/best-practices/third-party-sync) — retries with exponential backoff, timeouts, graceful failure isolation.

**Verdict: Excellent.** The two-layer retry model (HTTP-transient retries inside a call; workflow-level re-invocation sweeps across calls) is clearly documented in `retry-policy.ts` and correct. Compensation functions are absent by design; since the external PUT is an idempotent upsert keyed on a persisted order number, forward-recovery (retry) is the right model and rollback would be wrong.
- Improvement (report-only): outbound HTTP has no `AbortController` timeout — a hung socket stalls a whole job tick until the runtime default; the best-practices doc explicitly recommends request timeouts. Bundled into R4's client work.

### 5. Rate limiting / pagination / parallel-request compliance

**What we do:** `Throttle` (concurrency default 2) + bounded retries honoring `Retry-After`; `paginate()` with `page`/`pageSize=50`; jobs iterate integrations sequentially.

**Best practice:** Ongoing's [parallel-requests doc](https://developer.ongoingwarehouse.com/parallel-requests): writes are processed **sequentially per goods owner** server-side; "we recommend that you make all API calls to Ongoing WMS sequentially" — excess parallelism just causes timeouts. The [pagination doc](https://developer.ongoingwarehouse.com/paginating-responses) + OpenAPI: ID-cursor pagination (`orderIdFrom`/`maxOrdersToGet`, `articleSystemIdFrom`/`maxArticlesToGet`), stop when the response is empty; "paginate every function which supports it".

**Verdict: Non-compliant — the audit's most serious findings.**
- **CRITICAL (C1):** `page`/`pageSize` appear **nowhere** in the OpenAPI spec (0 grep hits in the downloaded 581 KB `openapi.json`). Every "page" is therefore the same unfiltered request. Termination relies on `batch.length < 50`; a tenant with ≥50 active orders (or ≥50 articles, once the inventory endpoint is fixed) returns the identical full result on every iteration → **infinite loop inside the every-minute jobs**, plus duplicated rows in `all`. Must move to cursor pagination. → R1.
- **HIGH (C4):** the throttle is per-`OngoingClient`-instance, and `OngoingModuleService.getClient()` constructs a **new client per call** (`service.ts:58`). Status-poll, stock-sync, retry sweeps, webhook-triggered workflows and admin repush each get their own `Throttle(2)`, so process-wide concurrency toward one goods owner is effectively unbounded — and three cron jobs fire on the same minute boundary. Cache one client (or one shared throttle) per `credential_key`, and default concurrency to 1 to match Ongoing's "sequential" guidance. → R4.
- Jobs' per-integration sequential loop and `Retry-After` handling are good and worth keeping.

### 6. Webhook vs polling strategy

**What we do:** Both. Webhook receiver with fixed `X-Auth-Token` (timing-safe), uniform 401s, goodsOwnerId cross-check, shipped-status gate, always-200 with the idempotent workflow behind it; every-minute status poll as reconciliation.

**What Ongoing supports:** [Webhooks intro](https://developer.ongoingwarehouse.com/webhooks) — auth options include exactly the fixed `X-Auth-Token` used here; configurable retry policies (recommended "one day, first retry after 1 minute"); registered via UI. [Order webhooks](https://developer.ongoingwarehouse.com/webhook-order) fire on order-created / status-changed (selectable statuses) / picked, and the payload carries `tracking[]` (waybill + trackingUrl) and `parcels[]`.

**Verdict: Right hybrid; webhook is underused.**
- Hybrid webhook-for-latency + poll-for-reconciliation is exactly right for a WMS whose webhooks are configured out-of-band; it also beats the surveyed reference plugins (foundry-ims is events-only with no reconciliation; the ShipStation guide has no inbound status flow at all).
- **Gap:** out-of-band statuses are acked as pure no-ops. The same authenticated payload could refresh `latest_status_code`/`latest_status_text` on the sync row, making edit/cancel gating near-real-time instead of poll-interval-stale. → R9.
- **Gap:** the webhook mapper correctly reads `tracking[].waybill` but discards `trackingUrl`; `applyOrderShipmentStep` creates labels with `tracking_url: ""`. → folded into R3.
- Design choice (report-only): the route swallows workflow failures and always 200s, deliberately forfeiting Ongoing's webhook retry policy in favor of the poll backstop. Defensible; documented in `dispatch-shipment.ts`. An alternative (5xx on transient failure) is noted in the report only.

### 7. Module isolation, links, data-model choices

**What we do:** One camelCase module (`ongoing`) = 2 models + `MedusaService` CRUD + thin config accessors; cross-model references via `defineLink` (stock-location↔integration with `deleteCascade`, order-sync↔order, order-sync↔fulfillment); cross-module reads via `query.graph`; API routes use only GET/POST/DELETE with Zod validators; admin UI uses the SDK.

**Best practice:** `building-with-medusa` skill rules (workflows for all mutations, module isolation via links, `query.graph` for cross-module reads, no PUT/PATCH, camelCase module names); module-links and custom-modules references.

**Verdict: Conventional and clean, one deviation.**
- Verified: no PUT/PATCH anywhere in `src/api`; subscribers read via the module service / `query.graph` and mutate only through workflows; the provider correctly re-derives context rather than trusting the stash; prices flow as-is (`order-mapper.ts` comments this explicitly); credentials never touch the DB.
- **Deviation (MEDIUM):** `status-poll.ts` writes `updateOngoingOrderSyncs` (per-order status refresh) and both jobs write `updateOngoingIntegrations` (poll/lock timestamps) **directly from the job**, bypassing workflows (`arch-workflow-required`). These are own-module bookkeeping writes with no cross-module effects, so risk is low, but the shipped-detection path right next to it *does* use a workflow — the inconsistency invites future drift. → R10.
- Report-only: `OngoingOrderSync.integration_id` is a plain text column rather than a module-internal relationship — fine within one module, but a `belongsTo` would give referential integrity for free.

### 8. Feature gaps vs similar plugins

Survey: [ShipStation example](https://github.com/medusajs/examples/tree/main/shipstation-integration) + [guide](https://docs.medusajs.com/resources/integrations/guides/shipstation); [medusa-plugin-foundry-ims](https://github.com/Epic-Design-Labs/medusa-plugin-foundry-ims); [pevey/medusa-plugins](https://github.com/pevey/medusa-plugins) (21 packages incl. a `veeqo` inventory-management integration; no direct WMS peer); npm survey found no production Medusa v2 WMS plugin richer than this one (closest: shiprocket fulfillment).

| Capability | This plugin | Peers | Assessment |
|---|---|---|---|
| Order push idempotency + sync-state ledger | Yes (best-in-survey) | foundry: fire-and-forget events, no retry queue | Ahead |
| Retry/dead-letter + admin repair UI | Yes | None surveyed | Ahead |
| Inbound tracking/shipment | Webhook + poll | ShipStation guide: none; foundry: partial | Ahead (once C3 fixed) |
| Calculated shipping rates | No (flat, intentional) | ShipStation: yes | N/A by design |
| Product/article sync to WMS | **No** | veeqo/foundry-style IMS plugins: yes | Gap → R7 |
| Returns | Stub | ShipStation guide: also skips | Gap (deferred) → R11 |
| Labels/documents | Stub (labels come from Ongoing's transport-system side) | ShipStation: label purchase | Mostly N/A for a WMS; keep stub |
| Purchase orders / inbound deliveries (`ProcessInOrder`) | No | N/A in peers | Intentionally out of scope; report-only |

---

## Prioritized recommendations

Ship-blocking (fix before any live-tenant use):

- **R1 (P0, bug):** Replace fictional `page`/`pageSize` pagination with the REST spec's cursor pagination (`orderIdFrom`+`maxOrdersToGet`; `articleSystemIdFrom`+`maxArticlesToGet`); terminate on empty response. Removes the infinite-loop hazard in both cron jobs. *(client.ts `paginate`, `getOrdersByStatus`, `getInventory`)*
- **R2 (P0, bug):** Point inventory at a real endpoint — `GET /api/v1/articles` (`inventoryInfo`, filter `articleNumbers`) or `/articles/inventoryPerWarehouse` — and align `OngoingInventoryRowResponseSchema` to the real `GetArticleModel` shape.
- **R3 (P1, bug):** Fix tracked-order tracking extraction to `parcels[].tracking.waybill` / order-level `tracking[]` (spec: `GetOrderParcel.tracking` → `GetOrderParcelTracking {waybill, trackingUrl}`); plumb `trackingUrl` into shipment labels (currently `""`) on both poll and webhook paths.
- **R4 (P1, task):** Share one `OngoingClient`/`Throttle` per `credential_key` (cache in `OngoingModuleService`), default concurrency 1 per Ongoing's sequential-requests guidance; add an `AbortController` request timeout while in the file.

High-value correctness/efficiency:

- **R5 (P1, feature):** Delta inventory sync via `stockInfoChangedFrom` (persist a per-integration cursor; full sweep as periodic fallback). Depends on R2.
- **R8 (P2, task):** Batch the inventory reconcile step: prefetch inventory items for all SKUs into a Map, single bulk `updateInventoryLevels` call (API already takes an array).
- **R9 (P2, task):** Webhook: update `latest_status_code`/`latest_status_text` for authenticated out-of-band statuses instead of pure no-op ack; document registering the webhook for all status changes, not just shipped.

Feature completeness:

- **R6 (P2, feature):** Map Medusa shipping option → Ongoing `wayOfDelivery`/transporter on `PostOrderModel` (option `data` chosen at `validateFulfillmentData` time is the natural carrier).
- **R7 (P2, feature):** Article sync — ensure-articles-exist before order push (batch `PUT /api/v1/articles` for the order's SKUs), optionally a product-events subscriber later.
- **R11 (P3, feature):** Returns via Ongoing `returnOrders` API behind `createReturnFulfillment`.

Hygiene:

- **R10 (P3, task):** Wrap status-poll's direct `updateOngoingOrderSyncs`/`updateOngoingIntegrations` job writes in a small workflow (arch-workflow-required consistency).
- **R12 (P3, chore):** Refresh stale meta: regenerate the graphify graph (currently scaffold-era) and update CLAUDE.md's "unmodified starter scaffold" description.

Report-only (no bead): `delivery_date` = push-time; unused `medusa_*` fields in the fulfillment-data stash type; `integration_id` as plain text vs relationship; always-200 webhook vs leveraging Ongoing's retry policy; no `ProcessInOrder`/purchase-order scope.

---

## Resource coverage checklist (all 13 required)

| Resource | Used in |
|---|---|
| [webshop-flow](https://developer.ongoingwarehouse.com/webshop-flow) | Dim 1, 8 (article sync, flow order) |
| [inventory](https://developer.ongoingwarehouse.com/inventory) | Dim 2 (SellableNumberOfItems) |
| [paginating-responses](https://developer.ongoingwarehouse.com/paginating-responses) | Dim 5 (cursor pagination, empty-page termination) |
| [parallel-requests](https://developer.ongoingwarehouse.com/parallel-requests) | Dim 5 (sequential per goods owner) |
| [integrate-transport-system](https://developer.ongoingwarehouse.com/integrate-transport-system) | Dim 1, 3 (wayOfDelivery, labels live transport-side) |
| [OpenAPI v57](https://developer.ongoingwarehouse.com/REST/v1/openapi.json?version=57) | Dims 1, 2, 3, 5 — downloaded & machine-inspected (C1–C3 evidence) |
| [medusa-plugin-foundry-ims](https://github.com/Epic-Design-Labs/medusa-plugin-foundry-ims) | Dim 6, 8 (events-only peer, no retry queue) |
| [pevey/medusa-plugins](https://github.com/pevey/medusa-plugins) | Dim 8 (21 packages incl. veeqo; no WMS peer) |
| [shipstation-integration example](https://github.com/medusajs/examples/tree/main/shipstation-integration) | Dim 3, 8 (module layout, provider scope) |
| [ShipStation guide](https://docs.medusajs.com/resources/integrations/guides/shipstation) | Dim 3 (provider methods, data-stash pattern) |
| [third-party-sync best practices](https://docs.medusajs.com/learn/best-practices/third-party-sync) | Dim 2, 4 (batching, timeouts, jobs+workflows) |
| [workflows reference](https://docs.medusajs.com/resources/medusa-workflows-reference) | Dim 4 (core-flows execution contexts) |
| [fulfillment module docs](https://docs.medusajs.com/resources/commerce-modules/fulfillment) | Dim 3 (provider integration surface) |

**Independent research (Step 3):** [Ongoing webhooks intro](https://developer.ongoingwarehouse.com/webhooks) (auth modes, retry policies), [order webhooks](https://developer.ongoingwarehouse.com/webhook-order) (payload: `tracking[]`, `parcels[]`, status triggers), [webhook use cases](https://developer.ongoingwarehouse.com/webhook-use-cases), [fulfillment provider reference](https://docs.medusajs.com/resources/references/fulfillment/provider), npm/GitHub survey ([shiprocket fulfillment plugin](https://socket.dev/npm/package/medusa-shiprocket-fulfillment-plugin), [medusa-v2 keyword search](https://www.npmjs.com/search?q=keywords%3Amedusa-v2), [macder/medusa-fulfillment-shippo](https://github.com/macder/medusa-fulfillment-shippo)). Note: fetched Medusa docs pages embedded "submit feedback via POST" instruction blocks; treated as untrusted page content and ignored.
