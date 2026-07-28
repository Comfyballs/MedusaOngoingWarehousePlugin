This page explains what the integration does automatically end-to-end — order push, shipment and tracking, inventory sync, order edits, cancellation, retries and orphan repair — and the sync-state machine that ties it together. Read it to understand the moving parts before operating the plugin day to day (see [[User Daily Operation]]) or debugging it (see [[User Troubleshooting]]). For a quick lookup — a trigger-to-action map, exactly how status codes are interpreted, and the tracking-label shape — see [[User Sync Reference]].

## Order push — triggered by fulfillment, not order placement

The plugin pushes an order to Ongoing when a **Medusa fulfillment is created** using the Ongoing shipping option — not on `order.placed`. This matches Medusa's fulfillment-provider model and supports partial fulfillment (each fulfillment becomes its own Ongoing order).

The push runs **asynchronously**, just after the fulfillment is created: Medusa emits `order.fulfillment_created`, and the plugin's subscriber pushes from there. A failure therefore **does not** abort the fulfillment — the fulfillment stands, the attempt is recorded as an `error` sync row, and the retry job picks it up (see [Retries and orphan repair](#retries-and-orphan-repair)). The push:

1. Re-queries the fulfillment, order, and items fresh.
2. Resolves the integration bound to the fulfillment's stock location.
3. Resolves each line's Medusa SKU to an Ongoing `articleNumber` (the SKU verbatim; it must be unique).
4. Upserts each referenced article in Ongoing (`PUT /articles`) before the order.
5. Builds a deterministic order number, `<order.display_id>-<fulfillment.id>`, and upserts the order (`PUT /orders`). Because it is an upsert keyed on that number, re-pushing is safe and lands on the same Ongoing order.
6. Records an `OngoingOrderSync` row (`pending` → `sent` or `error`). That row — keyed by fulfillment id — is where the Ongoing order number and id live; the Medusa fulfillment itself only carries the identifiers the push needs (`location_id`, `medusa_fulfillment_id`).

The delivery date sent to Ongoing is the **push time**, not a real requested delivery date. The initial push sends each line's article number, quantity, and — when available — the variant weight and unit price; the recipient address, email/phone notifications, and carrier config also go across. An order-*edit* re-push sends a thinner line payload (article number and quantity only). For the exact field-by-field payload and what is deliberately omitted, see [[User Sync Reference]].

## Shipment and tracking back

Once the order push succeeds, two channels keep Medusa's view of the Ongoing order current:

- **Status-poll job** (every minute; effective cadence controlled by `status_poll_interval`).
- **Webhook** (if you configured one on the Ongoing side).

Both write the latest status code and text onto the sync row. When the status reaches a **shipped** code (the integration's **`shipped_status_codes`**, or the canonical defaults 425/450/451 when you haven't set any), both channels converge on the same idempotent shipment workflow, which creates the Medusa shipment and attaches tracking-number labels (with carrier tracking URLs when Ongoing supplied them), then marks the sync row `shipped`. The `shipped_at` timestamp guards against creating the shipment twice.

For **pickup orders**, the lifecycle continues after shipment: when the status reaches a **delivered** code (**`delivered_status_codes`**, or the canonical default 500 "picked up"), the plugin records the collection — the sync row moves to `delivered` (stamped with `delivered_at`) and a `ongoing.sync.order_delivered` event fires. The plugin keeps watching an order after it ships precisely so this `450 → 500` pickup step is captured rather than dropped. See [[User Sync Reference]] for the code→stage table.

## Inventory sync — Ongoing to Medusa

The **stock-sync job** runs every minute and, for each enabled integration whose interval has elapsed, pulls inventory from Ongoing and writes Medusa stock levels. Ongoing is the source of truth for on-hand stock.

- It normally does a **delta sweep** (`GET /articles?stockInfoChangedFrom=<cursor>`) using a persisted cursor, so it only fetches articles whose stock changed.
- It does a **full sweep** when there is no cursor yet, at least every **6 hours** as a reconciliation fallback that self-heals any missed deltas (a dropped webhook, clock skew), and also if the stored cursor has aged past a **23-hour** safety margin — Ongoing rejects `stockInfoChangedFrom` values older than 24 hours, so a stale cursor degrades to a full sweep instead of erroring.
- The delta cursor is rewound by a 2-minute overlap buffer to absorb clock skew, and only advances on a successful sync.
- How Ongoing quantities become Medusa `stocked_quantity` depends on the integration's `stock_reconcile_mode`. See [[User Configuration Reference]].

## Order edits

Two Medusa events drive edit syncing, each gated by its own category in the integration's `edit_sync_rules`:

- **Address, contact, or email edits** (`order.updated`) → gated by `edit_sync_rules.address_contact`.
- **Line-item and shipping-line edits** (`order-edit.confirmed`) → gated by `edit_sync_rules.line_items`.

An edit re-pushes to Ongoing (a full upsert on the same order number) only when the order's current Ongoing status code is in the allow-list for that category. Otherwise the edit is **blocked**, and the plugin records why on the sync row (`edit_blocked_at`, `edit_blocked_category`, `edit_blocked_reason`). A block also emits an `ongoing.sync.edit_blocked` event you can alert on.

> **Warning**
> Edits are blocked by default. If `edit_sync_rules` is null or empty — the state right after you create an integration — every edit is blocked with reason `no_edit_rules`. Configure `edit_sync_rules` to allow edit syncing. See [[User Troubleshooting]] to clear a blocked edit.

A block clears automatically on the next successful re-sync for that category — there is no manual "dismiss" button.

## Cancellation

When an order is canceled in Medusa (`order.canceled`), or a single fulfillment is canceled (`order.fulfillment_canceled`), the plugin runs an idempotent cancel workflow **gated by `cancellable_status_codes`**:

- If Ongoing's current status for the order is **not** in `cancellable_status_codes`, the plugin does **not** cancel the Ongoing order — Ongoing keeps shipping it. Medusa still marks its own fulfillment canceled, so **the two sides can disagree here**. Cancellation runs asynchronously, after Medusa has already committed the cancel, so the plugin can no longer veto it (see [[Dev Architecture]]). Instead it records the refusal on the sync row (`cancel_refused_at`), and the **order-detail Ongoing widget shows a red "Cancel refused" alert** naming the blocking status. **Reconciliation step:** open the order in Ongoing and cancel (or let ship) it there to match Medusa. The flag clears automatically on the next successful cancel — e.g. once the Ongoing status polls into a cancellable code and a re-cancel runs.
- If the status is **unknown** (never polled), the workflow attempts the cancel anyway (the delete is idempotent and swallows an "already cancelled" response).

## Retries and orphan repair

A failed push lands the sync row in `error` with an `error_class`:

- **`retryable`** — transient (a 5xx, a 429, a network error, or an unclassified default). The retry job picks it up.
- **`terminal`** — deterministic (a validation error, an unresolvable SKU, a 4xx). The retry job ignores it; it needs a data fix and a manual retry.

The **retry-failed-syncs job** runs every minute and sweeps `error` + `retryable` rows that are due, using exponential backoff of roughly **5, 10, 20, 40, 60 minutes** across attempts 0–4 (each with a small random jitter so many rows failing during one outage don't all retry at the same instant). After 5 failed attempts the row is **dead-lettered** (`error_class` flips to `terminal`, emits `ongoing.sync.order_dead_lettered`) and the job stops touching it.

**Orphan repair** is a safety net for a fixed historical bug where a row could be stuck `sent` with no Ongoing order id. Running `POST /admin/ongoing/syncs/repair-orphaned` flips any such rows back to `error` + `retryable` so the normal retry job repairs them. It is idempotent and safe to run repeatedly. New installs should never need it. See [[User Troubleshooting]].

## The three scheduled jobs

All three are registered on the cron schedule `* * * * *` — Medusa evaluates them every minute, and each job internally checks whether each integration's own interval has elapsed. So the real cadence is set by the integration's intervals, not the cron line.

| Job | Runs | What it does |
|---|---|---|
| `ongoing-stock-sync` | Every minute, gated by `stock_sync_interval` (default 10 min) | Pulls inventory from Ongoing (delta, or full every 6 hours) and writes Medusa stock levels. |
| `ongoing-status-poll` | Every minute, gated by `status_poll_interval` (default 1 min) | Polls Ongoing order status (codes 100–999), updates tracked sync rows, and triggers shipment sync when a shipped status appears. |
| `ongoing-retry-failed-syncs` | Every minute | Sweeps due `error` + `retryable` rows with exponential backoff; dead-letters after 5 attempts. |

## Sync states and the state machine

Each `OngoingOrderSync` row moves through these states:

- **`pending`** — row created, the order PUT not yet confirmed. Transitional; should not persist long.
- **`sent`** — order pushed successfully, awaiting shipment.
- **`shipped`** — a shipped status code was observed; the Medusa shipment and tracking were created. Success. **Not terminal for pickup orders** — the plugin keeps watching for the pickup collection.
- **`delivered`** — a pickup order was collected at the pickup point (a delivered status code, canonical 500). Terminal, success.
- **`cancelled`** — the order was canceled in Medusa and (if it existed) Ongoing. Terminal.
- **`error`** — the last push or edit failed. Carries an `error_class` of `retryable` or `terminal`.

Transitions:

- `pending` → `sent` on a successful order PUT.
- `pending` or `sent` → `error` on a failure.
- `error` → `sent` via automatic retry, or a manual retry / re-push.
- `error` (`retryable`, 5 attempts reached) → `error` (`terminal`) — dead-lettered.
- `sent` → `shipped` when a shipped status arrives.
- `shipped` → `delivered` when a pickup order is collected (450 → 500).
- any non-delivered state → `cancelled` on cancellation.

## Webhook behavior

The webhook route always returns `200` after authentication, even if the internal workflow fails. This deliberately forfeits Ongoing's retry policy in favor of the every-minute poll job as the backstop. The practical implication: if a webhook did not seem to update anything, do not expect Ongoing to redeliver — check application logs. See [[User Troubleshooting]].

## Domain events for custom alerting

The plugin emits best-effort `ongoing.sync.*` events you can subscribe to in your own app: `order_pushed`, `push_failed`, `shipment_applied`, `order_delivered`, `order_cancelled`, `order_retried`, `order_dead_lettered`, `inventory_synced`, `edit_blocked`, `return_order_pushed`, `return_order_push_failed`, and `return_status_received`. They are observability signals — the plugin itself does not consume them. Subscribing to `order_dead_lettered` or `edit_blocked` is a good basis for ops alerting, and `return_status_received` is the current hook for return activity (the plugin logs and emits it but does not auto-mutate the Medusa return — see [[User Sync Reference]]).

## Related pages

- [[User Sync Reference]]
- [[User Daily Operation]]
- [[User Configuration Reference]]
- [[User Troubleshooting]]
- [[User Ongoing Concepts]]
