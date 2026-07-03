# order-updated.ts take:1 order_change query silently drops address/contact changes (#110) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is business logic (a DB-query derivation + an event-replay data-repair script) and follows superpowers:test-driven-development — a failing test precedes each implementation step.

**Goal:** Fix `src/subscribers/order-updated.ts`'s `order_change` query so an address/contact change bundled with another field edit (`locale`, `metadata`, etc.) in the same `updateOrderWorkflow` call is never silently dropped, and ship a diagnostic + re-sync recipe for orders whose address change may already have been dropped by the pre-fix `take: 1` query.

**Architecture:** Medusa 2.16.0's `OrderModuleService.registerOrderChange_` (`node_modules/@medusajs/order/dist/services/order-module-service.js:1223-1242`) inserts **one `order_change` DB row per changed field** via a single `orderChangeService_.create(array)` call — never one row with multiple actions — confirmed against `updateOrderWorkflow`'s `changes.push(...)` loop (`node_modules/@medusajs/core-flows/dist/order/workflows/update-order.js:125-193`, at most 5 possible entries today: `shipping_address`, `billing_address`, `email`, `metadata`, `locale`). The subscriber's `pagination: { take: 1, order: { created_at: 'DESC' } }` therefore reads only one arbitrarily-tied-break row out of the group, and if that row isn't an address/contact type, a real address change is silently dropped even though it happened in the same call.

Fix: replace `take: 1` with a **burst-window** query — fetch up to `ORDER_CHANGE_BURST_QUERY_LIMIT` (20) rows ordered `created_at DESC`, then union `actions[].details.type` across every row within `ORDER_CHANGE_BURST_WINDOW_MS` (2000ms) of the newest row. All rows from one `updateOrderWorkflow` call are inserted via a single batched `.create(array)` call, so their `created_at` values are generated within, at most, a handful of synchronous JS statements of each other — 2 seconds is a large safety margin against ORM/clock jitter while still excluding a genuinely separate, later edit on the same order. Trading toward a few extra (idempotent, gated) re-sync attempts is the correct direction for a "silently drops" bug — it can never again produce a false negative from this cause.

**Watermark decision (resolves the plan brief's open question):** A **persisted watermark on `OngoingOrderSync`** (e.g. `last_processed_order_change_id`) is **rejected** in favor of the burst-window heuristic. `OngoingOrderSync` (`src/modules/ongoing/models/order-sync.ts:3-23`) is keyed per `(integration_id, medusa_order_id)` — an order has 0..N rows (one per integration) — while the `order_change` stream this bug concerns is per-*order*, not per-sync-row. A watermark would need identical writes fanned out across every row for the order on every `order.updated` event (redundant, no single natural owner), and has **no owner at all** for orders with zero sync rows (the common case for an order not yet pushed to Ongoing, or whose very first address edit is what creates urgency). Introducing a new cross-row watermark column plus its migration is disproportionate weight for closing a `take:1` bug when the burst-window query fully closes the false-negative gap without a schema change.

**Tech Stack:** Medusa 2.16.0, TypeScript 5.6 (`Node16` module resolution, decorators enabled — root `tsconfig.json`), yarn 4.6.0, Node >= 20, Jest (`@swc/jest`, `testEnvironment: "node"`, `clearMocks: true`, `jest.config.js`).

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6**; yarn **4.6.0**; Node **>= 20**.
- **Subscribers never throw** (spec §8, `docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:245`): the new query/derivation logic stays inside `order-updated.ts`'s existing outer `try` block (lines 40-73 today); no new code path escapes it.
- **`query.graph` only for reads** (`medusa-dev:building-with-medusa`): the fix and the diagnostic script both read via `ContainerRegistrationKeys.QUERY` `.graph({ entity: "order_change", ... })`, exactly as the existing (buggy) code already does — no `query.index` needed since we filter on `order_id`/`change_type`/`created_at`, all indexed relational fields already used by the existing query.
- **No new model, migration, or event.** This is a query-shape + derivation fix plus a data-repair script; nothing touches `src/modules/ongoing/models/`.
- **Test command:** `yarn test <path-substring>` (Jest substring match); full suite `yarn test`.
- **Verify current line numbers before editing** — this plan cites `order-updated.ts` lines as read at planning time (`src/subscribers/order-updated.ts`, current HEAD); confirm they still match before applying an edit anchored to a line range.

---

## File Structure

**Create (Task 1):**
- `src/lib/ongoing/order-change-burst.ts` — shared burst-window helpers (`deriveBurstChangedTypes`, `hasAddressContactChange`, `ADDRESS_CONTACT_DETAIL_TYPES`, `ORDER_CHANGE_BURST_WINDOW_MS`, `ORDER_CHANGE_BURST_QUERY_LIMIT`).
- `src/lib/ongoing/__tests__/order-change-burst.test.ts` — unit tests for the helpers.

**Modify (Task 1):**
- `src/subscribers/order-updated.ts` — replace the `take: 1` query + single-row derivation (current lines 8-16 and 43-73) with the burst-window query using the new shared helpers.
- `src/subscribers/__tests__/order-updated.test.ts` — full rewrite of the `order_change` mock shape (one row per changed field, not one row with multiple actions) plus 5 new/boundary test cases.

**Create (Task 2, depends on Task 1's `src/lib/ongoing/order-change-burst.ts`):**
- `src/scripts/resync-dropped-address-changes.ts` — one-off `medusa exec` data-repair script: scans recent `update_order` order_change history, flags candidate orders whose burst could have hit the pre-fix bug, and replays the (now-fixed) `order-updated` subscriber against each candidate.
- `src/scripts/__tests__/resync-dropped-address-changes.test.ts` — unit tests for the candidate-finding logic and the script's replay/dry-run/paging behavior.

**Depends on (already exists, unmodified):**
- `src/subscribers/order-updated.ts`'s default export `orderUpdatedHandler` (reused by the Task 2 script — its own fixed logic is what the script replays).
- `src/modules/ongoing/models/order-sync.ts` — unchanged; confirms no watermark field exists (see Architecture decision above).

---

## Task 1: Fix the `take: 1` burst-drop bug (TDD)

**Files:**
- Create: `src/lib/ongoing/order-change-burst.ts`
- Test: `src/lib/ongoing/__tests__/order-change-burst.test.ts`
- Modify: `src/subscribers/order-updated.ts`
- Test: `src/subscribers/__tests__/order-updated.test.ts`

**Interfaces:**
- Produces (new, exported from `src/lib/ongoing/order-change-burst.ts`):
  - `ADDRESS_CONTACT_DETAIL_TYPES: Set<string>` — moved unchanged from `order-updated.ts`'s current lines 11-16.
  - `ORDER_CHANGE_BURST_QUERY_LIMIT: number` — `20`.
  - `ORDER_CHANGE_BURST_WINDOW_MS: number` — `2000`.
  - `type OrderChangeActionRow = { id?: string; created_at: string | Date; actions?: Array<{ id?: string; details?: { type?: string } }> | null }`.
  - `deriveBurstChangedTypes(changes: OrderChangeActionRow[] | null | undefined, burstWindowMs?: number): string[]` — precondition: `changes` must already be sorted `created_at` DESC (as returned by `order: { created_at: "DESC" }`); returns the deduped union of `actions[].details.type` across every row within `burstWindowMs` (default `ORDER_CHANGE_BURST_WINDOW_MS`) of `changes[0]`.
  - `hasAddressContactChange(changedTypes: string[]): boolean`.
- Consumes (in `order-updated.ts`): the four symbols above, imported from `../lib/ongoing/order-change-burst`.
- `orderUpdatedHandler`'s exported signature is unchanged: `async ({ event, container }: SubscriberArgs<{ id: string }>): Promise<void>`. Only its internal `order_change` query and derivation change.

### Step 1: Write the failing tests for the shared burst helper

Create `src/lib/ongoing/__tests__/order-change-burst.test.ts`:

```ts
import {
  deriveBurstChangedTypes,
  hasAddressContactChange,
  ADDRESS_CONTACT_DETAIL_TYPES,
  ORDER_CHANGE_BURST_WINDOW_MS,
} from "../order-change-burst"

describe("deriveBurstChangedTypes", () => {
  it("returns an empty array when there are no rows", () => {
    expect(deriveBurstChangedTypes([])).toEqual([])
    expect(deriveBurstChangedTypes(null)).toEqual([])
    expect(deriveBurstChangedTypes(undefined)).toEqual([])
  })

  it("returns the single row's type for a single-row change", () => {
    const rows = [
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows)).toEqual(["shipping_address"])
  })

  it("unions detail types across rows within the burst window (address+locale bundle)", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(new Set(deriveBurstChangedTypes(rows))).toEqual(
      new Set(["locale", "shipping_address"])
    )
  })

  it("excludes a row older than the burst window from a separate earlier edit", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:02.500Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    // 2500ms gap > default 2000ms window
    expect(deriveBurstChangedTypes(rows)).toEqual(["locale"])
  })

  it("includes a row exactly at the burst window boundary", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:02.000Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    // exactly 2000ms gap == default window, inclusive
    expect(new Set(deriveBurstChangedTypes(rows))).toEqual(
      new Set(["locale", "shipping_address"])
    )
  })

  it("respects a custom burstWindowMs override", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.500Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows, 100)).toEqual(["locale"])
  })

  it("ignores rows/actions with a missing or non-string details.type", () => {
    const rows = [
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: {} }, { details: undefined }],
      },
    ]
    expect(deriveBurstChangedTypes(rows as any)).toEqual([])
  })

  it("dedupes a repeated type across rows in the same burst", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.010Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows)).toEqual(["shipping_address"])
  })
})

describe("hasAddressContactChange", () => {
  it("is true when any changed type is in ADDRESS_CONTACT_DETAIL_TYPES", () => {
    expect(hasAddressContactChange(["metadata", "billing_address"])).toBe(true)
  })

  it("is false when no changed type is address/contact", () => {
    expect(hasAddressContactChange(["metadata", "locale"])).toBe(false)
  })

  it("is false for an empty array", () => {
    expect(hasAddressContactChange([])).toBe(false)
  })
})

describe("ADDRESS_CONTACT_DETAIL_TYPES", () => {
  it("contains exactly the classified detail types", () => {
    expect([...ADDRESS_CONTACT_DETAIL_TYPES].sort()).toEqual(
      ["billing_address", "contact", "email", "shipping_address"].sort()
    )
  })
})

describe("ORDER_CHANGE_BURST_WINDOW_MS", () => {
  it("defaults to 2000ms", () => {
    expect(ORDER_CHANGE_BURST_WINDOW_MS).toBe(2000)
  })
})
```

### Step 2: Run the test to verify it fails

Run: `yarn test src/lib/ongoing/__tests__/order-change-burst.test.ts`
Expected: FAIL — `Cannot find module '../order-change-burst'` (the file does not exist yet).

### Step 3: Implement the shared burst helper

Create `src/lib/ongoing/order-change-burst.ts`:

```ts
// Shared burst-window helpers for classifying Medusa `order_change` rows
// produced by `updateOrderWorkflow`. Medusa's OrderModuleService.registerOrderChange_
// inserts ONE order_change DB row per changed field via a single
// `orderChangeService_.create(array)` call
// (node_modules/@medusajs/order/dist/services/order-module-service.js:1223-1242,
// confirmed against Medusa 2.16.0 core source in issue #110's review) — never one row
// with multiple actions. Consumers must union detail types across all rows created in
// the same updateOrderWorkflow call ("burst"), not read a single row (issue #110).

// spec §13.3 — verify this set against a live update_order order-change during
// integration testing.
export const ADDRESS_CONTACT_DETAIL_TYPES = new Set([
  "shipping_address",
  "billing_address",
  "email",
  "contact",
])

// updateOrderWorkflow
// (node_modules/@medusajs/core-flows/dist/order/workflows/update-order.js:125-193,
// Medusa 2.16.0) pushes at most 5 change entries per call today (shipping_address,
// billing_address, email, metadata, locale). take:20 gives generous headroom for future
// Medusa versions adding more per-call update fields without missing any row in a burst.
export const ORDER_CHANGE_BURST_QUERY_LIMIT = 20

// All rows from one updateOrderWorkflow call are inserted via a single
// orderChangeService_.create(array) call (one INSERT batch), so their created_at values
// are generated within, at most, a handful of synchronous JS statements of each other —
// well under a second in practice. 2s is a generous safety margin against clock/ORM
// jitter while still excluding a genuinely separate, later admin edit on the same order.
export const ORDER_CHANGE_BURST_WINDOW_MS = 2000

export type OrderChangeActionRow = {
  id?: string
  created_at: string | Date
  actions?: Array<{ id?: string; details?: { type?: string } }> | null
}

// Given order_change rows already sorted `created_at DESC` (as returned by
// `query.graph`'s `order: { created_at: "DESC" }`), returns the deduped union of
// `actions[].details.type` across every row within `burstWindowMs` of the newest row —
// i.e. every field changed by the single updateOrderWorkflow call that fired this
// order.updated event, not just whichever row a `take: 1` query happened to return (#110).
export function deriveBurstChangedTypes(
  changes: OrderChangeActionRow[] | null | undefined,
  burstWindowMs: number = ORDER_CHANGE_BURST_WINDOW_MS
): string[] {
  const rows = changes ?? []
  const newest = rows[0]
  if (!newest) {
    return []
  }
  const newestTime = new Date(newest.created_at).getTime()

  const types = new Set<string>()
  for (const row of rows) {
    const rowTime = new Date(row.created_at).getTime()
    if (newestTime - rowTime > burstWindowMs) {
      continue
    }
    for (const action of row.actions ?? []) {
      const type = action?.details?.type
      if (typeof type === "string") {
        types.add(type)
      }
    }
  }
  return [...types]
}

export function hasAddressContactChange(changedTypes: string[]): boolean {
  return changedTypes.some((t) => ADDRESS_CONTACT_DETAIL_TYPES.has(t))
}
```

### Step 4: Run the test to verify it passes

Run: `yarn test src/lib/ongoing/__tests__/order-change-burst.test.ts`
Expected: PASS — all cases in the new file.

### Step 5: Rewrite the failing tests for `order-updated.ts` (real one-row-per-change mock shape)

Replace the full contents of `src/subscribers/__tests__/order-updated.test.ts` with:

```ts
import orderUpdatedHandler from "../order-updated"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../../workflows/mark-order-sync-edit-blocked"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))
jest.mock("../../workflows/mark-order-sync-edit-blocked", () => ({
  markOrderSyncEditBlockedWorkflow: jest.fn(),
}))

const runMock = jest
  .fn()
  .mockResolvedValue({ result: { synced: true, blocked: false, reason: "allowed" } })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

const markBlockedRunMock = jest.fn().mockResolvedValue({ order_sync_id: "oos_1" })
;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })

type GraphCall = { entity: string }

// Real Medusa semantics (#110): registerOrderChange_ inserts ONE order_change row
// per changed field (never one row with multiple actions). `changeRows` models that:
// one entry per row, listed newest-first (created_at DESC) to match the real
// `order: { created_at: "DESC" }` query.
type ChangeRow = { id: string; created_at: string; type: string }

// Builds a container whose query.graph returns:
//  - for entity "order_change": the update_order order_change rows for the burst
//    that fired this event (see ChangeRow above)
//  - for entity "ongoing_integration": the integration with the given edit_sync_rules
function makeContainer(opts: {
  changeRows: ChangeRow[]
  syncRows: Array<{
    id: string
    integration_id: string
    latest_status_code: number | null
    medusa_fulfillment_id: string | null
    edit_blocked_at?: string | Date | null
  }>
  editSyncRules: Record<string, Record<string, number[]>> // integration_id -> { address_contact: number[] }
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const service = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.syncRows),
  }
  const query = {
    graph: jest.fn(async ({ entity }: GraphCall) => {
      if (entity === "order_change") {
        return {
          data: opts.changeRows.map((row) => ({
            id: row.id,
            change_type: "update_order",
            created_at: row.created_at,
            actions: [{ id: `${row.id}_act`, details: { type: row.type } }],
          })),
        }
      }
      if (entity === "ongoing_integration") {
        const integrations = Object.entries(opts.editSyncRules).map(([id, rules]) => ({
          id,
          edit_sync_rules: rules,
        }))
        return { data: integrations }
      }
      return { data: [] }
    }),
  }
  const container = {
    resolve: jest.fn((name: string): any => {
      if (name === "logger") return logger
      if (name === "query") return query
      if (name === "event_bus") return { emit }
      // module id "ongoing"
      return service
    }),
  }
  return { container, logger, emit, service, query }
}

const event = (id: string) => ({ event: { eventName: "order.updated", data: { id } } } as any)

beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
  ;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
})

describe("order.updated subscriber — address/contact re-sync", () => {
  it("re-syncs each sync row with category address_contact when status is allowed", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(2)
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
  })

  it("re-syncs when an address change is bundled with a locale edit in the same burst (regression #110)", async () => {
    // Newest row (created_at DESC[0]) is "locale" — a pre-fix take:1 query would
    // read only this row, see no address/contact type, and silently skip the
    // real shipping_address change from the same updateOrderWorkflow call.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        order_sync_id: "oos_1",
        category: "address_contact",
      },
    })
  })

  it("re-syncs on an address-only edit with a single order_change row", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("re-syncs when address+metadata+locale are bundled in the same burst", async () => {
    // Newest row is "metadata" — a pre-fix take:1 query would read only this row.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_3", created_at: "2026-06-28T10:00:00.020Z", type: "metadata" },
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("handles a burst of 5 changes (all updateOrderWorkflow fields) and re-syncs once per sync row", async () => {
    // Newest row is "locale" (non-address) — a pre-fix take:1 query would read
    // only this row and never re-sync either sync row.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_5", created_at: "2026-06-28T10:00:00.020Z", type: "locale" },
        { id: "ordch_4", created_at: "2026-06-28T10:00:00.015Z", type: "metadata" },
        { id: "ordch_3", created_at: "2026-06-28T10:00:00.010Z", type: "email" },
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.005Z", type: "billing_address" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    // Exactly once per sync row, not once per changed field.
    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it("ignores an order_change row outside the burst window from a separate earlier edit", async () => {
    // The address change is >2s older than the newest row — a separate, already
    // -handled edit, not part of this event's burst.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:02.500Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
  })

  it("emits edit_blocked and marks the row when the workflow's own re-gate blocks (post-workflow site)", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // subscriber's own pre-check gate allows
    })

    // Status passes the subscriber's own pre-check gate, but the workflow's
    // internal re-gate (gateOrderEditStep, inside syncOrderEditToOngoing) blocks
    // — e.g. status changed between the subscriber's query and the workflow's own.
    runMock.mockResolvedValueOnce({ result: { synced: false, blocked: true, reason: "status_blocked" } })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 100,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("clears edit-blocked state after a successful re-sync of a previously-blocked row", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    // runMock's default resolves { synced: true, blocked: false } (test file line 14)
    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).toHaveBeenCalledTimes(1)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
  })

  it("does not clear edit-blocked state when the row was not blocked", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: null,
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).not.toHaveBeenCalled()
  })

  it("no-ops when only metadata/locale changed (no relevant detail type)", async () => {
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "metadata" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    // Did not even need to load sync rows.
    expect(container.resolve("ongoing").listOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "billing_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 999, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // 999 not allowed
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 999,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("blocks and emits a warning when latest_status_code is unknown (null)", async () => {
    // M2 default: latest_status_code is NULL until the status-poll milestone, so
    // the address_contact gate is closed by default. Pin that branch explicitly.
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "email" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: null, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: null,
      },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_unknown" },
    })
  })

  it("blocks and emits a warning when the integration has no address_contact rules", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: {} }, // no address_contact allow-list
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 100,
      },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("no-ops when there are no sync rows for the order", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [],
      editSyncRules: {},
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it("isolates a per-row failure and still processes the remaining rows", async () => {
    const { container, logger } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    // First row's workflow run blows up; the second must still run.
    runMock.mockRejectedValueOnce(new Error("row boom"))

    await expect(
      orderUpdatedHandler({ ...event("order_1"), container })
    ).resolves.toBeUndefined()

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to process sync oos_1: row boom")
    )
  })

  it("never throws when an internal call fails (logs error instead)", async () => {
    const { container, logger } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    // Force the query.graph call to blow up.
    const query = container.resolve("query")
    ;(query.graph as jest.Mock).mockRejectedValueOnce(new Error("boom"))

    await expect(
      orderUpdatedHandler({ ...event("order_1"), container })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("order.updated handler failed for order_1: boom")
    )
    expect(runMock).not.toHaveBeenCalled()
  })
})
```

### Step 6: Run the tests to verify they fail

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: FAIL on exactly 3 tests against the current (unfixed) subscriber — `"re-syncs when an address change is bundled with a locale edit..."`, `"re-syncs when address+metadata+locale are bundled..."`, and `"handles a burst of 5 changes..."` — because the current code reads only `changes[0]` (the newest row, deliberately a non-address type in each of these fixtures) and returns early before calling `syncOrderEditToOngoing`. All other tests pass unchanged (including the new `"re-syncs on an address-only edit..."` and `"ignores an order_change row outside the burst window..."` cases, which happen to already behave correctly under `take: 1` and exist to lock in that behavior, not to demonstrate the bug).

### Step 7: Fix the subscriber

In `src/subscribers/order-updated.ts`, remove the local `ADDRESS_CONTACT_DETAIL_TYPES` constant (current lines 8-16):

```ts
// Order-change action detail types (set by Medusa's updateOrderWorkflow) that we
// classify as the spec §8 "address_contact" edit category. See spec §13.3 — verify
// this set against a live `update_order` order-change during integration testing.
const ADDRESS_CONTACT_DETAIL_TYPES = new Set([
  "shipping_address",
  "billing_address",
  "email",
  "contact",
])
```

and the top-of-file imports (current lines 1-6):

```ts
import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../workflows/mark-order-sync-edit-blocked"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
```

with:

```ts
import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../workflows/mark-order-sync-edit-blocked"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
import {
  ORDER_CHANGE_BURST_QUERY_LIMIT,
  deriveBurstChangedTypes,
  hasAddressContactChange,
} from "../lib/ongoing/order-change-burst"
```

Then replace the query + derivation block (current lines 43-73):

```ts
    // 1. Inspect the latest update_order order-change to see what changed.
    //    Payload carries only { id }, so we re-query. We read the actions'
    //    details.type and keep only address/contact/email changes.
    const { data: changes } = await query.graph({
      entity: "order_change",
      fields: ["id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        order_id: orderId,
        change_type: "update_order",
      },
      pagination: {
        take: 1,
        order: { created_at: "DESC" },
      },
    })

    const latestChange = changes?.[0]
    const changedTypes: string[] = (latestChange?.actions ?? [])
      .map((a: { details?: { type?: string } }) => a?.details?.type)
      .filter((t: unknown): t is string => typeof t === "string")

    const hasAddressContactChange = changedTypes.some((t) =>
      ADDRESS_CONTACT_DETAIL_TYPES.has(t)
    )

    if (!hasAddressContactChange) {
      logger.info(
        `[ongoing] order.updated for ${orderId}: no address/contact/email change (types: ${changedTypes.join(", ") || "none"}), skipping`
      )
      return
    }
```

with:

```ts
    // 1. Inspect all update_order order-changes from the burst that fired this
    //    event. Payload carries only { id }, so we re-query. Medusa's
    //    registerOrderChange_ inserts ONE order_change row per changed field
    //    (never one row with multiple actions), so we union detail types across
    //    every row within the burst window, not just the newest row — otherwise
    //    an address change bundled with e.g. locale/metadata in the same
    //    updateOrderWorkflow call is silently dropped (#110).
    const { data: changes } = await query.graph({
      entity: "order_change",
      fields: ["id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        order_id: orderId,
        change_type: "update_order",
      },
      pagination: {
        take: ORDER_CHANGE_BURST_QUERY_LIMIT,
        order: { created_at: "DESC" },
      },
    })

    const changedTypes = deriveBurstChangedTypes(changes)

    if (!hasAddressContactChange(changedTypes)) {
      logger.info(
        `[ongoing] order.updated for ${orderId}: no address/contact/email change (types: ${changedTypes.join(", ") || "none"}), skipping`
      )
      return
    }
```

No other lines in `order-updated.ts` change — the sync-row loop, gating, and event emission (current lines 75-234) and the `config` export are untouched.

### Step 8: Run the tests to verify they pass

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: PASS — all 16 tests, including the 3 that failed in Step 6.

### Step 9: Commit

```bash
git add src/lib/ongoing/order-change-burst.ts src/lib/ongoing/__tests__/order-change-burst.test.ts src/subscribers/order-updated.ts src/subscribers/__tests__/order-updated.test.ts
git commit -m "fix(ongoing): union order_change burst instead of take:1 in order-updated (#110)"
```

---

## Task 2: Diagnostic + re-sync script for previously-dropped address changes (TDD)

**Files:**
- Create: `src/scripts/resync-dropped-address-changes.ts`
- Test: `src/scripts/__tests__/resync-dropped-address-changes.test.ts`

**Depends on:** `src/lib/ongoing/order-change-burst.ts` (Task 1) and `src/subscribers/order-updated.ts`'s default export `orderUpdatedHandler` (Task 1's fixed version). Run this task after Task 1.

**Interfaces:**
- Produces:
  - `export function findCandidateOrderIds(rows: OrderChangeRow[]): string[]` — pure grouping/classification logic (unit-testable without a container).
  - `export default async function resyncDroppedAddressChanges({ container, args }: ExecArgs): Promise<void>` — the `medusa exec` entry point.
  - `type OrderChangeRow = { id: string; order_id: string; created_at: string | Date; actions?: Array<{ id?: string; details?: { type?: string } }> | null }`.
- Consumes: `deriveBurstChangedTypes`, `hasAddressContactChange`, `ORDER_CHANGE_BURST_WINDOW_MS` from `../lib/ongoing/order-change-burst`; the default export of `../subscribers/order-updated`; `ContainerRegistrationKeys.QUERY`/`.LOGGER` from `@medusajs/framework/utils`; `ExecArgs` from `@medusajs/framework/types` (Medusa's own one-off-script convention — see `node_modules/@medusajs/types/dist/common/medusa-cli.d.ts`, also used internally by `@medusajs/medusa`'s own `migration-scripts/*`).
- Usage (documented in the script's header comment, since this plugin repo has no consuming Medusa app to run it against directly): copy the compiled file into the consuming app's own `src/scripts/` (or run it directly against `.medusa/server/src/scripts/resync-dropped-address-changes.js` inside `node_modules/<this-plugin-package>` once built) and run `npx medusa exec ./src/scripts/resync-dropped-address-changes.ts [--since-days=90] [--dry-run]`.

### Step 1: Write the failing tests

Create `src/scripts/__tests__/resync-dropped-address-changes.test.ts`:

```ts
import resyncDroppedAddressChanges, { findCandidateOrderIds } from "../resync-dropped-address-changes"
import orderUpdatedHandler from "../../subscribers/order-updated"

jest.mock("../../subscribers/order-updated", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}))

const orderUpdatedHandlerMock = orderUpdatedHandler as unknown as jest.Mock

type RawRow = { id: string; order_id: string; created_at: string; type: string }
type GraphCall = {
  entity: string
  filters?: Record<string, unknown>
  pagination?: { take: number; skip: number }
}

function makeContainer(pages: RawRow[][]) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  let callIndex = 0
  const query = {
    graph: jest.fn(async (call: GraphCall) => {
      const page = pages[callIndex] ?? []
      callIndex += 1
      return {
        data: page.map((row) => ({
          id: row.id,
          order_id: row.order_id,
          change_type: "update_order",
          created_at: row.created_at,
          actions: [{ id: `${row.id}_act`, details: { type: row.type } }],
        })),
      }
    }),
  }
  const container = {
    resolve: jest.fn((name: string): any => {
      if (name === "logger") return logger
      if (name === "query") return query
      return undefined
    }),
  }
  return { container, logger, query }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("findCandidateOrderIds", () => {
  it("flags an order whose burst bundles an address change with a non-address change", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual(["order_1"])
  })

  it("does not flag an order whose only burst has a single row (take:1 was already correct)", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("does not flag a burst whose union has no address/contact type", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "metadata" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("treats rows more than the burst window apart as separate bursts", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:05.000Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("evaluates multiple orders independently", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_3",
        order_id: "order_2",
        created_at: "2026-06-01T11:00:00.000Z",
        actions: [{ details: { type: "metadata" } }],
      },
      {
        id: "ordch_4",
        order_id: "order_2",
        created_at: "2026-06-01T11:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual(["order_1"])
  })
})

describe("resyncDroppedAddressChanges", () => {
  it("replays order-updated for each candidate order found in the scan", async () => {
    const { container, query } = makeContainer([
      [
        { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
        { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
      ],
    ])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(orderUpdatedHandlerMock).toHaveBeenCalledTimes(1)
    expect(orderUpdatedHandlerMock).toHaveBeenCalledWith({
      event: { name: "order.updated", data: { id: "order_1" } },
      container,
      pluginOptions: {},
    })
    expect(query.graph).toHaveBeenCalledWith(expect.objectContaining({ entity: "order_change" }))
  })

  it("does not replay anything in --dry-run mode", async () => {
    const { container, logger } = makeContainer([
      [
        { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
        { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
      ],
    ])

    await resyncDroppedAddressChanges({ container, args: ["--dry-run"] } as any)

    expect(orderUpdatedHandlerMock).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("would replay order.updated for order_1")
    )
  })

  it("pages through order_change rows across multiple pages", async () => {
    const PAGE_SIZE = 500
    const page1: RawRow[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `ordch_p0_${i}`,
      order_id: `order_p0_${i}`,
      created_at: "2026-06-01T10:00:00.000Z",
      type: "metadata",
    }))
    const page2: RawRow[] = [
      { id: "ordch_p1_0", order_id: "order_p1_0", created_at: "2026-06-01T10:00:00.000Z", type: "metadata" },
    ]
    const { container, query } = makeContainer([page1, page2])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(query.graph).toHaveBeenCalledTimes(2)
    expect(query.graph).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pagination: expect.objectContaining({ skip: PAGE_SIZE }) })
    )
  })

  it("no-ops when the scan finds no candidate orders", async () => {
    const { container } = makeContainer([[]])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(orderUpdatedHandlerMock).not.toHaveBeenCalled()
  })

  it("filters order_change rows using a --since-days override", async () => {
    const { container, query } = makeContainer([[]])

    await resyncDroppedAddressChanges({ container, args: ["--since-days=7"] } as any)

    const call = (query.graph as jest.Mock).mock.calls[0][0]
    const sinceIso = call.filters.created_at.$gte as string
    const days = (Date.now() - new Date(sinceIso).getTime()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })
})
```

### Step 2: Run the tests to verify they fail

Run: `yarn test src/scripts/__tests__/resync-dropped-address-changes.test.ts`
Expected: FAIL — `Cannot find module '../resync-dropped-address-changes'` (the file does not exist yet).

### Step 3: Implement the script

Create `src/scripts/resync-dropped-address-changes.ts`:

```ts
import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import orderUpdatedHandler from "../subscribers/order-updated"
import {
  ORDER_CHANGE_BURST_WINDOW_MS,
  deriveBurstChangedTypes,
  hasAddressContactChange,
} from "../lib/ongoing/order-change-burst"

// One-off data-repair script for #110: before the fix, order-updated.ts's
// `take: 1` order_change query could silently drop a real address/contact
// change bundled with another field edit (locale/metadata/etc.) in the same
// updateOrderWorkflow call, so the order's OngoingOrderSync row(s) were never
// re-synced. This scans recent `update_order` order_change history, finds
// every order whose burst *could* have hit that bug (>=2 rows in one burst,
// including an address/contact type — we cannot know in hindsight which row
// the DB's take:1 query actually returned, so every such burst is treated as
// a candidate), and replays the now-fixed order-updated subscriber against
// each one. Replaying is safe to run more than once: orderUpdatedHandler
// re-derives the current changedTypes and re-gates on edit_sync_rules /
// latest_status_code exactly as it would for a live event, so an order that
// turns out not to be affected (or is no longer allowed to sync) is a no-op.
//
// Usage: copy this file into a consuming Medusa app's own `src/scripts/` (or
// point at `.medusa/server/src/scripts/resync-dropped-address-changes.js`
// inside this plugin's package once built) and run:
//   npx medusa exec ./src/scripts/resync-dropped-address-changes.ts [--since-days=90] [--dry-run]

export type OrderChangeRow = {
  id: string
  order_id: string
  created_at: string | Date
  actions?: Array<{ id?: string; details?: { type?: string } }> | null
}

const DEFAULT_SINCE_DAYS = 90
const PAGE_SIZE = 500

function parseArgs(args: string[]): { sinceDays: number; dryRun: boolean } {
  const sinceDaysArg = args.find((a) => a.startsWith("--since-days="))
  const parsed = sinceDaysArg ? parseInt(sinceDaysArg.split("=")[1], 10) : NaN
  const sinceDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SINCE_DAYS
  const dryRun = args.includes("--dry-run")
  return { sinceDays, dryRun }
}

// Groups already-fetched order_change rows (any order's update_order history)
// into per-order bursts using the same window as the production fix
// (deriveBurstChangedTypes), and returns the order_ids where at least one
// burst both (a) has more than one row and (b) its unioned changedTypes
// include an address/contact type.
export function findCandidateOrderIds(rows: OrderChangeRow[]): string[] {
  const byOrder = new Map<string, OrderChangeRow[]>()
  for (const row of rows) {
    const list = byOrder.get(row.order_id) ?? []
    list.push(row)
    byOrder.set(row.order_id, list)
  }

  const candidates = new Set<string>()
  for (const [orderId, orderRows] of byOrder) {
    // Sort DESC by created_at to match deriveBurstChangedTypes's contract.
    const sorted = [...orderRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    let burst: OrderChangeRow[] = []
    const flushBurst = () => {
      if (burst.length > 1 && hasAddressContactChange(deriveBurstChangedTypes(burst))) {
        candidates.add(orderId)
      }
      burst = []
    }
    for (const row of sorted) {
      if (burst.length === 0) {
        burst.push(row)
        continue
      }
      const burstNewestTime = new Date(burst[0].created_at).getTime()
      const rowTime = new Date(row.created_at).getTime()
      if (burstNewestTime - rowTime <= ORDER_CHANGE_BURST_WINDOW_MS) {
        burst.push(row)
      } else {
        flushBurst()
        burst.push(row)
      }
    }
    flushBurst()
  }
  return [...candidates]
}

export default async function resyncDroppedAddressChanges({
  container,
  args,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { sinceDays, dryRun } = parseArgs(args)
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

  logger.info(
    `[ongoing] resync-dropped-address-changes: scanning update_order order_change rows since ${sinceDate.toISOString()}${dryRun ? " (dry run)" : ""}`
  )

  const rows: OrderChangeRow[] = []
  let skip = 0
  for (;;) {
    const { data } = await query.graph({
      entity: "order_change",
      fields: ["id", "order_id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        change_type: "update_order",
        created_at: { $gte: sinceDate.toISOString() },
      },
      pagination: { take: PAGE_SIZE, skip, order: { created_at: "DESC" } },
    })
    rows.push(...(data as OrderChangeRow[]))
    if (!data || data.length < PAGE_SIZE) {
      break
    }
    skip += PAGE_SIZE
  }

  const candidateOrderIds = findCandidateOrderIds(rows)
  logger.info(
    `[ongoing] resync-dropped-address-changes: found ${candidateOrderIds.length} candidate order(s)`
  )

  if (dryRun) {
    for (const orderId of candidateOrderIds) {
      logger.info(
        `[ongoing] resync-dropped-address-changes: (dry run) would replay order.updated for ${orderId}`
      )
    }
    return
  }

  for (const orderId of candidateOrderIds) {
    await orderUpdatedHandler({
      event: { name: "order.updated", data: { id: orderId } },
      container,
      pluginOptions: {},
    })
  }

  logger.info(
    `[ongoing] resync-dropped-address-changes: replayed order.updated for ${candidateOrderIds.length} order(s)`
  )
}
```

### Step 4: Run the tests to verify they pass

Run: `yarn test src/scripts/__tests__/resync-dropped-address-changes.test.ts`
Expected: PASS — all cases.

### Step 5: Commit

```bash
git add src/scripts/resync-dropped-address-changes.ts src/scripts/__tests__/resync-dropped-address-changes.test.ts
git commit -m "feat(ongoing): add diagnostic + re-sync script for pre-#110 dropped address changes"
```

---

## Task 3: Full verification before review

No new code — run the full gates and confirm green.

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: PASS — all suites green, in particular `src/lib/ongoing/__tests__/order-change-burst.test.ts`, `src/subscribers/__tests__/order-updated.test.ts`, and `src/scripts/__tests__/resync-dropped-address-changes.test.ts` with their new/rewritten cases, and no regression elsewhere.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: PASS — `medusa lint` (eslint flat config, `@medusajs/eslint-plugin recommended`) reports no errors on the new/modified files.

- [ ] **Step 3: Build**

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles `src/lib/ongoing/order-change-burst.ts`, `src/subscribers/order-updated.ts`, and `src/scripts/resync-dropped-address-changes.ts` to `.medusa/server` with no type errors.

- [ ] **Step 4: Confirm the diff scope**

Verify the working tree touches only: `src/lib/ongoing/order-change-burst.ts` (new), `src/lib/ongoing/__tests__/order-change-burst.test.ts` (new), `src/subscribers/order-updated.ts` (modified), `src/subscribers/__tests__/order-updated.test.ts` (modified), `src/scripts/resync-dropped-address-changes.ts` (new), `src/scripts/__tests__/resync-dropped-address-changes.test.ts` (new). No changes to the `OngoingOrderSync` model/migration, `ONGOING_EVENTS`, `order-edit-confirmed.ts`, or the admin widget. Per `CLAUDE.md` ("Code review before merging"), the reviewer must independently load `medusa-dev:building-with-medusa` before merge.

---

## Self-Review (completed during planning)

- **Issue coverage:** the exact failure scenario (address change bundled with `locale`/other field, non-deterministic `take: 1` row) → Task 1 fixes the query and derivation, with a direct regression test (`"re-syncs when an address change is bundled with a locale edit..."`) that fails against the current code (Step 6) and passes after the fix (Step 8). Test-mock realism ("The unit test... does not match the real one-row-per-change shape") → Task 1 Step 5 rewrites the mock to one row per changed field. Recommended fix ("query all order_change rows... union their detail types... derive changedTypes from the union") → implemented exactly as `deriveBurstChangedTypes` + `hasAddressContactChange` in `order-change-burst.ts`. Required new test cases (address+locale bundle, address-only edit, address+metadata+locale, burst of 5) → all four present in Task 1 Step 5, plus a burst-window-boundary test as a safety net for the window design itself. Data-repair diagnostic + re-sync recipe → Task 2's `findCandidateOrderIds` (diagnostic) and `resyncDroppedAddressChanges` (re-sync recipe replaying the fixed subscriber), matching the issue's own suggestion ("probably re-run the subscriber once against a scan of recent order_change rows").
- **Watermark question resolved, not deferred:** the plan brief asked to decide between a persisted `OngoingOrderSync` watermark and a burst-window heuristic. `OngoingOrderSync` (`src/modules/ongoing/models/order-sync.ts:3-23`) has no suitable field and is the wrong owner (0..N rows per order, order-level concern) — recommended default (burst-window) is used, with the rejection reasoning stated in the Architecture section rather than left as an open question.
- **Placeholder scan:** no `TODO`/`TBD`/`FIXME`/`<...>`/`XXX` in any new or modified code; every step shows complete code; every command has expected output.
- **Task granularity / touched-file sets:** 3 tasks total. Task 1 groups two tightly-coupled file-pairs (shared helper + its test; subscriber fix + its test) into one review round since they are one coherent change with a single root cause. Task 2 is a separate, independently reviewable concern (data-repair tooling) that only depends on Task 1's already-merged helper file. Task 3 is the standard final gate, no new code. Each task's Files section lists the exact touched-file set up front.
- **Never-throw / workflow-mutation rules preserved:** Task 1's new query/derivation logic stays inside `order-updated.ts`'s existing outer `try` block; no direct DB mutation is added (the script's only mutation path is the existing `syncOrderEditToOngoing` / `markOrderSyncEditBlockedWorkflow` workflows, invoked transitively via the unchanged `orderUpdatedHandler`).
