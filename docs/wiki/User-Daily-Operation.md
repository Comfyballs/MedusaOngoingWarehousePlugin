This page covers day-to-day operation: the Ongoing WMS dashboard, the per-order sync widget, and the two ways to retry a failed sync. For the mechanics behind these surfaces, see [[User How It Works]].

## The Ongoing WMS dashboard

The admin sidebar has a top-level **Ongoing WMS** item. It has three parts.

### Connection health panel

One row per configured integration, with a badge:

- **healthy** — recently polled and enabled.
- **stale** — never polled, or the last poll is older than twice the status-poll interval.
- **disabled** — the integration's `enabled` flag is off.

> **Note**
> This badge is derived from stored timestamps, not a live call. It can read "healthy" even if credentials just went bad, as long as the last successful poll was recent. To actually test credentials, use **Test connection** in Settings (see [[User Verification]]).

### Sync-state summary strip

Counts of every sync state across all rows — `error`, `pending`, `sent`, `shipped`, `cancelled` — shown error-first. Use it for an at-a-glance health read.

### Failed and pending syncs table

A paginated table (20 per page) of rows in `error`, `sent`, or `pending` state. Settled rows (`shipped`, `cancelled`) are intentionally excluded. Columns include the Ongoing order number, Medusa order id, sync-state badge, error-class badge (retryable or terminal), retry count, the last error (truncated, full text on hover), and last-synced time.

## The order-detail sync widget

On a Medusa order's detail page, the **Ongoing Warehouse** widget appears in the side panel — but only if the order has at least one Ongoing sync row. An order never fulfilled through Ongoing shows nothing.

Per sync row it shows:

- The Ongoing order number and a colored state badge (pending = grey, sent = blue, shipped = green, cancelled = grey, error = red).
- The latest Ongoing status text and code, and the last-synced time.
- An orange **Edit blocked** callout when an edit was blocked, with a human-readable reason.
- Tracking numbers (linked when a tracking URL was captured).
- The last error message.
- A **Re-push** or **Retry** button.

## Retrying a failed sync — two mechanisms

The plugin gives you two retry paths, and they behave differently. Knowing which is which avoids confusion.

### Order widget — immediate

The **Re-push / Retry** button on the order widget runs the push **synchronously and immediately**. The label is "Retry" when the row is in `error`, otherwise "Re-push". It is disabled when there is no fulfillment id, or the row is already `shipped` or `cancelled`.

Use this when you have fixed the underlying problem for one order and want to push it right now.

### Dashboard bulk Retry — queued, not instant

On the dashboard table, select rows (only `error` + `retryable` rows are selectable) and use the **Retry** command-bar action. This does **not** re-push immediately. It resets each row's last-synced time to null, which makes the row due on the next retry-job tick — so it effectively retries within about a minute, not instantly.

> **Note**
> After a bulk Retry the toast says how many were queued. If you refresh immediately and see no change, that is expected — the re-push happens on the next retry sweep, up to about a minute later.

The toast also reports how many rows were skipped (a row not found, or no longer in `error` + `retryable` state when the action ran).

## What merchants see

- Orders fulfilled through the Ongoing shipping option get an Ongoing order number and a `sent` badge on the order widget within the push.
- Once Ongoing ships, the badge turns green (`shipped`), tracking numbers appear on the widget, and Medusa's shipment reflects the tracking.
- Stock levels update automatically on the stock-sync cadence.
- Failed syncs surface on both the dashboard table and the affected order's widget, with an error class telling you whether the plugin will retry it automatically.

## Related pages

- [[User How It Works]]
- [[User Troubleshooting]]
- [[User Verification]]
