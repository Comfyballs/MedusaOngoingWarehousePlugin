# Clear edit-blocked state on successful re-sync (#103)

**Milestone:** M5: Admin UI & observability
**Type:** bug (banner goes stale otherwise)
**Relates to:** #91 (persisted the `edit_blocked_*` fields + the `markOrderSyncEditBlockedWorkflow`; clear-on-success was its explicitly-optional Task 6), #93 (renders the widget banner that goes stale), #94 (adds the `order-updated.ts` post-workflow persist site).

## Problem

#91 added `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` to `OngoingOrderSync` and wired the two edit-re-sync subscribers to **set** them when an edit is blocked. It did not implement the inverse: **clearing** those fields when a previously-blocked row later re-syncs successfully.

Consequence: once a row is marked edit-blocked, the fields are never nulled again. The #93 order-widget "Edit blocked" banner (gated on `edit_blocked_at` being set) therefore stays visible permanently, even after the edit successfully re-syncs — a stale, misleading UI state in production.

## Goal

When a sync row that is **currently** edit-blocked re-syncs successfully, null its three `edit_blocked_*` fields so the banner clears. Rows that were never blocked take no action (no redundant write).

## Approach — conditional clear

Reuse the existing machinery from #91 — no new workflow, step, model field, migration, or event:

- `markOrderSyncEditBlockedHandler` (`src/workflows/steps/mark-order-sync-edit-blocked.ts`) already nulls all three columns when called with `blocked: false`:
  ```ts
  edit_blocked_at: input.blocked ? new Date() : null,
  edit_blocked_category: input.blocked ? (input.category ?? null) : null,
  edit_blocked_reason: input.blocked ? (input.reason ?? null) : null,
  ```
- So the fix is: on each subscriber's **success** branch, call
  `markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id: row.id, blocked: false } })`.

The call is **guarded on `row.edit_blocked_at`** so a successful re-sync of a never-blocked row issues no DB write (and no `updated_at` bump). This was the chosen strategy over an unconditional clear, which would write on every successful re-sync regardless of prior state.

The clear call passes only `{ order_sync_id, blocked: false }` — the step ignores `category`/`reason` on the `blocked: false` path.

## Touch points

Both changes go **inside the existing per-row `try` block**, so any throw is caught by the existing per-row `catch` and never aborts the subscriber (spec §8: "Subscribers never throw (log + record error), are idempotent"). This mirrors the placement of the existing blocked-path `markOrderSyncEditBlockedWorkflow` calls.

### 1. `src/subscribers/order-updated.ts`
- Success branch (`if (result?.synced)`, currently ~line 172, today only `logger.info`): add the guarded clear call.
- Add `"edit_blocked_at"` to the `listOngoingOrderSyncs` `select` array (currently `["id", "integration_id", "latest_status_code", "medusa_fulfillment_id"]`) — the row is fetched with an explicit `select`, so the field must be requested.
- Add `edit_blocked_at` to the file's `OngoingOrderSyncRow` type.

### 2. `src/subscribers/order-edit-confirmed.ts`
- Success branch (the trailing `logger.info`, currently ~line 149, reached after `if (result?.blocked) { … continue }`): add the same guarded clear call.
- Widen the file's local `OngoingOrderSyncRow` type with `edit_blocked_at`. This `listOngoingOrderSyncs` call passes **no** `select` config, so all scalar fields (including `edit_blocked_at`) already come back at runtime; only the TypeScript type needs the field added. No `select` is introduced (adding one would narrow a currently-broad query — out of scope).

## Testing (TDD)

Add, per subscriber, two cases reusing the existing `markBlockedRunMock` / `runMock` fixtures:

1. **Clears when previously blocked:** a sync row with `edit_blocked_at` set that the workflow re-syncs successfully (`result: { synced: true, blocked: false, … }`) → asserts `markOrderSyncEditBlockedWorkflow` is called with `{ order_sync_id: <row id>, blocked: false }`.
2. **No-op when never blocked:** a sync row with `edit_blocked_at` null that re-syncs successfully → asserts the clear workflow is **not** called (guard holds).

Existing tests remain green: the blocked-path and no-sync-row cases never set `edit_blocked_at` alongside a successful result, so they don't trigger the new branch.

## Out of scope

- The pre-check and post-workflow **blocked** branches — already wired by #91 (both sites in `order-edit-confirmed.ts`; pre-check in `order-updated.ts`) and #94 (the `order-updated.ts` post-workflow site).
- Any change to the model, migration, `ONGOING_EVENTS`, the `markOrderSyncEditBlockedWorkflow`/step, or the widget (#93).
- Making the step itself a no-op when the row is already clear (would change #91's step behavior and touch the blocked path too) — the guard lives at the call site instead.
- Adding an explicit `select` to `order-edit-confirmed.ts`'s list call.
