# Plan: gate-order-edit row targeting by order_sync_id (#72)

## Problem (bug)

`src/workflows/steps/gate-order-edit.ts` resolves the `OngoingOrderSync` row to gate
with a two-way filter (lines 96-100):

```ts
const filters: Record<string, unknown> = input.medusa_fulfillment_id
  ? { medusa_fulfillment_id: input.medusa_fulfillment_id }
  : { medusa_order_id: input.medusa_order_id }

const [sync] = await service.listOngoingOrderSyncs(filters)
```

When `medusa_fulfillment_id` is null/absent the gate falls back to
`list({ medusa_order_id })[0]` — the **first** row only. For an order with ≥2
`OngoingOrderSync` rows that all carry null `medusa_fulfillment_id`, every per-row
iteration in `order-edit-confirmed.ts` and `order-updated.ts` re-resolves to the
**same first row**, so rows 2..N are mis-targeted (their edit is upserted against
row[0]'s Ongoing order).

**Actual:** N null-fulfillment rows → all gate/upsert against row[0].
**Expected:** each row gates/upserts against its own `OngoingOrderSync` record.
**Env:** Medusa v2 plugin, this repo, M3. Flagged by Medusa reviews of #31 (PR #71)
and #54 (PR #70). Reachable once status polling populates `latest_status_code` AND a
null-fulfillment multi-row order occurs. Pre-existing contract gap in #27's gate step.

**Root cause:** the gate has no way to be targeted by the sync row's own identity. The
subscribers already hold `row.id` (the `OngoingOrderSync` primary key) but only pass
`medusa_fulfillment_id`, which is the ambiguous key here.

## Approach

Add an optional `order_sync_id` to `GateInput` and make it the **highest-priority**
re-query key, then have both subscribers pass `row.id`. No data-model or migration
change — `listOngoingOrderSyncs({ id })` is auto-CRUD over the indexed primary key.

Priority order for the gate's row lookup becomes:
1. `order_sync_id` → `{ id: order_sync_id }` (exact row; new, authoritative)
2. `medusa_fulfillment_id` → `{ medusa_fulfillment_id }` (existing behavior #31/#54)
3. `medusa_order_id` → `{ medusa_order_id }` (last-resort fallback, still `[0]`)

Downstream needs no change: `GateDecision` already carries `order_sync_id` (set from
`sync.id` at `gate-order-edit.ts:59`, typed at `:15`), and
`upsertOngoingOrderEditStep` already targets `decision.order_sync_id`
(`upsert-ongoing-order-edit.ts:76` and `:97`). `syncOrderEditToOngoing` passes
`GateInput` straight through (`order_sync_id` optional → backward compatible). The pure
`decideOrderEditGate` function is unchanged.

This is a bug fix: per project `test-driven-development`, the failing regression test
lands first, then the code, then green.

## Tasks

### Task 1 — Failing regression test for the gate row-targeting (TDD red)

Create `src/workflows/steps/__tests__/gate-order-edit.test.ts`. It unit-tests the
`gateOrderEditStep` filter-branch selection against a fake Ongoing service, asserting
which filter object `listOngoingOrderSyncs` is invoked with. Build a real container the
same way `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts` does
(`createMedusaContainer()` + `container.register("ongoing", asValue(service))`), but
run the **step** directly via `gateOrderEditStep` so no workflow orchestration is
needed. Use the step's `.invoke` through a minimal harness, or exercise it through
`syncOrderEditToOngoing` if calling the bare step proves awkward — prefer asserting on
the service mock's recorded call args either way.

Service mock signature to satisfy (from `gate-order-edit.ts:91-94`):

```ts
listOngoingOrderSyncs: (filters: Record<string, unknown>) => Promise<SyncRow[]>
retrieveOngoingIntegration: (id: string) => Promise<IntegrationRow>
```

Cases (cite `#72` and the fix PR in a top-of-file comment):

1. **order_sync_id wins**: input `{ medusa_order_id: "order_1", medusa_fulfillment_id:
   "ful_1", order_sync_id: "os_2", category: "line_items" }` →
   `listOngoingOrderSyncs` called with `{ id: "os_2" }` (NOT `{ medusa_fulfillment_id }`,
   NOT `{ medusa_order_id }`).
2. **medusa_fulfillment_id second**: input `{ medusa_order_id: "order_1",
   medusa_fulfillment_id: "ful_1", category: "line_items" }` (no `order_sync_id`) →
   called with `{ medusa_fulfillment_id: "ful_1" }`.
3. **medusa_order_id last resort**: input `{ medusa_order_id: "order_1", category:
   "address_contact" }` (no `order_sync_id`, no `medusa_fulfillment_id`) → called with
   `{ medusa_order_id: "order_1" }`.
4. **Regression (the bug)**: two distinct rows with null `medusa_fulfillment_id` and
   distinct ids (`os_1`, `os_2`). Make the service mock return the row whose `id`
   matches the `{ id }` filter (e.g. `listOngoingOrderSyncs.mockImplementation((f) =>
   Promise.resolve(rows.filter((r) => r.id === f.id)))`). Run the gate twice — once with
   `order_sync_id: "os_1"`, once with `order_sync_id: "os_2"` — and assert each
   decision's `order_sync_id` equals the input row's id (`os_1` then `os_2`), proving
   rows no longer collapse to `os_1` for both. Before the fix, both inputs (lacking the
   `{ id }` branch) would resolve to `rows[0]` = `os_1`.

Run it and confirm it fails (the `order_sync_id` branch does not exist yet):

```
yarn test src/workflows/steps/__tests__/gate-order-edit.test.ts
```

### Task 2 — Add `order_sync_id` priority filter to the gate step (TDD green)

Edit `src/workflows/steps/gate-order-edit.ts`.

1. Extend the input type (lines 6-10):

```ts
export type GateInput = {
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  order_sync_id?: string
  category: OrderEditCategory
}
```

2. Replace the two-way ternary (lines 96-98) with a three-way priority filter inside
   `gateOrderEditStep.invoke`:

```ts
const filters: Record<string, unknown> = input.order_sync_id
  ? { id: input.order_sync_id }
  : input.medusa_fulfillment_id
    ? { medusa_fulfillment_id: input.medusa_fulfillment_id }
    : { medusa_order_id: input.medusa_order_id }
```

Leave `const [sync] = await service.listOngoingOrderSyncs(filters)` (line 100) and the
rest of the step unchanged — `{ id }` returns at most one row so the `[0]` is exact.
`decideOrderEditGate` and `GateDecision` are untouched.

Re-run Task 1's test until green:

```
yarn test src/workflows/steps/__tests__/gate-order-edit.test.ts
```

### Task 3 — Pass `order_sync_id: row.id` from `order-edit-confirmed.ts`

Edit `src/subscribers/order-edit-confirmed.ts`. In the per-row loop (`for (const row of
syncRows)`, line 90) the `.run()` input object (lines 112-116) must include the row id:

```ts
const { result } = await syncOrderEditToOngoing(container).run({
  input: {
    medusa_order_id: orderId,
    medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
    order_sync_id: row.id,
    category: "line_items",
  },
})
```

No other change in this file (`row.id` is already in scope and typed on
`OngoingOrderSyncRow`, lines 20-25).

### Task 4 — Pass `order_sync_id: row.id` from `order-updated.ts` and drop the stale comment

Edit `src/subscribers/order-updated.ts`. In the per-row loop (`for (const row of
syncRows)`, line 114) the `.run()` input (lines 140-146) must include the row id, and
the now-inverted comment at lines 142-143 must be deleted (after this fix
`order_sync_id` IS the primary targeting key, the opposite of what the comment claims):

Replace lines 139-147:

```ts
const { result } = await syncOrderEditToOngoing(container).run({
  input: {
    medusa_order_id: orderId,
    // Per-row targeting via fulfillment id (mirrors #31); #27 ignores
    // ongoing_order_sync_id, so passing it would mis-target multi-row orders.
    medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
    category: "address_contact",
  },
})
```

with:

```ts
const { result } = await syncOrderEditToOngoing(container).run({
  input: {
    medusa_order_id: orderId,
    // Per-row targeting by the sync row's own id (#72): order_sync_id is the
    // gate's primary key, with medusa_fulfillment_id as the secondary fallback.
    order_sync_id: row.id,
    medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
    category: "address_contact",
  },
})
```

The `select: ["id", ...]` on `listOngoingOrderSyncs` (lines 79-84) already includes
`"id"`, so `row.id` is populated. The inline comment on lines 77-78 above the `select`
still reads correctly (it explains `medusa_fulfillment_id`); leave it. No other change.

### Task 5 — Update subscriber tests to expect `order_sync_id` in the input

Edit `src/subscribers/__tests__/order-edit-confirmed.test.ts`. In the
`"re-syncs each sync row with category line_items when status is allowed"` test, the two
`runMock` `toHaveBeenCalledWith` assertions (lines 74-87) must include `order_sync_id`
matching each row's id (`oos_1`, `oos_2` from the rows on lines 65-66):

```ts
expect(runMock).toHaveBeenCalledWith({
  input: {
    medusa_order_id: "order_1",
    medusa_fulfillment_id: "ful_1",
    order_sync_id: "oos_1",
    category: "line_items",
  },
})
expect(runMock).toHaveBeenCalledWith({
  input: {
    medusa_order_id: "order_1",
    medusa_fulfillment_id: "ful_2",
    order_sync_id: "oos_2",
    category: "line_items",
  },
})
```

Edit `src/subscribers/__tests__/order-updated.test.ts`. In the `"re-syncs each sync row
with category address_contact when status is allowed"` test, the two
`toHaveBeenCalledWith` assertions (lines 93-106) must include `order_sync_id` matching
each row's id (`oos_1`, `oos_2` from rows on lines 84-85):

```ts
expect(runMock).toHaveBeenCalledWith({
  input: {
    medusa_order_id: "order_1",
    medusa_fulfillment_id: "ful_1",
    order_sync_id: "oos_1",
    category: "address_contact",
  },
})
expect(runMock).toHaveBeenCalledWith({
  input: {
    medusa_order_id: "order_1",
    medusa_fulfillment_id: "ful_2",
    order_sync_id: "oos_2",
    category: "address_contact",
  },
})
```

Run both:

```
yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts
yarn test src/subscribers/__tests__/order-updated.test.ts
```

### Task 6 — Cover `order_sync_id` in the workflow integration test

Edit `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`. The existing
happy-path (lines 67-77) keeps passing via the `medusa_fulfillment_id` branch, and the
`"does NOT call putOrder when there is no sync row"` fallback test (lines 93-101) keeps
exercising the `medusa_order_id` branch. ADD one test asserting the `order_sync_id`
branch drives the filter. Reuse `makeService()` / `makeScope()` and spy on the filter
arg:

```ts
it("targets the gate by order_sync_id when provided (multi-row, null fulfillment)", async () => {
  const service = makeService({
    listOngoingOrderSyncs: jest.fn().mockResolvedValue([
      {
        id: "os_2",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 200,
        medusa_fulfillment_id: null,
      },
    ]),
  })
  const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
    input: {
      medusa_order_id: "order_1",
      order_sync_id: "os_2",
      category: "line_items",
    },
  })

  expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: "os_2" })
  expect(result).toMatchObject({ synced: true, blocked: false, reason: "allowed" })
})
```

Run it:

```
yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts
```

## Verification

Run from the worktree root, all must pass:

```
yarn lint
yarn build
yarn test src/workflows/steps/__tests__/gate-order-edit.test.ts
yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts
yarn test src/subscribers/__tests__/order-updated.test.ts
yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts
yarn test
```

Done means: the regression test from Task 1 fails before Task 2 and passes after; the
full `yarn test` suite is green; `yarn lint` and `yarn build` are clean. Confirm no
data-model or migration change was introduced (`git diff --stat` touches only
`src/workflows/steps/gate-order-edit.ts`, `src/subscribers/order-edit-confirmed.ts`,
`src/subscribers/order-updated.ts`, and the four test files).

## Notes / out of scope

- No change to `src/workflows/steps/upsert-ongoing-order-edit.ts` (already targets
  `decision.order_sync_id`), `src/workflows/sync-order-edit-to-ongoing.ts` (passes
  `GateInput` through), or `decideOrderEditGate` (pure, unchanged).
- No new data model, `model.define`, or `plugin:db:generate` run — `{ id }` is auto-CRUD
  over the existing indexed primary key.
- Minimal-diff bug fix per project bug guidance; no drive-by refactors.
- PR body must `Fixes #72`.
