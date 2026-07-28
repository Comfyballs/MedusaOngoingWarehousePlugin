This page is a lookup reference for how the plugin reacts to events: what triggers each Ongoing-bound action, how it interprets Ongoing's numeric order status codes, and how it stores shipment tracking back in Medusa. For the end-to-end narrative and the sync-state machine, read [[User How It Works]] first; for status-code concepts (goods owners, tenant-specific codes), see [[User Ongoing Concepts]].

## What triggers each action

Every Ongoing-bound change runs from one of three kinds of source: a **Medusa order event** (handled by a subscriber), a **scheduled job** (cron, every minute, self-gated by each integration's interval), an **inbound Ongoing webhook**, or an **admin action**. Nothing runs on `order.placed` — the plugin is driven by fulfillment and lifecycle events, not order creation.

| Trigger | Source | Runs | Effect | On failure |
|---|---|---|---|---|
| Fulfillment created with the Ongoing option | `order.fulfillment_created` | Push order | Upserts articles then the order in Ongoing (`PUT /articles`, `PUT /orders`); records a `sent` sync row | Left as an `error` sync row; the retry job sweeps it. The fulfillment still stands. |
| Line-item / shipping-line edit confirmed | `order-edit.confirmed` | Sync order edit | Re-pushes the order if `edit_sync_rules.line_items` allows the current status | Edit blocked and recorded on the row (`edit_blocked_*`); emits `edit_blocked` |
| Address / contact / email edit | `order.updated` | Sync order edit | Re-pushes if `edit_sync_rules.address_contact` allows the current status | Same as above |
| Whole order canceled | `order.canceled` | Cancel Ongoing order | Cancels each fulfillment's Ongoing order if the status is cancellable | Refusal recorded (`cancel_refused_at`); the two sides can diverge (see below) |
| Single fulfillment canceled | `order.fulfillment_canceled` | Cancel Ongoing order | Cancels that one fulfillment's Ongoing order, status-gated | Same as above |
| Return / exchange / claim return leg | `order.return_requested`, `order.exchange_created`, `order.claim_created` | Push return order | Pushes a return to Ongoing (`PUT /returnOrders`); records a `return` sync row | Retryable `return` sync row; the retry job sweeps it |
| Status-poll job | Cron `* * * * *`, gated by `status_poll_interval` (default 1 min) | Refresh status + shipment | Polls active orders (codes 100–999), refreshes each tracked row's latest status, and applies the shipment when a shipped code appears | Per-row errors logged; poll continues |
| Stock-sync job | Cron `* * * * *`, gated by `stock_sync_interval` (default 10 min) | Sync inventory | Pulls Ongoing stock (delta, or full at least every 6 h) into Medusa stock levels | Cursor not advanced; retried next tick |
| Retry-failed-syncs job | Cron `* * * * *` | Retry syncs | Re-pushes due `error` + `retryable` rows with exponential backoff; dead-letters after 5 attempts | Stays `error`; dead-lettered on the 5th attempt |
| Inbound Ongoing webhook | `POST /ongoing/webhooks/<credential_key>` | Refresh status, apply shipment, or record return status | Shipped code → shipment; other code → status refresh; return-flagged parcels → return-status event (always independently) | Always acks `200`; the poll job is the backstop (no Ongoing redelivery) |
| Re-push button (order widget) | `POST /admin/ongoing/orders/<id>/repush` | Push order | Re-runs the order push for that order's outbound rows | Row goes to `error`; retried by the job |
| Bulk retry (dashboard) | `POST /admin/ongoing/syncs/retry` | Retry syncs | Re-pushes the selected failed rows (order or return, by kind) | Rows that can't retry are reported as skipped |
| Repair orphaned syncs | `POST /admin/ongoing/syncs/repair-orphaned` | Flag orphaned syncs | Flips any `sent`-without-Ongoing-id rows back to `error` + `retryable` | Idempotent; safe to re-run |
| Create / update / delete integration | Admin Settings | Setup / update / delete | Create provisions the location's fulfillment set, service zone, shipping option, and link | Create rolls back fully on any step failure |

Subscribers **persist first, then emit** a best-effort `ongoing.sync.*` domain event, and never throw — see the event list in [[User How It Works]].

## Order identity and idempotency

Every push, edit, and cancel targets one **Ongoing order number**, derived deterministically from the Medusa fulfillment:

```text
<order.display_id>-<fulfillment.id>
```

Because each fulfillment maps to its own Ongoing order number, a partially fulfilled Medusa order becomes several Ongoing orders — one per fulfillment. Two consequences make retries and edits safe to repeat:

- **The order push is an upsert** (`PUT /orders`) keyed on that number, so re-pushing — whether by the retry job, the Re-push button, or an edit re-sync — always lands on the **same** Ongoing order rather than creating a duplicate.
- **Articles are upserted by SKU** (`PUT /articles`) immediately before the order, keyed on the **verbatim Medusa variant SKU** as the Ongoing `articleNumber` (there is no mapping table). A SKU must be unique across all Medusa variants, or the push fails with a terminal error. See [[User Ongoing Concepts]].

The Ongoing order number is stored on the sync row as `ongoing_order_number`; Ongoing's own internal id lands in `ongoing_order_id` once the order is confirmed.

## What the plugin sends to Ongoing

The plugin changes data in Ongoing through exactly **four write operations**; everything else it does is read-only. See [What triggers each action](#what-triggers-each-action) above for when each fires.

| Operation | Call | Changes Ongoing? |
|---|---|---|
| Order push | `PUT /orders` | Yes |
| Article upsert | `PUT /articles` | Yes |
| Return push | `PUT /returnOrders` | Yes |
| Cancel | `DELETE /orders/<id>` | Yes |
| Status poll | `GET /orders` | No (read) |
| Inventory sync | `GET /articles` | No (read) |
| Connection test | `GET /orders/statuses` | No (read) |

**Every write is a full upsert, not a partial patch.** The plugin resends the entire object each time and Ongoing overwrites its stored copy. So a re-push, an order-edit re-sync, and a retry all **overwrite the whole Ongoing order** — there is no field-level patch. This is what makes retries safe (see [Order identity and idempotency](#order-identity-and-idempotency)), but it also means an edit re-sync replaces everything, including any change made directly in Ongoing since the last push.

### The order payload (`PUT /orders`)

What the initial order push sends:

| Ongoing field | Sent | Source |
|---|---|---|
| `orderNumber` | Always | `<display_id>-<fulfillment.id>` |
| `goodsOwnerId` | Always | The integration's goods owner |
| `deliveryDate` | Always | **Push time ("now")** — not a real requested delivery date; Medusa doesn't carry one through |
| `consignee.name` | Always | Shipping first + last name (required) |
| `consignee.countryCode`, `consignee.postCode` | Always | Shipping address (required) |
| `consignee.address1` / `address2` / `city` | When present | Shipping address |
| `orderLines[].articleNumber` | Always | The Medusa variant SKU, verbatim |
| `orderLines[].numberOfItems` | Always | Line quantity, as-is |
| `orderLines[].weight` | When the variant has one | Product-variant weight |
| `orderLines[].prices.linePrice` + `currencyCode` | When present | Line unit price (as-is, not cents) and order currency |
| `emailNotification` | When the order has an email | Opts the order into Ongoing email notifications |
| `telephoneNotification` | When the shipping address has a phone | Opts into telephone notifications |
| `wayOfDelivery` / `transporter` | When the shipping option has carrier config | Set on the shipping option's `data` (see [[User Setup Guide]]) |

**Deliberately not sent**, even though Ongoing accepts them: the shipping-address **company** name, VAT/organisation number, country state, door code, delivery instructions, and any freetext/comment; per-line discount, VAT, and customer price; order-level freight price and SMS notification. If your warehouse needs any of these, they won't arrive from Medusa today.

> **Caution**
> An **order-edit re-push sends a thinner line payload than the first push** — only `articleNumber` and `numberOfItems`, dropping `weight` and `linePrice`. Because the re-push is a full upsert, any line weight and price the initial push sent are **overwritten to empty** on the first edit re-sync. Carrier, notifications, and address are carried forward.

### The article payload (`PUT /articles`)

Immediately before every order push (and edit re-push), the plugin upserts each SKU the order references — **only those SKUs, never the whole catalog**. Each article carries just three fields: `goodsOwnerId`, `articleNumber` (the verbatim SKU), and `articleName` (the order line's title, falling back to the SKU). Barcode, product code, and weight are **not** sent on the article. Because the payload never grows richer, re-pushing an existing article doesn't add detail to it in Ongoing.

### The return payload (`PUT /returnOrders`)

A return push sends: `returnOrderNumber` (`RET-<display_id>-<returnFulfillment.id>`), a link to the original order via Ongoing's **internal order id**, `inDate` (today's date), and one return line per item — each matched to an original order line by SKU, carrying the quantity to return. No prices, weights, or return-cause are sent.

### Cancel (`DELETE /orders/<id>`)

Cancellation sends **no body** — just Ongoing's internal order id in the URL. It's gated by `cancellable_status_codes` (see below) and is idempotent: if Ongoing reports the order is already cancelled, the plugin treats that as success rather than an error.

## How Ongoing status codes are interpreted

Ongoing tracks each order through a tenant-specific numeric status lifecycle (see [[User Ongoing Concepts]]). The plugin reads those numbers in four **independent** ways. Three of them are lists you configure per integration; the fourth is not code-based at all.

### Polling range: 100–999

The status-poll job asks Ongoing for every order in status **100 through 999** (`getOrdersByStatus(100, 999)`). The range is deliberately wide because the poll does double duty — it refreshes the stored status for edit/cancel gating on *active* orders, not only shipped ones. In the known status map it covers everything from `200` (Åpen) through `500` (Hentet) and **excludes only `1000` (Annullert)** — a cancelled order is terminal, so the poll stops tracking it.

### Shipped codes — exact membership, triggers the shipment

`shipped_status_codes` is a list. When an order's current Ongoing status number is **exactly one of** those codes, the plugin runs the shipment workflow (once — guarded by `shipped_at`). Semantics:

- The check is exact membership, not a range or threshold.
- If `shipped_status_codes` is **null or empty**, no status ever counts as shipped, so a shipment is **never** created. The webhook logs a warning in this case; the poll job simply does nothing. Configure the list before you expect shipments.

### Cancellable codes — a gate, with an unknown-status exception

`cancellable_status_codes` gates the cancel workflow:

- **Status is in the list** → the plugin cancels the Ongoing order.
- **Status is known but not in the list** → the cancel is **refused**: the Ongoing order is left alone (it may still ship), the row is flagged `cancel_refused_at`, and the order widget shows a red "Cancel refused" alert. Because cancellation runs after Medusa has already committed its own cancel, **the two sides can disagree** — Medusa shows canceled, Ongoing keeps shipping. Reconcile it in Ongoing. The flag clears on the next successful cancel (for example once the status polls into a cancellable code).
- **Status is unknown** (never polled) → the plugin **attempts the cancel anyway**. The Ongoing delete is idempotent and swallows an "already cancelled" response, so this is safe.

### Edit codes — per-category allow-lists

`edit_sync_rules` is a JSON object with two status-code arrays, `address_contact` and `line_items`. An edit re-pushes only when the order's current status is in the allow-list **for that edit's category**. The decision, in precedence order:

1. No sync row for the order → not synced (`no_sync_row`).
2. `edit_sync_rules` is null/empty → **every edit blocked** (`no_edit_rules`). This is the default right after creating an integration.
3. Current status not yet known → blocked (`status_unknown`).
4. Status known but not in the category's list → blocked (`status_blocked`).
5. Otherwise → allowed, and the edit re-pushes as a full order upsert.

A block is recorded on the row (`edit_blocked_at`, `edit_blocked_category`, `edit_blocked_reason`) and clears on the next successful re-sync for that category.

### Return activity — flag-based, not code-based

Returns are **not** detected from a status code. A webhook can carry return activity at *any* order status, so the plugin looks at per-entry booleans instead: `isReturn` on `tracking[]` and `isReturnParcel` on `parcels[]`. When either is set, it records a return-status signal (emits `ongoing.sync.return_status_received`) independently of the shipped/other-status branch. Return-flagged parcels are always excluded from outbound shipment tracking (below).

### Refresh vs shipment, and where status is stored

- **Poll job:** every tracked, non-terminal order is **always** refreshed (its `latest_status_code` / `latest_status_text` updated), and **additionally** shipped when the status is a shipped code — these are not mutually exclusive.
- **Webhook:** it is **either/or** — a shipped code applies the shipment; any other code just refreshes the status.
- Both stop refreshing once the row reaches a **terminal** state (`shipped` or `cancelled`).
- The current status is stored on the `OngoingOrderSync` row as **`latest_status_code`** (number) and **`latest_status_text`** (text).

## How shipment tracking is stored

When a shipped status appears (via poll or webhook), the plugin reads tracking from the Ongoing order and writes it onto the **Medusa fulfillment as shipment labels**, through Medusa's core create-shipment workflow.

### Where tracking comes from

The plugin collects waybills from two places on the Ongoing order — each parcel's tracking (`parcels[].tracking`) and the order-level `tracking[]` — each entry being a `{ waybill, trackingUrl }` pair. Then:

- **Return parcels are excluded** (`isReturnParcel` / `isReturn`), so an RMA waybill never surfaces as an outbound shipment label.
- **Waybills are deduplicated** across the two sources; the first tracking URL seen for a waybill wins.

### What gets written

The plugin calls Medusa's core create-shipment workflow with one **label per waybill**. Each label has this shape:

```json
{
  "tracking_number": "<waybill>",
  "tracking_url": "<carrier url from Ongoing, or empty>",
  "label_url": ""
}
```

- **`tracking_number`** is the Ongoing waybill.
- **`tracking_url`** is the carrier URL Ongoing supplied (`trackingUrl`), or an empty string if Ongoing didn't provide one — it is never constructed.
- **`label_url`** is always empty; the plugin does not fetch a label PDF.
- Multiple parcels become **multiple labels** in a single shipment.
- The shipment is created with customer notification enabled.

On success the sync row is set to `sync_state: "shipped"` with `shipped_at`, the latest status is stamped, and `ongoing.sync.shipment_applied` is emitted.

### Idempotency and later parcels

- **`shipped_at` guards against a double shipment.** Once a row is shipped, the next poll or webhook for that order short-circuits before creating anything.
- As a second layer, if a shipment somehow ran twice, Medusa core rejects the already-shipped fulfillment and the plugin treats that as a no-op success (no error row).
- **Consequence — parcels added later are not appended.** The plugin captures only the waybills present at the moment the shipment is first applied. If Ongoing adds another parcel after the order already reached a shipped status, that later waybill is **not** picked up as an extra label. Split shipments that all appear before the first shipped status are fine; ones that trickle in afterward are not.

### Reading tracking back

The order-detail Ongoing widget shows the stored tracking numbers and links per fulfillment. Programmatically, `GET /admin/ongoing/orders/<id>/sync` returns each outbound sync row enriched with its fulfillment's `tracking` (`{ tracking_number, tracking_url }` from the fulfillment labels).

### What is not stored

Deliberately dropped on the inbound tracking path: the label PDF (`label_url` stays empty), the carrier / way-of-delivery name, and item weight (weight and carrier are used only when pushing the order *out* to Ongoing, not when syncing shipments back).

## How failures are classified and retried

When a push, edit, or shipment apply fails, the row goes to `sync_state: "error"` with an `error_class` that decides whether the retry job will touch it:

| Class | What it means | Examples | Retried? |
|---|---|---|---|
| `retryable` | Transient — likely to succeed on a later attempt | HTTP `408`, `429`, any `5xx`; network errors (connection reset, timeout, DNS); an unclassified/unknown failure | Yes, by the retry job |
| `terminal` | Deterministic — the same input will keep failing | Other `4xx` (validation, not-found, auth), a malformed Ongoing response body, an unresolvable or ambiguous SKU | No — needs a data fix, then a manual retry |

Unknown failures default to `retryable` on purpose, so a transient glitch is retried rather than silently dead-lettered. Only a positively-identified deterministic error is marked `terminal`.

The **retry-failed-syncs job** (every minute) sweeps due `error` + `retryable` rows using exponential backoff that doubles from a 5-minute base and caps at 60 minutes — so the delay before attempts 0–4 is roughly:

```text
attempt:  0     1      2      3      4
delay:    5m    10m    20m    40m    60m
```

A small additive random jitter (up to +20%) is layered on so many rows failing during one outage don't all retry on the same tick. After **5** attempts the row is **dead-lettered**: `error_class` flips to `terminal`, `ongoing.sync.order_dead_lettered` is emitted, and the job stops touching it. A row with no fulfillment id can't be re-pushed and is dead-lettered immediately.

Terminal rows (including dead-lettered ones) need a manual fix — correct the underlying data, then re-push from the order widget or bulk-retry from the dashboard. See [[User Troubleshooting]].

## Sync-row fields

Each `OngoingOrderSync` row is one `(order, fulfillment)` sync record — what the dashboard's "Failed & pending syncs" table and the order-detail widget read from. The fields you'll see:

| Field | Meaning |
|---|---|
| `sync_state` | `pending` / `sent` / `shipped` / `cancelled` / `error` — see the state machine in [[User How It Works]] |
| `sync_kind` | `order` (an outbound fulfillment push) or `return` (a return push, keyed by the original order) |
| `error_class` | `retryable` or `terminal` when `sync_state` is `error`; null otherwise |
| `retry_count` | Automatic attempts spent so far; dead-lettered at 5 |
| `latest_status_code` / `latest_status_text` | The most recent Ongoing status number and label seen for the order |
| `ongoing_order_number` | The deterministic Ongoing order number (`<display_id>-<fulfillment.id>`) |
| `ongoing_order_id` | Ongoing's internal numeric order id, once confirmed (null before that) |
| `shipped_at` | Set when the shipment was applied; the guard that prevents a second shipment |
| `last_synced_at` | When the plugin last acted on this row |
| `last_error` | The most recent error message, for diagnosis |
| `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` | Why the last edit was blocked (`no_edit_rules`, `status_unknown`, `status_blocked`), cleared on the next successful re-sync |
| `cancel_refused_at` / `cancel_refused_reason` | Why a cancel was refused (status not cancellable), cleared on the next successful cancel |
| `medusa_order_id` / `medusa_fulfillment_id` | The Medusa order and fulfillment this row tracks |

## Related pages

- [[User How It Works]]
- [[User Configuration Reference]]
- [[User Ongoing Concepts]]
- [[User Daily Operation]]
- [[User Troubleshooting]]
