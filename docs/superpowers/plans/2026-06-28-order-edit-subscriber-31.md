# Ongoing Warehouse Plugin — `order-edit.confirmed` Line-Items Edit Re-sync Subscriber (#31) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `src/subscribers/order-edit-confirmed.ts` subscriber that, when a Medusa order edit is confirmed with **line-item / shipping** changes, re-syncs each affected `OngoingOrderSync` row to Ongoing via `syncOrderEditToOngoing` (#27) with `category: "line_items"` — but only when the order's cached Ongoing status code permits it per `edit_sync_rules.line_items`; otherwise it skips and emits a warning event. The handler never throws and is idempotent.

**Architecture:** Medusa's order-edit confirmation emits **`order-edit.confirmed`** (`OrderEditWorkflowEvents.CONFIRMED`) with payload `{ order_id, actions }` where `actions` is an array of `OrderChangeActionDTO` carried **directly on the event** — no extra query. For `order-edit.confirmed`, those actions are **only** line-item / shipping action types (`ITEM_ADD`, `ITEM_UPDATE`, `ITEM_REMOVE`, `SHIPPING_ADD`, `SHIPPING_UPDATE`, `SHIPPING_REMOVE` from `ChangeActionType`); address / billing / email / contact changes never appear here (they flow through `order.updated` → **#54**). So this subscriber classifies presence of any `ITEM_*`/`SHIPPING_*` action as the **`line_items`** edit category, lists the `OngoingOrderSync` rows for `event.data.order_id` (0..N — one per fulfillment), and for each row gates `latest_status_code` against the integration's `edit_sync_rules.line_items`. Allowed → run `syncOrderEditToOngoing` for that row; blocked → emit `ongoing.sync.edit_blocked` and skip; no relevant actions or no sync rows → no-op. Everything is wrapped in a single outer try/catch so the handler never throws (spec §8), and re-sync is idempotent via Ongoing's `PUT /orders` upsert keyed by `orderNumber` (#27's workflow).

> **NOTE (M2 behavior, documented — not a bug):** In M2, `OngoingOrderSync.latest_status_code` is `NULL` until the status-poll milestone (M3/M4) populates it. When the status code is null/unknown, #27's `syncOrderEditToOngoing` returns **blocked** with reason `'status_unknown'` (skip + warn), so this subscriber conservatively emits the `ongoing.sync.edit_blocked` warning and skips re-sync. This is the **intended, documented M2 behavior** — the subscriber wiring and edit classification are still fully implemented and become active automatically once status polling lands. No code-logic change is required: the subscriber already routes to #27 and surfaces `blocked` as a warning. The `.run({ input })` call remains `syncOrderEditToOngoing(container).run({ input: { medusa_order_id, medusa_fulfillment_id, category: 'line_items' } })` (already correct).

This is the sibling of **#54** (`order.updated` → `address_contact`). Together #31 + #54 cover the two spec §8 `edit_sync_rules` categories: **#31 owns `line_items`**, **#54 owns `address_contact`**. This plan implements **only** the `line_items` path on `order-edit.confirmed` and never touches address/contact.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (mocked container, module service, workflow). No DB in unit tests.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Copy from `package.json`.
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes); resolved via `container.resolve(ONGOING_MODULE)` from `src/modules/ongoing/index.ts`.
- Subscribers live in `src/subscribers/`; one file per concern; file-based discovery.
- **Subscribers never throw** — log + emit a warning event on error; complete gracefully (spec §8).
- Subscribers are **idempotent** (re-sync is the idempotent `PUT /orders` upsert). The event payload carries `{ order_id, actions }`; sync rows are re-loaded from `order_id` (spec §8).
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100. (The mapper inside #27/#26 owns this; this subscriber never touches prices.)
- This is a **plugin**, not an app: no local Postgres/Medusa instance is wired here, so tests are **pure unit tests** (mocked container/service/workflow). Wiring correctness is verified by `yarn build`.
- TDD: a failing Jest unit test is written and run (and seen to fail) before the implementation in every behavior task.
- **Depends on #27** — this subscriber calls `syncOrderEditToOngoing`. The exact consumed contract is pinned in the section below; the unit tests mock the workflow so the subscriber builds and is verified independently of #27's internals.

---

## File Structure

**Create:**
- `src/subscribers/order-edit-confirmed.ts` — the `order-edit.confirmed` subscriber (default-export handler + `config`).
- `src/subscribers/__tests__/order-edit-confirmed.test.ts` — unit tests (mocked container, service, workflow).

**No other files are modified.** (`jest.config.js`, the `test` script, the `ongoing` module/service, and `syncOrderEditToOngoing` already exist or are provided by #27.)

### Contract this subscriber depends on (from #27)

#27's `syncOrderEditToOngoing` (see `docs/superpowers/plans/2026-06-28-syncordereditoongoing-27.md`) is a `createWorkflow` whose **input is `GateInput`**:

```ts
// src/workflows/sync-order-edit-to-ongoing.ts  (delivered by #27)
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"

// GateInput (from #27's src/workflows/steps/gate-order-edit.ts):
//   { medusa_order_id: string; medusa_fulfillment_id?: string | null;
//     category: "address_contact" | "line_items" }
//
// Invoked like every Medusa workflow:
await syncOrderEditToOngoing(container).run({
  input: {
    medusa_order_id: string,
    medusa_fulfillment_id: string | null,
    category: "line_items",
  },
})
```

> **Signature note (load-bearing):** #27's workflow input is `{ medusa_order_id, medusa_fulfillment_id?, category }` — it gates by **fulfillment id** when present (each `OngoingOrderSync` row is per-fulfillment), falling back to `medusa_order_id`. This subscriber therefore passes each row's `medusa_fulfillment_id` (which is the load-bearing field that selects the right row inside #27's gate step) plus `medusa_order_id` and `category: "line_items"`. (#54's plan drafted a `ongoing_order_sync_id` field; #27 as planned does **not** accept that — code against #27's actual `GateInput` above. If #27 merged with a different input shape, adjust ONLY the `.run({ input })` call to match #27's real exported `GateInput`; the subscriber's per-row, `category: "line_items"` behavior is unchanged.)

---

## Task 1: `order-edit.confirmed` subscriber — happy path (line-item change, allowed status → re-sync per row)

**Files:**
- Create: `src/subscribers/order-edit-confirmed.ts`
- Test: `src/subscribers/__tests__/order-edit-confirmed.test.ts`

**Interfaces:**
- Consumes:
  - `SubscriberArgs<{ order_id: string; actions: OrderChangeActionDTO[] }>` and `SubscriberConfig` from `@medusajs/framework`.
  - `ONGOING_MODULE` from `../modules/ongoing`; the module service resolved as `container.resolve(ONGOING_MODULE)`. Used: `listOngoingOrderSyncs({ medusa_order_id })` (auto-CRUD list; `medusa_order_id` is a stored column on the module's own `OngoingOrderSync` model — same-module filter, no cross-module query) and `retrieveOngoingIntegration(id)` (auto-CRUD retrieve) for each row's `edit_sync_rules`.
  - `OngoingOrderSync` fields read: `id`, `medusa_fulfillment_id`, `integration_id`, `latest_status_code`. `OngoingIntegration` field read: `edit_sync_rules` (JSON: `{ [category]: number[] }`).
  - `container.resolve("event_bus")` → `emitEvent(...)` for the warning event.
  - `syncOrderEditToOngoing` workflow (see contract above).
- Produces:
  - default export `async function orderEditConfirmedHandler({ event, container }: SubscriberArgs<{ order_id: string; actions: OrderChangeActionDTO[] }>): Promise<void>`.
  - `export const config: SubscriberConfig = { event: "order-edit.confirmed" }`.
  - `const LINE_ITEM_ACTION_TYPES: Set<string>` — the `ChangeActionType` values classified as the `line_items` category.
  - Behavior: when `event.data.actions` contains any `ITEM_*`/`SHIPPING_*` action, for each `OngoingOrderSync` row of `order_id` whose integration's `edit_sync_rules.line_items` includes the row's `latest_status_code`, runs `syncOrderEditToOngoing(container).run({ input: { medusa_order_id: order_id, medusa_fulfillment_id: row.medusa_fulfillment_id ?? null, category: "line_items" } })`.

- [ ] **Step 1: Write the failing test for the happy path**

Create `src/subscribers/__tests__/order-edit-confirmed.test.ts`:
```ts
import orderEditConfirmedHandler from "../order-edit-confirmed"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))

const runMock = jest.fn().mockResolvedValue({ result: {} })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

// Builds a container whose resolve() returns logger / event_bus / the ongoing
// module service. The service's retrieveOngoingIntegration returns the
// edit_sync_rules keyed by integration id.
function makeContainer(opts: {
  syncRows: Array<{
    id: string
    medusa_fulfillment_id: string | null
    integration_id: string
    latest_status_code: number | null
  }>
  editSyncRules: Record<string, { edit_sync_rules: Record<string, number[]> | null }>
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emitEvent = jest.fn().mockResolvedValue(undefined)
  const service = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.syncRows),
    retrieveOngoingIntegration: jest.fn(async (id: string) => {
      const found = opts.editSyncRules[id]
      if (!found) {
        throw new Error(`no integration ${id}`)
      }
      return { id, ...found }
    }),
  }
  const container = {
    resolve: jest.fn((name: string) => {
      if (name === "logger") return logger
      if (name === "event_bus") return { emitEvent }
      return service // module id "ongoing"
    }),
  }
  return { container, logger, emitEvent, service }
}

const event = (order_id: string, actionTypes: string[]) =>
  ({
    event: {
      eventName: "order-edit.confirmed",
      data: {
        order_id,
        actions: actionTypes.map((action, i) => ({ id: `act_${i}`, action })),
      },
    },
  } as any)

beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
})

describe("order-edit.confirmed subscriber — line_items re-sync", () => {
  it("re-syncs each sync row with category line_items when status is allowed", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
        { id: "oos_2", medusa_fulfillment_id: "ful_2", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        category: "line_items",
      },
    })
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
        category: "line_items",
      },
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: FAIL — cannot find module `../order-edit-confirmed`.

- [ ] **Step 3: Implement the subscriber**

Create `src/subscribers/order-edit-confirmed.ts`:
```ts
import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"

// ChangeActionType values that order-edit.confirmed carries: only line-item /
// shipping mutations appear on this event (address/contact/email go through
// order.updated -> #54). We classify any of these as the spec §8 "line_items"
// edit category. See spec §13.3 — verify this set against a live order-edit
// during integration testing; the exact enum strings are ITEM_*/SHIPPING_*.
const LINE_ITEM_ACTION_TYPES = new Set<string>([
  "ITEM_ADD",
  "ITEM_UPDATE",
  "ITEM_REMOVE",
  "SHIPPING_ADD",
  "SHIPPING_UPDATE",
  "SHIPPING_REMOVE",
])

type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  integration_id: string
  latest_status_code: number | null
}

type OrderChangeAction = { action?: string }

export default async function orderEditConfirmedHandler({
  event,
  container,
}: SubscriberArgs<{ order_id: string; actions: OrderChangeAction[] }>): Promise<void> {
  const logger = container.resolve("logger")
  const orderId = event.data.order_id

  try {
    // 1. Classify the edit from actions[] (carried directly on the event).
    //    order-edit.confirmed only contains ITEM_*/SHIPPING_* actions; we keep
    //    this filter defensive so unexpected action types are ignored.
    const actions = event.data.actions ?? []
    const hasLineItemChange = actions.some(
      (a) => typeof a?.action === "string" && LINE_ITEM_ACTION_TYPES.has(a.action)
    )

    if (!hasLineItemChange) {
      const seen = actions.map((a) => a?.action).filter(Boolean).join(", ")
      logger.info(
        `[ongoing] order-edit.confirmed for ${orderId}: no line-item/shipping change (actions: ${seen || "none"}), skipping`
      )
      return
    }

    // 2. Resolve the OngoingOrderSync rows for this order (0..N, one per fulfillment).
    const service = container.resolve(ONGOING_MODULE)
    const syncRows: OngoingOrderSyncRow[] = await service.listOngoingOrderSyncs({
      medusa_order_id: orderId,
    })

    if (!syncRows.length) {
      logger.info(`[ongoing] order-edit.confirmed for ${orderId}: no sync rows, skipping`)
      return
    }

    const eventBus = container.resolve("event_bus")

    // 3. For each sync row, gate on edit_sync_rules.line_items and re-sync.
    for (const row of syncRows) {
      const integration = await service.retrieveOngoingIntegration(row.integration_id)
      const rules: Record<string, number[]> | null = integration?.edit_sync_rules ?? null
      const allowedCodes = rules?.line_items ?? []
      const code = row.latest_status_code

      const allowed =
        code !== null && code !== undefined && allowedCodes.includes(code)

      if (!allowed) {
        logger.warn(
          `[ongoing] order-edit.confirmed for ${orderId}: line_items edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
        )
        await eventBus.emitEvent({
          name: "ongoing.sync.edit_blocked",
          data: {
            medusa_order_id: orderId,
            ongoing_order_sync_id: row.id,
            category: "line_items",
            latest_status_code: code,
          },
        })
        continue
      }

      await syncOrderEditToOngoing(container).run({
        input: {
          medusa_order_id: orderId,
          medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
          category: "line_items",
        },
      })
      logger.info(
        `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
      )
    }
  } catch (error) {
    // Subscribers never throw (spec §8): log + record, complete gracefully.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      `[ongoing] order-edit.confirmed handler failed for ${orderId}: ${message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order-edit.confirmed",
}
```

> NOTE (spec §13.3 verify-point): the exact `ChangeActionType` enum string values for line-item/shipping mutations in 2.16.0 are confirmed as `ITEM_ADD`/`ITEM_UPDATE`/`ITEM_REMOVE`/`SHIPPING_ADD`/`SHIPPING_UPDATE`/`SHIPPING_REMOVE`. Verify against a live confirmed order-edit during integration testing. If any string differs, the only edit is `LINE_ITEM_ACTION_TYPES`; the gating and per-row re-sync logic are unaffected.
>
> NOTE (event payload): `order-edit.confirmed` carries `actions` **directly on `event.data`** (`OrderEditWorkflowEvents.CONFIRMED`, payload `{ order_id, actions }`) — no re-query is needed to classify the edit, unlike #54's `order.updated` (which carries only `{ id }`).
>
> NOTE (event bus): if `container.resolve("event_bus")` is unavailable in a given runtime, the outer try/catch prevents a throw; the re-sync path for allowed rows runs before any blocked row needs the bus, so a missing bus never blocks an allowed re-sync from a prior row.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: PASS (1 test — `runMock` called twice with `category: "line_items"` and the per-row `medusa_fulfillment_id`).

- [ ] **Step 5: Commit**

```bash
git add src/subscribers/order-edit-confirmed.ts src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "feat(ongoing-subscribers): order-edit.confirmed line_items edit re-sync (allowed-status path) (#31)"
```

---

## Task 2: No-op when actions contain no line-item/shipping change

**Files:**
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + `makeContainer`/`event` helpers from Task 1. No production changes — Task 1's `hasLineItemChange` guard already implements this; this task pins it with a test (an empty/unrecognized `actions[]` short-circuits before listing sync rows).

- [ ] **Step 1: Write the test for the no-relevant-action no-op**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, add inside the `describe` block:
```ts
  it("no-ops when actions contain no line-item/shipping change", async () => {
    const { container, service } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    // An action type we do not classify as line_items (defensive filter).
    await orderEditConfirmedHandler({ ...event("order_1", ["SOMETHING_ELSE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    // Short-circuits before loading sync rows.
    expect(service.listOngoingOrderSyncs).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts -t "no line-item/shipping change"`
Expected: PASS (the `hasLineItemChange` guard returns early before listing sync rows).

> If it FAILS, the guard ordering in Task 1 is wrong: the action classification must run and short-circuit **before** `listOngoingOrderSyncs`. Fix the ordering in `src/subscribers/order-edit-confirmed.ts`, then re-run.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "test(ongoing-subscribers): order-edit.confirmed no-ops without line-item actions (#31)"
```

---

## Task 3: Blocked status emits a warning event and does not re-sync

**Files:**
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + helpers from Task 1. No production changes — Task 1's gating branch already emits `ongoing.sync.edit_blocked` and `continue`s; this task pins it.

- [ ] **Step 1: Write the test for the blocked-status path**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, add inside the `describe` block:
```ts
  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emitEvent } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 999 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } }, // 999 not allowed
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_ADD"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "line_items",
        latest_status_code: 999,
      },
    })
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts -t "emits a warning event"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "test(ongoing-subscribers): order-edit.confirmed emits edit_blocked warning on disallowed status (#31)"
```

---

## Task 4: Zero sync rows is a no-op

**Files:**
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler + helpers from Task 1. No production changes — Task 1's `if (!syncRows.length) return` already implements this; this task pins it.

- [ ] **Step 1: Write the test for the zero-sync-rows path**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, add inside the `describe` block:
```ts
  it("no-ops when there are no sync rows for the order", async () => {
    const { container, emitEvent } = makeContainer({
      syncRows: [],
      editSyncRules: {},
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_REMOVE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts -t "no sync rows for the order"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "test(ongoing-subscribers): order-edit.confirmed no-ops with zero sync rows (#31)"
```

---

## Task 5: Handler never throws on error

**Files:**
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts` (add a test)

**Interfaces:**
- Consumes: the handler from Task 1. No production changes — Task 1's outer `try/catch` already implements this; this task pins it by forcing the workflow `run` to reject and asserting the handler resolves (does not reject) and logs an error.

- [ ] **Step 1: Write the test for the never-throws guarantee**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, add inside the `describe` block:
```ts
  it("never throws when the workflow run fails (logs error instead)", async () => {
    const { container, logger } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    // Force the re-sync workflow to blow up.
    runMock.mockRejectedValueOnce(new Error("boom"))

    await expect(
      orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("order-edit.confirmed handler failed for order_1: boom")
    )
  })
```

- [ ] **Step 2: Run the test**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts -t "never throws"`
Expected: PASS (handler resolves to `undefined`; `logger.error` called with the message).

- [ ] **Step 3: Run the full subscriber suite**

Run: `yarn test src/subscribers`
Expected: PASS (all 5 `order-edit.confirmed` tests green, plus any #54 `order-updated` tests if present).

- [ ] **Step 4: Commit**

```bash
git add src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "test(ongoing-subscribers): order-edit.confirmed handler never throws on error (#31)"
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
Expected: all suites PASS (lib + module + workflow + subscriber tests).

- [ ] **Step 2: Build the plugin**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; the subscriber appears under `.medusa/server`.

> If the build fails on the `../workflows/sync-order-edit-to-ongoing` import, #27 is not merged yet. Either rebase onto the branch that delivers #27, or temporarily stub the workflow matching the contract in the header — but **do not** merge #31 ahead of #27; #31 depends on it.

- [ ] **Step 3: Commit (only if any fix was needed)**

```bash
git add -A
git commit -m "fix(ongoing-subscribers): align order-edit.confirmed subscriber with build (#31)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (#31 slice of §8):** subscriber on `order-edit.confirmed` ✓ (Task 1); classifies the `line_items` category from `event.data.actions[].action ∈ ITEM_*/SHIPPING_*` ✓ (Task 1, §8 step 2 + §13.3 verify-point); resolves `OngoingOrderSync` rows by `medusa_order_id` (0..N, one per fulfillment) and reads `latest_status_code` ✓ (Task 1); consults `edit_sync_rules.line_items` per row's integration ✓ (Task 1); allowed → `syncOrderEditToOngoing` (#27, `category 'line_items'`, per row's `medusa_fulfillment_id`) ✓ (Task 1); blocked → skip + warning event ✓ (Task 3); no relevant actions → no-op ✓ (Task 2); zero rows → no-op ✓ (Task 4); never throws, idempotent (upsert), reads from the `{ order_id, actions }` payload ✓ (Tasks 1, 5). Address/contact edits are **#54's** scope (on `order.updated`) — intentionally excluded here (this subscriber never reads or routes `address_contact`).
- **Verified-research alignment:** event is `order-edit.confirmed` (`OrderEditWorkflowEvents.CONFIRMED`) with payload `{ order_id, actions }`; actions are carried directly on the event (no re-query) ✓; `order-edit.confirmed` actions are exclusively `ITEM_*`/`SHIPPING_*` (address/contact never appear) ✓, so #31 classifies only the `line_items` category.
- **Sibling alignment (#54):** #31 owns `line_items` on `order-edit.confirmed`; #54 owns `address_contact` on `order.updated`. Both emit the same `ongoing.sync.edit_blocked` event name/shape for the admin widget, differing only in `category`. No overlap.
- **#27 contract alignment:** code against #27's actual exported `GateInput` `{ medusa_order_id, medusa_fulfillment_id?, category }` (from `docs/superpowers/plans/2026-06-28-syncordereditoongoing-27.md`), passing the per-row `medusa_fulfillment_id` so #27's gate step selects the correct sync row. (#54's draft `ongoing_order_sync_id` field is **not** #27's input; the signature note in the header records this divergence and the single adjustment point if #27 merged differently.)
- **Placeholder scan:** every code step contains full, runnable code. The three NOTE callouts (`ChangeActionType` strings per §13.3; payload-carries-actions; event-bus availability) plus the #27 signature note are explicit verify/scope points with stated resolutions, not missing content.
- **Type consistency:** `orderEditConfirmedHandler` signature, `config`, `ONGOING_MODULE`, `listOngoingOrderSyncs({ medusa_order_id })`, `retrieveOngoingIntegration(id)`, `syncOrderEditToOngoing(container).run({ input: { medusa_order_id, medusa_fulfillment_id, category } })`, the `ongoing.sync.edit_blocked` event name/shape, and `LINE_ITEM_ACTION_TYPES` are used identically across the subscriber and all five tests.
- **Query correctness:** `listOngoingOrderSyncs({ medusa_order_id })` and `retrieveOngoingIntegration(id)` are same-module auto-CRUD methods filtering stored columns on the module's own models — no cross-module `query.graph` filtering is attempted (per spec §4 link note).

## Known verify-points carried to integration testing (later, when a test app exists)
- Exact `ChangeActionType` enum strings for line-item/shipping mutations in 2.16.0 (spec §13.3) — Task 1 NOTE; the `LINE_ITEM_ACTION_TYPES` constant isolates the change.
- The #27 `syncOrderEditToOngoing` export name + `GateInput` shape — header signature note; adjust only the `.run({ input })` call if #27 merged differently.
- Event-bus resolution token (`event_bus`) in the plugin runtime — Task 1 NOTE.
