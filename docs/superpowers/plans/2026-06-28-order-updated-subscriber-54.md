# Ongoing Warehouse Plugin — `order.updated` Edit Re-sync Subscriber (#54) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `src/subscribers/order-updated.ts` subscriber that, when an order's address / billing / contact / email is edited in Medusa, re-syncs the order to Ongoing via `syncOrderEditToOngoing` (#27) — but only when the order's cached Ongoing status code permits it per `edit_sync_rules.address_contact`.

**Architecture:** The Medusa `updateOrderWorkflow` (Admin `POST /admin/orders/:id`) registers `update_order` order-change actions with `details.type ∈ { shipping_address, billing_address, email, metadata, locale }` and emits `order.updated` with payload `{ id }` only (no `actions` array). The subscriber re-loads context from `event.data.id`: it inspects the latest `update_order` order-change's action `details.type` values to decide whether an address/contact/email field actually changed, classifies that as the `address_contact` edit category, then for each `OngoingOrderSync` row of that order checks `latest_status_code` against the integration's `edit_sync_rules.address_contact` allow-list. Allowed → run `syncOrderEditToOngoing`; blocked → emit a warning event and skip; metadata/locale-only or no sync rows → no-op. The handler never throws (try/catch around everything) and is idempotent (re-sync uses Ongoing's `PUT /orders` upsert keyed by `orderNumber`).

This pairs with **#31** (line-items edit re-sync on `order-edit.confirmed`); together #54 + #31 cover the two spec §8 `edit_sync_rules` categories (`address_contact` and `line_items`). #54 owns `address_contact`; #31 owns `line_items`. This plan implements **only** the `address_contact` path on `order.updated`.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (mocked container, service, workflow, and `query.graph`). No DB in unit tests.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes).
- Subscribers live in `src/subscribers/`; one file per concern; file-based discovery.
- **Subscribers never throw** — log + emit a warning event on error; complete gracefully (spec §8).
- Subscribers are **idempotent** and re-query full data from the `{ id }`-style event payload (spec §8).
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100.
- This is a **plugin**, not an app: no local Postgres/Medusa instance is wired here, so tests are **pure unit tests** (mocked container/service/workflow/query). Wiring correctness is verified by `yarn build`.
- TDD: a failing Jest unit test is written and run (and seen to fail) before the implementation in every behavior task.
- **Dependency:** this subscriber calls `syncOrderEditToOngoing` from issue **#27**. If #27 is not yet merged when implementing, see Task 1 for the exact import contract to code against; the unit tests mock the workflow so the subscriber can be built and verified independently of #27's internals.

---

## File Structure

**Create:**
- `src/subscribers/order-updated.ts` — the `order.updated` subscriber (default-export handler + `config`).
- `src/subscribers/__tests__/order-updated.test.ts` — unit tests (mocked container, service, workflow, query).

**No other files are modified.** (`jest.config.js`, the `test` script, the `ongoing` module/service, and `syncOrderEditToOngoing` already exist or are provided by #27.)

### Contract this subscriber depends on (from #27)

The subscriber imports and runs the `syncOrderEditToOngoing` workflow. Code against this exact signature; the tests mock it via `jest.mock`:

```ts
// src/workflows/sync-order-edit-to-ongoing.ts  (delivered by #27)
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"

// Invoked like every Medusa workflow.
// Per-row targeting is done by passing `medusa_fulfillment_id` for the specific
// sync row (this is how #31 does it). There is NO `ongoing_order_sync_id` input —
// #27 ignores it, so multi-row orders would mis-target if you passed it.
await syncOrderEditToOngoing(container).run({
  input: {
    medusa_order_id: string,
    medusa_fulfillment_id?: string | null,
    category: "address_contact" | "line_items",
  },
})
```

> NOTE (verify at implementation time): confirm the #27 export name and `input` shape against the merged `src/workflows/sync-order-edit-to-ongoing.ts`. If #27 named the export or input fields differently, adjust the import and the `.run({ input })` call to match — the subscriber's logic (which rows to sync, with which `category`) does not change. The tests pin the `category: "address_contact"` argument and per-row invocation, which is the load-bearing behavior #54 owns.
>
> NOTE (M2 status-gate reality): in M2, `latest_status_code` is NULL until the status-poll milestone, so the `address_contact` gate returns blocked/`status_unknown` (skip + warn) for every row until codes populate. This is intended, documented M2 behavior — the wiring is fully implemented; it simply gates closed until status codes exist.

---

## Task 1: `order.updated` subscriber — happy path (address/contact change, allowed status → re-sync per row)

**Files:**
- Create: `src/subscribers/order-updated.ts`
- Test: `src/subscribers/__tests__/order-updated.test.ts`

**Interfaces:**
- Consumes:
  - `SubscriberArgs<{ id: string }>`, `SubscriberConfig` from `@medusajs/framework`.
  - `ONGOING_MODULE` from `../modules/ongoing` and `OngoingModuleService` resolved as `container.resolve(ONGOING_MODULE)`. Used: `listOngoingOrderSyncs({ medusa_order_id })` (auto-CRUD list; `medusa_order_id` is a stored column so this is a same-module filter — no cross-module query needed) and `getIntegrationByLocation` is **not** used here (the integration is loaded by id from the sync row, see below).
  - `container.resolve("query")` → `query.graph(...)` to load the order-change `update_order` action `details.type` values, and to load each sync row's integration `edit_sync_rules`.
  - `container.resolve("event_bus")` → `emitEvent(...)` for the warning event.
  - `syncOrderEditToOngoing` workflow (see contract above).
- Produces:
  - default export `async function orderUpdatedHandler({ event, container }: SubscriberArgs<{ id: string }>): Promise<void>`.
  - `export const config: SubscriberConfig = { event: "order.updated" }`.
  - Behavior: for an order whose latest `update_order` order-change touched `shipping_address` / `billing_address` / `email`, for each `OngoingOrderSync` row whose integration's `edit_sync_rules.address_contact` includes the row's `latest_status_code`, runs `syncOrderEditToOngoing(container).run({ input: { medusa_order_id, medusa_fulfillment_id: row.medusa_fulfillment_id ?? null, category: "address_contact" } })`. Per-row targeting is via `medusa_fulfillment_id` (mirrors #31); #27 ignores `ongoing_order_sync_id`, so it must not be passed.

- [ ] **Step 1: Write the failing test for the happy path**

Create `src/subscribers/__tests__/order-updated.test.ts`:
```ts
import orderUpdatedHandler from "../order-updated"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))

const runMock = jest.fn().mockResolvedValue({ result: {} })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

type GraphCall = { entity: string }

// Builds a container whose query.graph returns:
//  - for entity "order_change": the latest update_order change with the given detail types
//  - for entity "ongoing_integration": the integration with the given edit_sync_rules
function makeContainer(opts: {
  detailTypes: string[]
  syncRows: Array<{
    id: string
    integration_id: string
    latest_status_code: number | null
    medusa_fulfillment_id: string | null
  }>
  editSyncRules: Record<string, Record<string, number[]>> // integration_id -> { address_contact: number[] }
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emitEvent = jest.fn().mockResolvedValue(undefined)
  const service = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.syncRows),
  }
  const query = {
    graph: jest.fn(async ({ entity }: GraphCall) => {
      if (entity === "order_change") {
        return {
          data: [
            {
              id: "ordch_1",
              change_type: "update_order",
              created_at: "2026-06-28T10:00:00.000Z",
              actions: opts.detailTypes.map((type, i) => ({
                id: `act_${i}`,
                details: { type },
              })),
            },
          ],
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
    resolve: jest.fn((name: string) => {
      if (name === "logger") return logger
      if (name === "query") return query
      if (name === "event_bus") return { emitEvent }
      // module id "ongoing"
      return service
    }),
  }
  return { container, logger, emitEvent, service, query }
}

const event = (id: string) => ({ event: { eventName: "order.updated", data: { id } } } as any)

beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
})

describe("order.updated subscriber — address/contact re-sync", () => {
  it("re-syncs each sync row with category address_contact when status is allowed", async () => {
    const { container } = makeContainer({
      detailTypes: ["shipping_address"],
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
        category: "address_contact",
      },
    })
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
        category: "address_contact",
      },
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: FAIL — cannot find module `../order-updated` (and `../../workflows/sync-order-edit-to-ongoing` if #27 not yet present; if so, create the test's mock target as described in Step 3's NOTE).

- [ ] **Step 3: Implement the subscriber**

Create `src/subscribers/order-updated.ts`:
```ts
import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"

// Order-change action detail types (set by Medusa's updateOrderWorkflow) that we
// classify as the spec §8 "address_contact" edit category. See spec §13.3 — verify
// this set against a live `update_order` order-change during integration testing.
const ADDRESS_CONTACT_DETAIL_TYPES = new Set([
  "shipping_address",
  "billing_address",
  "email",
  "contact",
])

type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  latest_status_code: number | null
  medusa_fulfillment_id: string | null
}

export default async function orderUpdatedHandler({
  event,
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve("logger")
  const orderId = event.data.id

  try {
    const query = container.resolve("query")

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

    // 2. Resolve the OngoingOrderSync rows for this order (0..N).
    const service = container.resolve(ONGOING_MODULE)
    const syncRows: OngoingOrderSyncRow[] = await service.listOngoingOrderSyncs(
      { medusa_order_id: orderId },
      {
        // medusa_fulfillment_id is required for per-row targeting of #27's gate
        // workflow (passed as input.medusa_fulfillment_id, mirroring #31).
        select: [
          "id",
          "integration_id",
          "latest_status_code",
          "medusa_fulfillment_id",
        ],
      }
    )

    if (!syncRows.length) {
      logger.info(`[ongoing] order.updated for ${orderId}: no sync rows, skipping`)
      return
    }

    // 3. Load the edit_sync_rules for the integrations referenced by the rows.
    const integrationIds = [...new Set(syncRows.map((r) => r.integration_id))]
    const { data: integrations } = await query.graph({
      entity: "ongoing_integration",
      fields: ["id", "edit_sync_rules"],
      filters: { id: integrationIds },
    })
    const rulesByIntegration = new Map<string, Record<string, number[]> | null>(
      (integrations ?? []).map(
        (i: { id: string; edit_sync_rules?: Record<string, number[]> | null }) => [
          i.id,
          i.edit_sync_rules ?? null,
        ]
      )
    )

    const eventBus = container.resolve("event_bus")

    // 4. For each sync row, gate on edit_sync_rules.address_contact and re-sync.
    for (const row of syncRows) {
      const rules = rulesByIntegration.get(row.integration_id)
      const allowedCodes = rules?.address_contact ?? []
      const code = row.latest_status_code

      const allowed =
        code !== null && code !== undefined && allowedCodes.includes(code)

      if (!allowed) {
        logger.warn(
          `[ongoing] order.updated for ${orderId}: address_contact edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
        )
        await eventBus.emitEvent({
          name: "ongoing.sync.edit_blocked",
          data: {
            medusa_order_id: orderId,
            ongoing_order_sync_id: row.id,
            category: "address_contact",
            latest_status_code: code,
          },
        })
        continue
      }

      await syncOrderEditToOngoing(container).run({
        input: {
          medusa_order_id: orderId,
          // Per-row targeting via fulfillment id (mirrors #31); #27 ignores
          // ongoing_order_sync_id, so passing it would mis-target multi-row orders.
          medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
          category: "address_contact",
        },
      })
      logger.info(
        `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
      )
    }
  } catch (error) {
    // Subscribers never throw (spec §8): log + record, complete gracefully.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[ongoing] order.updated handler failed for ${orderId}: ${message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.updated",
}
```

> NOTE (spec §13.3 verify-point): the exact order-change record shape — entity name `order_change`, `change_type: "update_order"`, and the action `details.type` values for address/billing/email edits in 2.16.0 — is an implementation-time verification point. Plan against `details.type ∈ { shipping_address, billing_address, email }` (plus `contact` defensively). If the live entity/field names differ, the only edits are the `query.graph` entity/fields/filters in step 1 and `ADDRESS_CONTACT_DETAIL_TYPES`; the gating and per-row re-sync logic are unaffected.
>
> NOTE (event bus): if `container.resolve("event_bus")` is unavailable in a given runtime, resolve it lazily / guard with try/catch so a missing bus never breaks the re-sync path. The outer try/catch already prevents a throw.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: PASS (1 test — `runMock` called twice with `category: "address_contact"`).

- [ ] **Step 5: Commit**

```bash
git add src/subscribers/order-updated.ts src/subscribers/__tests__/order-updated.test.ts
git commit -m "feat(ongoing-subscribers): order.updated address_contact edit re-sync (allowed-status path) (#54)"
```

---

## Task 2: No-op when only metadata/locale changed

**Files:**
- Modify: `src/subscribers/__tests__/order-updated.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + `makeContainer` helper from Task 1. No production changes — Task 1's `hasAddressContactChange` guard already implements this; this task pins it with a test.

- [ ] **Step 1: Write the failing-then-passing test for the metadata/locale no-op**

In `src/subscribers/__tests__/order-updated.test.ts`, add inside the `describe` block:
```ts
  it("no-ops when only metadata/locale changed (no relevant detail type)", async () => {
    const { container } = makeContainer({
      detailTypes: ["metadata", "locale"],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    // Did not even need to load sync rows.
    expect(container.resolve("ongoing").listOngoingOrderSyncs).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts -t "no-ops when only metadata"`
Expected: PASS (the `hasAddressContactChange` guard returns early before listing sync rows).

> If it FAILS, the guard ordering in Task 1 is wrong: the address/contact detection must run and short-circuit **before** `listOngoingOrderSyncs`. Fix the ordering in `src/subscribers/order-updated.ts`, then re-run.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-updated.test.ts
git commit -m "test(ongoing-subscribers): order.updated no-ops on metadata/locale-only edits (#54)"
```

---

## Task 3: Blocked status emits a warning event and does not re-sync

**Files:**
- Modify: `src/subscribers/__tests__/order-updated.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + helpers from Task 1. No production changes — Task 1's gating branch already emits `ongoing.sync.edit_blocked` and `continue`s; this task pins it.

> NOTE (M2 status-gate reality): in M2, `latest_status_code` is NULL until the status-poll milestone, so the `address_contact` gate returns blocked/`status_unknown` (skip + warn) for *every* row until codes populate. This blocked-status path is therefore the *default* M2 behavior, not an edge case — intended and documented; the wiring is fully implemented and simply gates closed until status codes exist. This test exercises the same branch with an explicit disallowed code.

- [ ] **Step 1: Write the test for the blocked-status path**

In `src/subscribers/__tests__/order-updated.test.ts`, add inside the `describe` block:
```ts
  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emitEvent } = makeContainer({
      detailTypes: ["billing_address"],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 999, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // 999 not allowed
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 999,
      },
    })
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts -t "emits a warning event"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-updated.test.ts
git commit -m "test(ongoing-subscribers): order.updated emits edit_blocked warning on disallowed status (#54)"
```

---

## Task 4: Zero sync rows is a no-op

**Files:**
- Modify: `src/subscribers/__tests__/order-updated.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + helpers from Task 1. No production changes — Task 1's `if (!syncRows.length) return` already implements this; this task pins it.

- [ ] **Step 1: Write the test for the zero-sync-rows path**

In `src/subscribers/__tests__/order-updated.test.ts`, add inside the `describe` block:
```ts
  it("no-ops when there are no sync rows for the order", async () => {
    const { container, emitEvent } = makeContainer({
      detailTypes: ["shipping_address"],
      syncRows: [],
      editSyncRules: {},
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts -t "no sync rows for the order"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-updated.test.ts
git commit -m "test(ongoing-subscribers): order.updated no-ops with zero sync rows (#54)"
```

---

## Task 5: Handler never throws on error

**Files:**
- Modify: `src/subscribers/__tests__/order-updated.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler from Task 1. No production changes — Task 1's outer `try/catch` already implements this; this task pins it by forcing an internal failure and asserting the handler resolves (does not reject) and logs an error.

- [ ] **Step 1: Write the test for the never-throws guarantee**

In `src/subscribers/__tests__/order-updated.test.ts`, add inside the `describe` block:
```ts
  it("never throws when an internal call fails (logs error instead)", async () => {
    const { container, logger } = makeContainer({
      detailTypes: ["shipping_address"],
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
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts -t "never throws"`
Expected: PASS (handler resolves to `undefined`; `logger.error` called with the message).

- [ ] **Step 3: Run the full subscriber suite**

Run: `yarn test src/subscribers`
Expected: PASS (all 5 tests green).

- [ ] **Step 4: Commit**

```bash
git add src/subscribers/__tests__/order-updated.test.ts
git commit -m "test(ongoing-subscribers): order.updated handler never throws on error (#54)"
```

---

## Task 6: Build verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: everything above plus the merged #27 `syncOrderEditToOngoing` workflow.
- Produces: confirmation the subscriber compiles into the plugin build.

- [ ] **Step 1: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (lib + module + subscriber tests).

- [ ] **Step 2: Build the plugin**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; the subscriber appears under `.medusa/server`.

> If the build fails on the `../workflows/sync-order-edit-to-ongoing` import, #27 is not merged yet. Either rebase onto the branch that delivers #27, or temporarily create the workflow stub matching the contract in the header — but **do not** merge #54 ahead of #27; #54 depends on it.

- [ ] **Step 3: Commit (only if any fix was needed)**

```bash
git add -A
git commit -m "fix(ongoing-subscribers): align order.updated subscriber with build (#54)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (#54 slice of §8):** subscriber on order address/contact/email edits ✓ (Task 1); classifies the `address_contact` category from `update_order` order-change `details.type` ✓ (Task 1, §8 step 2 + §13.3 verify-point); resolves `OngoingOrderSync` rows by `medusa_order_id` (0..N) and reads `latest_status_code` ✓ (Task 1); consults `edit_sync_rules.address_contact` ✓ (Task 1); allowed → `syncOrderEditToOngoing` (#27, `category 'address_contact'`, per-row targeting via `medusa_fulfillment_id`) ✓ (Task 1); blocked → skip + warning event ✓ (Task 3 — and in M2 this is the *default* path since `latest_status_code` is NULL until the status-poll milestone: gate returns blocked/`status_unknown`, intended documented behavior); metadata/locale-only → no-op ✓ (Task 2); zero rows → no-op ✓ (Task 4); never throws, idempotent (upsert), re-queries from `{ id }` payload ✓ (Tasks 1, 5). Line-items edits are **#31's** scope (on `order-edit.confirmed`) — intentionally excluded here.
- **Verified-research alignment:** event is `order.updated` with payload `{ id }` only (no `actions`), so the handler re-queries the latest `update_order` order-change rather than reading `event.data.actions` ✓. `country_code` change rejection is upstream (`updateOrderValidationStep`) and out of this subscriber's concern ✓.
- **Placeholder scan:** every code step contains full code. The two NOTE callouts (order-change entity/detail-type shape per §13.3; event-bus availability) are explicit verify-points with the resolution method stated, plus the #27 import-contract NOTE — none are missing content.
- **Type consistency:** `orderUpdatedHandler` signature, `config`, `ONGOING_MODULE`, `listOngoingOrderSyncs({ medusa_order_id }, { select: [...] })` (selecting `medusa_fulfillment_id`), `syncOrderEditToOngoing(container).run({ input: { medusa_order_id, medusa_fulfillment_id, category } })` (per-row targeting via `medusa_fulfillment_id`, mirroring #31 — #27 ignores `ongoing_order_sync_id`), the `ongoing.sync.edit_blocked` event name/shape (the subscriber's own diagnostic event, which keeps `ongoing_order_sync_id` as a local row id), and `ADDRESS_CONTACT_DETAIL_TYPES` are used identically across the subscriber and all five tests.
- **Query correctness:** `listOngoingOrderSyncs({ medusa_order_id })` filters a stored column on the module's own model (same-module filter — allowed). `edit_sync_rules` is loaded via `query.graph` on `ongoing_integration` by `id` (same-module filter — allowed); no cross-module filtering is attempted (per spec §4 link note and the querying-data reference).

## Known verify-points carried to integration testing (later, when a test app exists)
- Order-change entity name / `change_type` / action `details.type` values for address/billing/email in 2.16.0 (spec §13.3) — Task 1 NOTE; mappers/constants isolate the change.
- The #27 `syncOrderEditToOngoing` export name + `input` shape — header NOTE. Per-row targeting is via `medusa_fulfillment_id` (mirrors #31); #27 ignores `ongoing_order_sync_id`.
- Event-bus resolution token (`event_bus`) in the plugin runtime — Task 1 NOTE.
