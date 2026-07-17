This page explains what the integration does automatically end-to-end — order push, shipment and tracking, inventory sync, order edits, cancellation, retries and orphan repair — and the sync-state machine that ties it together. Read it to understand the moving parts before operating the plugin day to day (see [[User Daily Operation]]) or debugging it (see [[User Troubleshooting]]).

## Order push — triggered by fulfillment, not order placement

The plugin pushes an order to Ongoing when a **Medusa fulfillment is created** using the Ongoing shipping option — not on `order.placed`. This matches Medusa's fulfillment-provider model and supports partial fulfillment (each fulfillment becomes its own Ongoing order).

The push runs **synchronously** inside fulfillment creation, so a failure aborts the fulfillment (Medusa deletes the just-created fulfillment on a thrown error). The push:

1. Re-queries the fulfillment, order, and items fresh.
2. Resolves the integration bound to the fulfillment's stock location.
3. Resolves each line's Medusa SKU to an Ongoing `articleNumber` (the SKU verbatim; it must be unique).
4. Upserts each referenced article in Ongoing (`PUT /articles`) before the order.
5. Builds a deterministic order number, `<order.display_id>-<fulfillment.id>`, and upserts the order (`PUT /orders`). Because it is an upsert keyed on that number, re-pushing is safe and lands on the same Ongoing order.
6. Records an `OngoingOrderSync` row (`pending` → `sent` or `error`) and stashes the Ongoing order number and id onto the Medusa fulfillment.

The delivery date sent to Ongoing is the **push time**. Order lines currently carry only article number and quantity — weight and unit price are not sent even though the underlying mapper supports them.

## Shipment and tracking back

Once the order push succeeds, two channels keep Medusa's view of the Ongoing order current:

- **Status-poll job** (every minute; effective cadence controlled by `status_poll_interval`).
- **Webhook** (if you configured one on the Ongoing side).

Both write the latest status code and text onto the sync row. When the status reaches a value in the integration's **`shipped_status_codes`**, both channels converge on the same idempotent shipment workflow, which creates the Medusa shipment and attaches tracking-number labels (with carrier tracking URLs when Ongoing supplied them), then marks the sync row `shipped`. The `shipped_at` timestamp guards against creating the shipment twice.

## Inventory sync — Ongoing to Medusa

The **stock-sync job** runs every minute and, for each enabled integration whose interval has elapsed, pulls inventory from Ongoing and writes Medusa stock levels. Ongoing is the source of truth for on-hand stock.

- It normally does a **delta sweep** (`GET /articles?stockInfoChangedFrom=<cursor>`) using a persisted cursor, so it only fetches articles whose stock changed.
- It does a **full sweep** when there is no cursor yet, and at least every **6 hours** as a reconciliation fallback that self-heals any missed deltas (a dropped webhook, clock skew).
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

When an order is canceled in Medusa (`order.canceled`), or the fulfillment is canceled through the provider, the plugin runs an idempotent cancel workflow **gated by `cancellable_status_codes`**:

- If Ongoing's current status for the order is **not** in `cancellable_status_codes`, the provider throws, and Medusa does **not** mark the fulfillment canceled — this keeps Medusa and Ongoing from disagreeing while Ongoing keeps shipping.
- If the status is **unknown** (never polled), the workflow attempts the cancel anyway (the delete is idempotent and swallows an "already cancelled" response).

## Retries and orphan repair

A failed push lands the sync row in `error` with an `error_class`:

- **`retryable`** — transient (a 5xx, a 429, a network error, or an unclassified default). The retry job picks it up.
- **`terminal`** — deterministic (a validation error, an unresolvable SKU, a 4xx). The retry job ignores it; it needs a data fix and a manual retry.

The **retry-failed-syncs job** runs every minute and sweeps `error` + `retryable` rows that are due, using exponential backoff of **5, 10, 20, 40, 60 minutes** across attempts 0–4. After 5 failed attempts the row is **dead-lettered** (`error_class` flips to `terminal`, emits `ongoing.sync.order_dead_lettered`) and the job stops touching it.

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
- **`shipped`** — a shipped status code was observed; the Medusa shipment and tracking were created. Terminal, success.
- **`cancelled`** — the order was canceled in Medusa and (if it existed) Ongoing. Terminal.
- **`error`** — the last push or edit failed. Carries an `error_class` of `retryable` or `terminal`.

Transitions:

- `pending` → `sent` on a successful order PUT.
- `pending` or `sent` → `error` on a failure.
- `error` → `sent` via automatic retry, or a manual retry / re-push.
- `error` (`retryable`, 5 attempts reached) → `error` (`terminal`) — dead-lettered.
- `sent` → `shipped` when a shipped status arrives.
- any non-shipped state → `cancelled` on cancellation.

## Webhook behavior

The webhook route always returns `200` after authentication, even if the internal workflow fails. This deliberately forfeits Ongoing's retry policy in favor of the every-minute poll job as the backstop. The practical implication: if a webhook did not seem to update anything, do not expect Ongoing to redeliver — check application logs. See [[User Troubleshooting]].

## Domain events for custom alerting

The plugin emits best-effort `ongoing.sync.*` events you can subscribe to in your own app: `order_pushed`, `push_failed`, `shipment_applied`, `order_cancelled`, `order_retried`, `order_dead_lettered`, `inventory_synced`, and `edit_blocked`. They are observability signals — the plugin itself does not consume them. Subscribing to `order_dead_lettered` or `edit_blocked` is a good basis for ops alerting.

## Related pages

- [[User Daily Operation]]
- [[User Configuration Reference]]
- [[User Troubleshooting]]
- [[User Ongoing Concepts]]
