# Plan: Observability — structured logs, correlation ids, `ongoing.sync.*` events (#44)

## Problem

Spec §11 requires "structured logs with correlation ids (medusa order ⇄ ongoing order
number), success/failure counters, and `ongoing.sync.*` events feeding the dashboard"
(`docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:322-323`).

Today only **one** event exists — the literal string `"ongoing.sync.edit_blocked"`,
emitted ad hoc from `src/subscribers/order-updated.ts:127-135` and
`src/subscribers/order-edit-confirmed.ts:76-84`. Three step handlers that own the
highest-value correlation points have **zero logs**:
`src/workflows/steps/push-order-record-sync.ts`,
`src/workflows/steps/mark-order-sync-shipped.ts`,
`src/workflows/steps/cancel-ongoing-order.ts`. There is no single source of truth for
event names, so a future admin dashboard (owned by #40/#42/#43) or an external
subscriber has nothing typed to import.

## Scope (locked)

- **Owned here:** `src/lib/ongoing/events.ts` (the `ONGOING_EVENTS` const + typed
  payload interfaces), 7 new event emit sites, log-gap fill in 3 step handlers, and
  migrating the 2 existing `edit_blocked` emit sites onto the new const.
- **Not owned here:** admin scaffolding (`sdk.ts`, `page.tsx`, admin routes — #40/#42/#43).
- **Accepted event names** (flat `ongoing.sync.<snake_case>`, 8 total including the
  existing one):
  - `ongoing.sync.order_pushed`
  - `ongoing.sync.push_failed`
  - `ongoing.sync.shipment_applied`
  - `ongoing.sync.order_cancelled`
  - `ongoing.sync.order_retried`
  - `ongoing.sync.order_dead_lettered`
  - `ongoing.sync.inventory_synced`
  - `ongoing.sync.edit_blocked` (existing, migrated onto the const)
- **PII policy:** payloads and log messages carry IDs, status codes, and error classes
  only — never customer name/email/address/phone. Ongoing API error strings may be
  logged but prefer codes where available.
- **No `status_changed` event** on the status-poll job (per-tick per-order volume is
  unbounded) — explicitly out of scope.
- **Logger has no metadata argument** (`info(message: string): void`). Use a
  consistent inline `key=value` format, e.g.
  `[ongoing] push-order-record-sync: pushed medusa_order_id=<X> ongoing_order_number=<Y> integration_id=<Z>`.
- **Correlation ids:** order flows carry `medusa_order_id` + `ongoing_order_number`
  (+ `medusa_fulfillment_id`, `integration_id`); stock flows carry `integration_id` +
  `credential_key` + `stock_location_id`.
- **Emit inside the step handler, not via a separate `emitEventStep`.** Every new emit
  call in this plan lives inside an existing step's `invoke` function
  (`container.resolve(Modules.EVENT_BUS).emit(...)`), not as a trailing
  `emitEventStep(...)` appended to the workflow. This is safe specifically because in
  every case the emitting step is the **last step to run on its branch**:
  `pushOrderRecordSyncStep` is the terminal step of `push-order-to-ongoing`;
  `markOrderSyncShippedStep` is the terminal step of the `when(!skip)` branch in
  `sync-ongoing-shipment`. There is no later step whose compensation could roll back
  after the event has already fired, so there is no risk of a false
  `order_pushed`/`shipment_applied` surviving a subsequent failure. If a future change
  adds a step **after** either of these, re-evaluate whether the emit should move to a
  dedicated trailing `emitEventStep` instead.

## Baseline (verified before writing this plan)

This worktree's branch started 1 commit behind `origin/main` (missing the #38 merge,
`d9ce24f`) and has been fast-forwarded to `origin/main` at `d9ce24f` (which also
carries the #37/#39 merges). `src/jobs/retry-failed-syncs.ts` and
`src/jobs/stock-sync.ts` both exist at this baseline. **Branch off `origin/main`, not
an older local `main`, or these files will be missing.**

`yarn test` (`npx jest`, via a `node_modules` install/symlink) on this baseline:
**43 suites, 249 tests, all green.**

## Approach

### 1. `src/lib/ongoing/events.ts` (new) — single source of truth

```ts
export const ONGOING_EVENTS = {
  ORDER_PUSHED: "ongoing.sync.order_pushed",
  PUSH_FAILED: "ongoing.sync.push_failed",
  SHIPMENT_APPLIED: "ongoing.sync.shipment_applied",
  ORDER_CANCELLED: "ongoing.sync.order_cancelled",
  ORDER_RETRIED: "ongoing.sync.order_retried",
  ORDER_DEAD_LETTERED: "ongoing.sync.order_dead_lettered",
  INVENTORY_SYNCED: "ongoing.sync.inventory_synced",
  EDIT_BLOCKED: "ongoing.sync.edit_blocked",
} as const

export type OngoingEventName = (typeof ONGOING_EVENTS)[keyof typeof ONGOING_EVENTS]

export interface OrderPushedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  ongoing_order_id: number
  integration_id: string
}

export interface PushFailedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  integration_id: string
  error_class: "retryable" | "terminal"
  error_message: string
}

export interface ShipmentAppliedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_sync_id: string
  ongoing_order_number: string
  tracking_numbers: string[]
}

export interface OrderCancelledPayload {
  medusa_order_id: string
  ongoing_order_number: string
  ongoing_order_sync_id: string
  reason: string
}

export interface OrderRetriedPayload {
  ongoing_order_sync_id: string
  medusa_fulfillment_id: string
  retry_count: number
}

export interface OrderDeadLetteredPayload {
  ongoing_order_sync_id: string
  medusa_fulfillment_id: string
  retry_count: number
}

export interface InventorySyncedPayload {
  integration_id: string
  credential_key: string
  stock_location_id: string
  written: number
  skipped: number
}

export interface EditBlockedPayload {
  medusa_order_id: string
  ongoing_order_sync_id: string
  category: string
  latest_status_code: number | null
}
```

Append to the barrel `src/lib/ongoing/index.ts` (matches its existing append-only
export style, e.g. line 9-10):

```ts
export { ONGOING_EVENTS } from "./events"
export type {
  OngoingEventName,
  OrderPushedPayload,
  PushFailedPayload,
  ShipmentAppliedPayload,
  OrderCancelledPayload,
  OrderRetriedPayload,
  OrderDeadLetteredPayload,
  InventorySyncedPayload,
  EditBlockedPayload,
} from "./events"
```

### 2. Migrate the 2 existing `edit_blocked` emit sites onto the const

`src/subscribers/order-updated.ts:127-135` and
`src/subscribers/order-edit-confirmed.ts:76-84` currently emit
`name: "ongoing.sync.edit_blocked"` as a string literal. Add
`import { ONGOING_EVENTS } from "../lib/ongoing/events"` to both files and replace the
literal with `name: ONGOING_EVENTS.EDIT_BLOCKED`. The string value is unchanged
(`"ongoing.sync.edit_blocked"`), so the existing assertions in
`src/subscribers/__tests__/order-updated.test.ts` (`emit).toHaveBeenCalledWith({ name: "ongoing.sync.edit_blocked", ... })`)
and `src/subscribers/__tests__/order-edit-confirmed.test.ts` pass unchanged — no test
edits needed for this step, just confirm `yarn test` stays green.

### 3. `order_pushed` / `push_failed` — `src/workflows/steps/push-order-record-sync.ts`

Add `logger` + `eventBus` resolution and emit calls around the existing
`pushOrderRecordSyncHandler` (`src/workflows/steps/push-order-record-sync.ts:26-79`):

```ts
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
```

Inside `pushOrderRecordSyncHandler`, after resolving `service`:

```ts
const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
const eventBus: any = container.resolve(Modules.EVENT_BUS)
```

In the `catch` block (`:51-65`), immediately before `throw err`:

```ts
logger.error(
  `[ongoing] push-order-record-sync: failed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} integration_id=${input.integration_id} error_class=${errorClass} error=${(err as Error).message}`
)
await eventBus.emit({
  name: ONGOING_EVENTS.PUSH_FAILED,
  data: {
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    ongoing_order_number: input.ongoing_order_number,
    integration_id: input.integration_id,
    error_class: errorClass,
    error_message: (err as Error).message,
  },
})
throw err
```

After the final success `service.recordSync(...)` call (`:67-76`), before `return`:

```ts
logger.info(
  `[ongoing] push-order-record-sync: pushed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} ongoing_order_id=${ongoingOrderId} integration_id=${input.integration_id}`
)
await eventBus.emit({
  name: ONGOING_EVENTS.ORDER_PUSHED,
  data: {
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    ongoing_order_number: input.ongoing_order_number,
    ongoing_order_id: ongoingOrderId,
    integration_id: input.integration_id,
  },
})
```

**Test fallout (must fix in the same task, TDD order below):**

- `src/workflows/steps/__tests__/push-order-record-sync.test.ts` uses
  `container = { resolve: jest.fn().mockReturnValue(service) }` — a single
  key-agnostic mock (`:20`). Change `makeContainer` to a keyed switch
  (`"logger"` → logger mock, `"event_bus"` → `{ emit }` mock, else → `service`),
  mirroring `src/subscribers/__tests__/order-updated.test.ts:60-68`.
- `src/workflows/__tests__/push-order-to-ongoing.test.ts` runs the **full workflow**
  through a real `createMedusaContainer()` (`buildContainer`, `:42-54`) with only
  `"query"` and `"ongoing"` registered. Once `pushOrderRecordSyncHandler` resolves
  `Modules.EVENT_BUS`/`ContainerRegistrationKeys.LOGGER`, this test breaks at resolve
  time unless those keys are registered. Add:
  ```ts
  container.register("logger", asValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
  container.register("event_bus", asValue({ emit: jest.fn().mockResolvedValue(undefined) }))
  ```
  to `buildContainer` in that file. No new assertions required there (payload
  assertions live in the direct-handler test), just keep it passing.

### 4. `shipment_applied` — `src/workflows/steps/mark-order-sync-shipped.ts` + `src/workflows/sync-ongoing-shipment.ts`

Expand `MarkShippedInput` (`src/workflows/steps/mark-order-sync-shipped.ts:4-8`) to
carry the correlation ids and tracking numbers needed for the event (they are not
persisted by `updateOngoingOrderSyncs`, only emitted):

```ts
export type MarkShippedInput = {
  order_sync_id: string
  status_code: number
  status_text: string
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  tracking_numbers: string[]
}
```

Rewrite the handler to wrap the write in try/catch (fills the logging gap) and emit
on success:

```ts
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"

export const markOrderSyncShippedHandler = async (
  input: MarkShippedInput,
  { container }: { container: any }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus: any = container.resolve(Modules.EVENT_BUS)

  try {
    await ongoing.updateOngoingOrderSyncs({
      id: input.order_sync_id,
      sync_state: "shipped",
      shipped_at: new Date(),
      latest_status_code: input.status_code,
      latest_status_text: input.status_text,
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
    })
  } catch (err) {
    logger.error(
      `[ongoing] mark-order-sync-shipped: failed ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(err as Error).message}`
    )
    throw err
  }

  logger.info(
    `[ongoing] mark-order-sync-shipped: applied ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} tracking_numbers=${input.tracking_numbers.join(",")}`
  )
  await eventBus.emit({
    name: ONGOING_EVENTS.SHIPMENT_APPLIED,
    data: {
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      ongoing_order_sync_id: input.order_sync_id,
      ongoing_order_number: input.ongoing_order_number,
      tracking_numbers: input.tracking_numbers,
    },
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}
```

Wire the new fields through `src/workflows/sync-ongoing-shipment.ts:42-46` — the
`decision` (from `loadSyncForShipmentStep`) already carries `medusa_order_id` /
`medusa_fulfillment_id`, and `input` already carries `ongoing_order_number` /
`tracking_numbers`:

```ts
const markInput = transform({ decision, input }, (data) => ({
  order_sync_id: data.decision.order_sync_id as string,
  status_code: data.input.status_code,
  status_text: data.input.status_text,
  medusa_order_id: data.decision.medusa_order_id as string,
  medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
  ongoing_order_number: data.input.ongoing_order_number,
  tracking_numbers: data.input.tracking_numbers,
}))
```

**Test fallout:**

- `src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts` calls the handler
  with only `{ order_sync_id, status_code, status_text }` and a container that
  ignores the resolve key (`:9`). Rewrite with the expanded input and a keyed
  container (see Tasks below).
- `src/workflows/__tests__/sync-ongoing-shipment.test.ts` runs the full workflow via
  `createMedusaContainer()` (`makeScope`, `:16-20`) registering only `"ongoing"`.
  Add `"logger"` and `"event_bus"` registrations to `makeScope` or the workflow
  breaks at resolve time inside `markOrderSyncShippedHandler`.

### 5. `order_cancelled` — `src/subscribers/order-canceled.ts`

`order-canceled.ts` already has `orderId` and `row.ongoing_order_number` in scope in
its per-row loop (`:62-80`); the cancel decision (`CancelDecision` from
`src/workflows/steps/decide-ongoing-cancel.ts:17-23`, returned as `result` by
`cancelOngoingOrderWorkflow`) carries `reason`. **No change to
`decide-ongoing-cancel.ts` or the `cancel-ongoing-order` step is needed** — source
`ongoing_order_sync_id` from `row.id` (already selected via
`{ select: ["id", "ongoing_order_number", "medusa_fulfillment_id"] }`, `:42`), not
from `result.orderSyncId` (which the workflow does not always populate).

```ts
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { cancelOngoingOrderWorkflow } from "../workflows/cancel-ongoing-order"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
```

At the top of `orderCanceledHandler`, alongside the existing `logger` resolve:

```ts
const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
const eventBus = container.resolve(Modules.EVENT_BUS) as any
```

Inside the per-row `try` block (`:63-71`), after the existing `logger.info` success
line:

```ts
if (result?.shouldCancel === true) {
  await eventBus.emit({
    name: ONGOING_EVENTS.ORDER_CANCELLED,
    data: {
      medusa_order_id: orderId,
      ongoing_order_number: row.ongoing_order_number,
      ongoing_order_sync_id: row.id,
      reason: result?.reason ?? "ok",
    },
  })
}
```

**Test fallout:** `src/subscribers/__tests__/order-canceled.test.ts`'s `makeArgs`
(`:28-32`) resolves `"logger"` or falls through to `service` — add an `"event_bus"`
branch returning `{ emit }` and expose `emit` from the returned object.

### 6. `order_retried` / `order_dead_lettered` — `src/jobs/retry-failed-syncs.ts`

```ts
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
```

In `processRow` (`src/jobs/retry-failed-syncs.ts:55-113`), resolve the event bus
once at the top (the `container: MedusaContainer` param is already there):

```ts
const eventBus = (container as any).resolve(Modules.EVENT_BUS)
```

After the dead-letter `updateOngoingOrderSyncs` + its existing `logger.info` (`:73-82`):

```ts
await eventBus.emit({
  name: ONGOING_EVENTS.ORDER_DEAD_LETTERED,
  data: {
    ongoing_order_sync_id: row.id,
    medusa_fulfillment_id: row.medusa_fulfillment_id,
    retry_count: outcome.retry_count,
  },
})
return
```

After the successful re-invocation + its existing `logger.info` (`:106-112`):

```ts
await eventBus.emit({
  name: ONGOING_EVENTS.ORDER_RETRIED,
  data: {
    ongoing_order_sync_id: row.id,
    medusa_fulfillment_id: row.medusa_fulfillment_id,
    retry_count: outcome.retry_count,
  },
})
```

(`row.medusa_fulfillment_id` is narrowed to `string` by the early `== null` return at
`:61-66`, so it satisfies `OrderRetriedPayload`/`OrderDeadLetteredPayload` without a
cast.)

**Test fallout (the sharp trap):**
`src/jobs/__tests__/retry-failed-syncs.test.ts:6-10` mocks
`@medusajs/framework/utils` down to `{ ContainerRegistrationKeys: { LOGGER: "logger" } }`.
The moment the job imports `Modules` from that module, `Modules` is `undefined` in
the test → `Cannot read properties of undefined (reading 'EVENT_BUS')`. Extend the
mock:

```ts
jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: { LOGGER: "logger" },
  Modules: { EVENT_BUS: "event_bus" },
}))
```

And extend `makeHarness`'s `container.resolve` (`:53-55`) with an `"event_bus"`
branch returning `{ emit }`, exposing `emit` in the returned object.

### 7. `inventory_synced` — `src/jobs/stock-sync.ts`

```ts
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
```

In `syncIntegration` (`src/jobs/stock-sync.ts:63-113`), after the existing
`logger.info` call inside the `try` block (`:94-97`):

```ts
const eventBus: any = container.resolve(Modules.EVENT_BUS)
await eventBus.emit({
  name: ONGOING_EVENTS.INVENTORY_SYNCED,
  data: {
    integration_id: integration.id,
    credential_key: integration.credential_key,
    stock_location_id: integration.stock_location_id,
    written: result.written,
    skipped: result.skipped,
  },
})
```

**Test fallout:** `src/jobs/__tests__/stock-sync.test.ts` does **not** mock
`@medusajs/framework/utils` (real `Modules.EVENT_BUS === "event_bus"` is used), so no
mock change is needed there — only extend `makeHarness`'s `container.resolve`
(`:43-45`) with an `"event_bus"` branch returning `{ emit }`, exposing `emit`.

### 8. `cancel-ongoing-order.ts` step — log-gap fill only, no new event

`src/workflows/steps/cancel-ongoing-order.ts`'s `CancelStepInput` is only
`{ ongoingOrderId, credentialKey }` (`:4-7`) — it has no `medusa_order_id` or
`ongoing_order_number` in scope, and **is not expanded** to carry them (the rich
`order_cancelled` event with those correlation ids is emitted one layer up, from the
subscriber, per Task 5). Add logging only, using what the step already has:

```ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export const cancelOngoingOrderHandler = async (
  input: CancelStepInput,
  { container }: { container: any }
): Promise<StepResponse<CancelStepResult>> => {
  const ongoing = container.resolve("ongoing") as any
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const client = ongoing.getClient(input.credentialKey)

  try {
    await client.cancelOrder(input.ongoingOrderId)
    logger.info(
      `[ongoing] cancel-ongoing-order: cancelled ongoing_order_id=${input.ongoingOrderId}`
    )
    return new StepResponse({ cancelled: true, swallowed: false })
  } catch (err) {
    if (err instanceof OngoingApiError && err.kind === "terminal") {
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled/terminal ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
    logger.error(
      `[ongoing] cancel-ongoing-order: failed ongoing_order_id=${input.ongoingOrderId} error=${(err as Error).message}`
    )
    throw err
  }
}
```

**Test fallout:** `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`'s
`invoke` helper (`:4-8`) does `container = { resolve: (_: string) => service }` —
change to a keyed switch (`"logger"` → logger mock, else → `service`).

## Tasks (TDD — failing test first per `superpowers:test-driven-development`)

1. **`src/lib/ongoing/events.ts` + `src/lib/ongoing/__tests__/events.test.ts`.**
   Write the failing test first (module doesn't exist yet):
   ```ts
   import { ONGOING_EVENTS } from "../events"

   describe("ONGOING_EVENTS", () => {
     it("pins the exact 8 event name strings", () => {
       expect(ONGOING_EVENTS).toEqual({
         ORDER_PUSHED: "ongoing.sync.order_pushed",
         PUSH_FAILED: "ongoing.sync.push_failed",
         SHIPMENT_APPLIED: "ongoing.sync.shipment_applied",
         ORDER_CANCELLED: "ongoing.sync.order_cancelled",
         ORDER_RETRIED: "ongoing.sync.order_retried",
         ORDER_DEAD_LETTERED: "ongoing.sync.order_dead_lettered",
         INVENTORY_SYNCED: "ongoing.sync.inventory_synced",
         EDIT_BLOCKED: "ongoing.sync.edit_blocked",
       })
     })

     it("has unique, non-empty, ongoing.sync.-namespaced values", () => {
       const values = Object.values(ONGOING_EVENTS)
       expect(values.length).toBe(8)
       expect(new Set(values).size).toBe(values.length)
       for (const v of values) {
         expect(typeof v).toBe("string")
         expect(v.length).toBeGreaterThan(0)
         expect(v.startsWith("ongoing.sync.")).toBe(true)
       }
     })
   })
   ```
   Run `npx jest src/lib/ongoing/__tests__/events.test.ts` — confirm it FAILS
   (cannot resolve `../events`). Implement `src/lib/ongoing/events.ts` per the
   Approach section. Re-run — confirm PASS. Append the barrel exports to
   `src/lib/ongoing/index.ts`.

2. **Migrate `edit_blocked` onto the const.** Edit
   `src/subscribers/order-updated.ts` and `src/subscribers/order-edit-confirmed.ts`
   per Approach §2. Run
   `npx jest src/subscribers/__tests__/order-updated.test.ts src/subscribers/__tests__/order-edit-confirmed.test.ts`
   — confirm both suites still pass unchanged.

3. **`order_pushed` / `push_failed`.**
   a. Update `src/workflows/steps/__tests__/push-order-record-sync.test.ts`: change
      `makeContainer` to a keyed resolve (logger/event_bus/service) and add two
      tests — `"emits ongoing.sync.order_pushed on success"` and
      `"emits ongoing.sync.push_failed with error_class on failure, then rethrows"`
      (asserting the exact payload shape from Approach §3). Run
      `npx jest src/workflows/steps/__tests__/push-order-record-sync.test.ts` —
      confirm the two new tests FAIL (events not yet emitted; existing tests may also
      fail once `makeContainer` is keyed if resolve isn't updated correctly — fix
      until only the two new assertions fail).
   b. Implement the changes to `src/workflows/steps/push-order-record-sync.ts` from
      Approach §3. Re-run — confirm all tests PASS.
   c. Update `src/workflows/__tests__/push-order-to-ongoing.test.ts`'s
      `buildContainer` to register `"logger"` and `"event_bus"` (Approach §3). Run
      `npx jest src/workflows/__tests__/push-order-to-ongoing.test.ts` — confirm it
      still passes (this is a regression guard, not new behavior).

4. **`shipment_applied`.**
   a. Rewrite `src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts` with
      the expanded `MarkShippedInput` (`medusa_order_id`, `medusa_fulfillment_id`,
      `ongoing_order_number`, `tracking_numbers`), a keyed container mock, and 3
      tests: the existing happy-path assertion (updated input), a new
      `"emits ongoing.sync.shipment_applied with correlation ids and tracking numbers"`,
      and a new
      `"logs and rethrows without emitting when updateOngoingOrderSyncs fails"`. Run
      `npx jest src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts` —
      confirm it FAILS (type error / missing fields, no emit yet).
   b. Implement `src/workflows/steps/mark-order-sync-shipped.ts` per Approach §4.
      Re-run — confirm PASS.
   c. Update `src/workflows/sync-ongoing-shipment.ts`'s `markInput` transform
      (Approach §4).
   d. Update `src/workflows/__tests__/sync-ongoing-shipment.test.ts`'s `makeScope`
      to register `"logger"` and `"event_bus"`, and add an assertion in the
      happy-path test:
      ```ts
      expect(container.resolve("event_bus").emit).toHaveBeenCalledWith({
        name: "ongoing.sync.shipment_applied",
        data: {
          medusa_order_id: "order_1",
          medusa_fulfillment_id: "ful_1",
          ongoing_order_sync_id: "os_1",
          ongoing_order_number: "1001-abc",
          tracking_numbers: ["TRK1", "TRK2"],
        },
      })
      ```
      Run `npx jest src/workflows/__tests__/sync-ongoing-shipment.test.ts` —
      confirm PASS.

5. **`order_cancelled`.**
   a. Update `src/subscribers/__tests__/order-canceled.test.ts`'s `makeArgs` to add
      an `"event_bus"` branch and expose `emit`. Add two tests at the end of the
      `describe` block:
      `"emits ongoing.sync.order_cancelled for each row the workflow actually cancels"`
      (default `run` mock resolves `shouldCancel: true, reason: "ok"`) and
      `"does not emit ongoing.sync.order_cancelled when the workflow does not cancel"`
      (override with `run.mockResolvedValueOnce({ result: { shouldCancel: false, reason: "already_cancelled" } })`).
      Run `npx jest src/subscribers/__tests__/order-canceled.test.ts` — confirm the
      two new tests FAIL.
   b. Implement `src/subscribers/order-canceled.ts` per Approach §5. Re-run —
      confirm all tests PASS.

6. **`order_retried` / `order_dead_lettered`.**
   a. Update `src/jobs/__tests__/retry-failed-syncs.test.ts`: extend the
      `@medusajs/framework/utils` mock to include `Modules: { EVENT_BUS: "event_bus" }`,
      extend `makeHarness` with an `"event_bus"` branch, and add assertions to the
      existing `"re-invokes pushOrderToOngoing for a due retryable row..."` test
      (expect `ongoing.sync.order_retried` with `{ ongoing_order_sync_id: "sync_1", medusa_fulfillment_id: "ful_abc", retry_count: 1 }`)
      and the existing `"dead-letters a row that has exhausted MAX_SYNC_RETRIES..."`
      test (expect `ongoing.sync.order_dead_lettered` with
      `{ ongoing_order_sync_id: "sync_1", medusa_fulfillment_id: "ful_abc", retry_count: 5 }`).
      Run `npx jest src/jobs/__tests__/retry-failed-syncs.test.ts` — confirm the two
      new assertions FAIL (events not yet emitted).
   b. Implement `src/jobs/retry-failed-syncs.ts` per Approach §6. Re-run — confirm
      all tests PASS.

7. **`inventory_synced`.**
   a. Update `src/jobs/__tests__/stock-sync.test.ts`'s `makeHarness` with an
      `"event_bus"` branch, and add an assertion to the existing
      `"dispatches syncOngoingInventoryWorkflow with the correct input for a due integration"`
      test:
      ```ts
      expect(h.emit).toHaveBeenCalledWith({
        name: "ongoing.sync.inventory_synced",
        data: { integration_id: "int_1", credential_key: "wh-a", stock_location_id: "sloc_1", written: 0, skipped: 0 },
      })
      ```
      Run `npx jest src/jobs/__tests__/stock-sync.test.ts` — confirm it FAILS.
   b. Implement `src/jobs/stock-sync.ts` per Approach §7. Re-run — confirm PASS.

8. **Log-gap fill on `cancel-ongoing-order.ts` (no new event).**
   a. Update `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`'s `invoke`
      helper to a keyed resolve (`"logger"` → logger mock, else → `service`), and
      add assertions to the existing 3 tests: `logger.info` called on the cancelled
      and swallowed paths, `logger.error` called on the re-thrown-retryable path.
      Run `npx jest src/workflows/steps/__tests__/cancel-ongoing-order.test.ts` —
      confirm it FAILS (no logger calls yet).
   b. Implement `src/workflows/steps/cancel-ongoing-order.ts` per Approach §8.
      Re-run — confirm PASS.

## Verification

- `yarn lint` — clean on every file touched above.
- `yarn build` — `medusa plugin:build` compiles with no type errors (the expanded
  `MarkShippedInput` and new payload interfaces must type-check end to end through
  `transform`).
- `yarn test` — full suite green. Baseline was 43 suites / 249 tests; this plan adds
  1 new suite (`events.test.ts`) and touches 9 existing suites
  (`push-order-record-sync.test.ts`, `push-order-to-ongoing.test.ts`,
  `mark-order-sync-shipped.test.ts`, `sync-ongoing-shipment.test.ts`,
  `order-canceled.test.ts`, `retry-failed-syncs.test.ts`, `stock-sync.test.ts`,
  `cancel-ongoing-order.test.ts`, plus the no-op-but-verified
  `order-updated.test.ts`/`order-edit-confirmed.test.ts`), landing at 44 suites with
  strictly more passing tests than baseline.

## Out of scope / follow-ups

- Admin dashboard consumption of these events (subscriber(s) that read
  `ongoing.sync.*` and surface them in the UI) is #40/#42/#43's scope, not this
  issue's.
- **Success/failure counters** (spec §11): this issue emits the event substrate
  (`order_pushed`/`push_failed`, `order_dead_lettered`, `inventory_synced` with
  `{written, skipped}`); the aggregate counters themselves are **dashboard-side
  aggregation owned by #43** (which lists/derives counts from `OngoingOrderSync.sync_state`).
  Not persisted or tallied by this issue.
- No new `status_changed` event on the status-poll job (per-tick per-order volume is
  unbounded) — if a bounded/coalesced status-change signal is wanted later, open a
  new issue.
- No change to `OngoingClient`/HTTP-level logging (`src/lib/ongoing/client.ts`) — out
  of scope for this issue, which targets workflow/subscriber/job-level correlation.
