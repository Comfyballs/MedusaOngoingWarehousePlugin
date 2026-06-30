# syncOngoingShipment Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. REQUIRED: follow superpowers:test-driven-development — write the failing Jest test first for every step, then make it pass.

**Goal:** Build the `syncOngoingShipment` workflow (issue #33) that, given an Ongoing shipment notification, applies tracking to the matching Medusa fulfillment and marks it shipped via Medusa's `createOrderShipmentWorkflow` (so reservations finalize and `order.shipment_created` fires). It handles N parcel tracking numbers and is fully idempotent: a no-op when the `OngoingOrderSync` row already has `shipped_at` set, and a swallowed-success when Medusa reports the fulfillment is already shipped. This single workflow is the shared convergence point for both the poll job (#34) and the webhook route (#36).

**Architecture:** One Medusa workflow (`src/workflows/sync-ongoing-shipment.ts`) composed of three custom steps under `src/workflows/steps/`: (1) `loadSyncForShipmentStep` loads the `OngoingOrderSync` row by `ongoing_order_number` and returns a skip/proceed decision, (2) `applyOrderShipmentStep` invokes `createOrderShipmentWorkflow` inside its handler (the canonical "run a core-flow inside a step" pattern), building parcel labels from the tracking numbers and swallowing Medusa's already-shipped error as idempotent success, (3) `markOrderSyncShippedStep` sets `sync_state = "shipped"` + `shipped_at` + the latest status code/text on the row. The composition mirrors `cancelOngoingOrder` (`src/workflows/cancel-ongoing-order.ts`): a single `when(decision, d => !d.skip).then(...)` gate driven by `transform()`-derived step inputs.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`, `@medusajs/core-flows`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest 29 + `@swc/jest` for unit tests.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Package manager **yarn 4.6.0**, Node **>= 20**.
- Module id is `"ongoing"`; resolve the service with `container.resolve(ONGOING_MODULE)` where `ONGOING_MODULE = "ongoing"` (`src/modules/ongoing/index.ts:5`).
- Workflows live under `src/workflows/`; steps under `src/workflows/steps/`; step unit tests under `src/workflows/steps/__tests__/`; workflow tests under `src/workflows/__tests__/`.
- **Workflow composition body rules** (the `createWorkflow(...)` function): no `async`, no arrow-function steps, no conditionals/ternaries/`??`/`?.`/`||`/spread, no `try/catch`, no loops. Use `transform()` and `when().then()`. One mutation per step. `yarn build` (`medusa plugin:build`) is what catches an illegal construct, so it must pass. NOTE: `transform()` and `createStep()` handler bodies are ordinary runtime code — normal JS (conditionals, `map`, try/catch) is allowed there; only the `createWorkflow` body is restricted.
- Errors raised inside business logic must be Medusa-aware: re-throw the original `MedusaError`/`OngoingApiError` unchanged; never wrap in a generic `Error`. Service/step handlers are `async`.
- Prices/quantities are stored as-is — never ×100 or ÷100. (Not exercised here; `items: []` is passed and quantities are read from the loaded fulfillment by the core flow.)
- TDD: a **failing Jest unit test** comes before each step's logic. Tests mock the `ongoing` module service and `@medusajs/core-flows`; there is no DB or running Medusa in this plugin repo (plugin tests are pure unit tests with mocked dependencies, per the M1 plan).
- No new migration: every column written already exists on `OngoingOrderSync` (`src/modules/ongoing/models/order-sync.ts`).

---

## Background — verified facts the implementer must not re-derive

- **Medusa entry point:** `createOrderShipmentWorkflow` from `@medusajs/core-flows` (workflow id `"create-order-shipment"`, confirmed at `node_modules/@medusajs/core-flows/dist/order/workflows/create-shipment.d.ts:48,81`). It sets `fulfillment.shipped_at`, updates order state, releases reservations, and emits `SHIPMENT_CREATED`. The lower-level `createShipmentWorkflow` does NOT update order state — **do not use it**.
- **How to invoke it:** call it INSIDE the step handler via `await createOrderShipmentWorkflow(container).run({ input })`, where `container` is the step's second-argument `{ container }`. Do **not** use `.runAsStep()` (that is only valid inside a `createWorkflow` composition body). Canonical pattern in this repo: `src/subscribers/order-canceled.ts:64` (`await cancelOngoingOrderWorkflow(container).run({ input })`).
- **Input type** `CreateOrderShipmentWorkflowInput` (`node_modules/@medusajs/types/dist/workflow/order/create-shipment.d.ts:20-48`): `{ order_id: string; fulfillment_id: string; created_by?: string; items: CreateOrderShipmentItem[]; labels?: CreateFulfillmentLabelWorkflowDTO[]; no_notification?: boolean; metadata?: MetadataType }`. Pass `items: []` — it is SAFE: the validate step does `arrayDifference([], ...) = []` (no error) and quantities come from the loaded fulfillment, not from `input.items`. Pass `no_notification: false` (locked decision — always notify on dispatch).
- **Label shape** `CreateFulfillmentLabelWorkflowDTO` (`node_modules/@medusajs/types/dist/workflow/fulfillment/create-fulfillment.d.ts:82-94`): all three fields are required strings — `{ tracking_number: string; tracking_url: string; label_url: string }`. Ongoing's `getOrdersByStatus` returns only tracking codes (no URLs), so build each label as `{ tracking_number, tracking_url: "", label_url: "" }` (locked decision — empty strings satisfy the type).
- **Medusa-layer idempotency:** when `fulfillment.shipped_at` is already set, the `validate-shipment` step throws `new MedusaError(MedusaError.Types.NOT_ALLOWED, "Shipment has already been created")` (verified verbatim at `node_modules/@medusajs/core-flows/dist/fulfillment/steps/validate-shipment.js:17-19`). The apply step must catch **exactly** this (`err instanceof MedusaError && err.type === MedusaError.Types.NOT_ALLOWED && err.message === "Shipment has already been created"`) and treat it as idempotent success — mirroring the terminal-4xx swallow in `src/workflows/steps/cancel-ongoing-order.ts:24-30`.
- **Workflow input contract (shared, do not change):** `type SyncOngoingShipmentInput = { ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] }`. The poll job (#34) and the webhook wiring (#36) both call the workflow with exactly this shape. The workflow looks up the `OngoingOrderSync` row by `ongoing_order_number` to obtain `medusa_order_id` + `medusa_fulfillment_id`.
- **`OngoingOrderSync` columns** (`src/modules/ongoing/models/order-sync.ts`): `id`, `medusa_order_id` (text), `medusa_fulfillment_id` (text, **nullable**), `ongoing_order_number` (text, **unique**), `latest_status_code` (number, nullable), `latest_status_text` (text, nullable), `sync_state` enum includes `"shipped"` (`pending|sent|shipped|cancelled|error`), `error_class` enum `["retryable","terminal"]` (nullable), `last_error` (text, nullable), `last_synced_at` (dateTime, nullable), `shipped_at` (dateTime, nullable). All required columns exist — **no migration**.
- **Service methods** (generated by `MedusaService` over `OngoingOrderSync`, used elsewhere already): `listOngoingOrderSyncs(filter, config?)` returns `OngoingOrderSync[]` (see `src/workflows/steps/decide-ongoing-cancel.ts:45`) and `updateOngoingOrderSyncs(data)` takes a `{ id, ... }` partial (see `src/workflows/steps/mark-order-sync-cancelled.ts:13`).
- **Error classification (locked decision)** for the apply step's record-then-rethrow catch: `if (err instanceof MedusaError) error_class = "terminal"; else if (err instanceof OngoingApiError) error_class = err.kind; else error_class = "retryable"`. This differs from the shared `classifyError` helper (`src/lib/ongoing/errors.ts:15-17`) only by adding the `MedusaError → "terminal"` branch, because `createOrderShipmentWorkflow` raises `MedusaError`s for terminal validation failures (canceled fulfillment, missing shipping option) that must not be retried. `OngoingApiError` is imported from `src/lib/ongoing/errors.ts`; `MedusaError` from `@medusajs/framework/utils`.
- **Inline record-then-rethrow (not compensation)**: capture the error INSIDE the step handler's `try/catch`, write the error row via `updateOngoingOrderSyncs`, then re-throw — exactly as `src/workflows/steps/push-order-record-sync.ts:21-26` and `src/workflows/steps/upsert-ongoing-order-edit.ts:17-23` document. A throwing step returns no `StepResponse`, so a compensation function would receive `undefined` and could not see the classified error.

---

## File Structure

**Create:**
- `src/workflows/steps/load-sync-for-shipment.ts` — `loadSyncForShipmentStep` + exported `loadSyncForShipmentHandler`; loads the sync row and returns a `ShipmentDecision`.
- `src/workflows/steps/apply-order-shipment.ts` — `applyOrderShipmentStep` + exported `applyOrderShipmentHandler`; invokes `createOrderShipmentWorkflow`, swallows already-shipped, records-then-rethrows other errors.
- `src/workflows/steps/mark-order-sync-shipped.ts` — `markOrderSyncShippedStep` + exported `markOrderSyncShippedHandler`; marks the row shipped.
- `src/workflows/sync-ongoing-shipment.ts` — `syncOngoingShipmentWorkflow` composition + `SyncOngoingShipmentInput` / `ShipmentDecision` exported types.
- Tests:
  - `src/workflows/steps/__tests__/load-sync-for-shipment.test.ts`
  - `src/workflows/steps/__tests__/apply-order-shipment.test.ts`
  - `src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts`
  - `src/workflows/__tests__/sync-ongoing-shipment.test.ts`

**Modify:**
- `src/workflows/index.ts` — export `syncOngoingShipmentWorkflow` and its types from the barrel.

---

## Task 1: `loadSyncForShipmentStep` — load the sync row, decide skip/proceed

**Files:**
- Create: `src/workflows/steps/load-sync-for-shipment.ts`
- Test: `src/workflows/steps/__tests__/load-sync-for-shipment.test.ts`

**Interfaces:**
- Exported types:
  - `type LoadSyncForShipmentInput = { ongoing_order_number: string }`
  - `type ShipmentDecisionReason = "ok" | "no_sync_row" | "already_shipped" | "no_fulfillment_id"`
  - `type ShipmentDecision = { skip: boolean; reason: ShipmentDecisionReason; order_sync_id?: string; medusa_order_id?: string; medusa_fulfillment_id?: string }`
- Exported `loadSyncForShipmentHandler(input: LoadSyncForShipmentInput, ctx: { container: any }): Promise<StepResponse<ShipmentDecision>>` (export the handler so it is unit-testable directly, mirroring `decideOngoingCancelHandler`).
- Exported `loadSyncForShipmentStep = createStep("load-sync-for-shipment", loadSyncForShipmentHandler)`.

**Behavior:**
- Resolve `container.resolve(ONGOING_MODULE)`; call `listOngoingOrderSyncs({ ongoing_order_number: input.ongoing_order_number })`; take `syncs?.[0]`.
- If no row → `{ skip: true, reason: "no_sync_row" }`.
- Else if `sync.shipped_at` is set (truthy) → `{ skip: true, reason: "already_shipped", order_sync_id: sync.id }`.
- Else if `sync.medusa_fulfillment_id == null` (null or undefined) → `{ skip: true, reason: "no_fulfillment_id", order_sync_id: sync.id }` (terminal: cannot ship without a fulfillment).
- Else → `{ skip: false, reason: "ok", order_sync_id: sync.id, medusa_order_id: sync.medusa_order_id, medusa_fulfillment_id: sync.medusa_fulfillment_id }`.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/load-sync-for-shipment.test.ts` mirroring the mock style of `src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`:
```ts
import { loadSyncForShipmentHandler } from "../load-sync-for-shipment"

const invoke = (rows: any[]) => {
  const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows) }
  const container = { resolve: (_: string) => service }
  return loadSyncForShipmentHandler({ ongoing_order_number: "1001-abc" }, { container })
}

describe("loadSyncForShipmentStep", () => {
  it("skips with no_sync_row when there is no matching row", async () => {
    const res = await invoke([])
    expect(res.output).toEqual({ skip: true, reason: "no_sync_row" })
  })

  it("skips with already_shipped when shipped_at is set", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date() },
    ])
    expect(res.output).toEqual({ skip: true, reason: "already_shipped", order_sync_id: "os_1" })
  })

  it("skips with no_fulfillment_id when medusa_fulfillment_id is null (terminal)", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null },
    ])
    expect(res.output).toEqual({ skip: true, reason: "no_fulfillment_id", order_sync_id: "os_1" })
  })

  it("proceeds with ok and carries the medusa ids forward", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null },
    ])
    expect(res.output).toEqual({
      skip: false,
      reason: "ok",
      order_sync_id: "os_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
    })
  })

  it("filters by ongoing_order_number", async () => {
    const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) }
    await loadSyncForShipmentHandler({ ongoing_order_number: "1001-abc" }, { container: { resolve: () => service } })
    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ ongoing_order_number: "1001-abc" })
  })
})
```

Run it and confirm it fails (module not found):
```bash
yarn test src/workflows/steps/__tests__/load-sync-for-shipment.test.ts
```

- [ ] **Step 2: Implement the step** in `src/workflows/steps/load-sync-for-shipment.ts` so the test passes. Import `createStep, StepResponse` from `@medusajs/framework/workflows-sdk` and `ONGOING_MODULE` from `../../modules/ongoing`. Use `sync.shipped_at` truthiness for the already-shipped branch and `sync.medusa_fulfillment_id === null || sync.medusa_fulfillment_id === undefined` for the no-fulfillment branch.

- [ ] **Step 3: Verify** — `yarn test src/workflows/steps/__tests__/load-sync-for-shipment.test.ts` passes; `yarn lint` clean.

---

## Task 2: `applyOrderShipmentStep` — invoke createOrderShipmentWorkflow, swallow already-shipped, record-then-rethrow

**Files:**
- Create: `src/workflows/steps/apply-order-shipment.ts`
- Test: `src/workflows/steps/__tests__/apply-order-shipment.test.ts`

**Interfaces:**
- Exported types:
  - `type ApplyShipmentInput = { order_sync_id: string; medusa_order_id: string; medusa_fulfillment_id: string; tracking_numbers: string[] }`
  - `type ApplyShipmentResult = { applied: boolean; reason: "shipped" | "already_shipped" }`
- Exported `applyOrderShipmentHandler(input: ApplyShipmentInput, ctx: { container: any }): Promise<StepResponse<ApplyShipmentResult>>`.
- Exported `applyOrderShipmentStep = createStep("apply-order-shipment", applyOrderShipmentHandler)`.

**Behavior (handler body — ordinary runtime code, try/catch allowed):**
1. Build `labels = input.tracking_numbers.map((tn) => ({ tracking_number: tn, tracking_url: "", label_url: "" }))`.
2. Build the core-flow input `{ order_id: input.medusa_order_id, fulfillment_id: input.medusa_fulfillment_id, items: [], labels, no_notification: false }` typed as `CreateOrderShipmentWorkflowInput`.
3. `try { await createOrderShipmentWorkflow(container).run({ input: shipmentInput }); return new StepResponse({ applied: true, reason: "shipped" }) }`.
4. `catch (err)`:
   - If `err instanceof MedusaError && err.type === MedusaError.Types.NOT_ALLOWED && err.message === "Shipment has already been created"` → return `new StepResponse({ applied: false, reason: "already_shipped" })` (idempotent success; do NOT write an error row).
   - Otherwise classify: `error_class = err instanceof MedusaError ? "terminal" : err instanceof OngoingApiError ? err.kind : "retryable"`. `await service.updateOngoingOrderSyncs({ id: input.order_sync_id, sync_state: "error", error_class, last_error: (err as Error).message, last_synced_at: new Date() })`, then `throw err`.
- Imports: `createStep, StepResponse` from `@medusajs/framework/workflows-sdk`; `MedusaError` from `@medusajs/framework/utils`; `createOrderShipmentWorkflow` from `@medusajs/core-flows`; `OngoingApiError` from `../../lib/ongoing/errors`; `ONGOING_MODULE` from `../../modules/ongoing`; type `CreateOrderShipmentWorkflowInput` from `@medusajs/types`.
- Resolve the service once (`const service: any = container.resolve(ONGOING_MODULE)`) for the error path.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/apply-order-shipment.test.ts`. Mock `@medusajs/core-flows` so `createOrderShipmentWorkflow(container).run(...)` is controllable:
```ts
import { MedusaError } from "@medusajs/framework/utils"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const run = jest.fn()
jest.mock("@medusajs/core-flows", () => ({
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { applyOrderShipmentHandler } from "../apply-order-shipment"

const makeService = () => ({ updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined) })
const invoke = (input: any, service: any) =>
  applyOrderShipmentHandler(input, { container: { resolve: (_: string) => service } })

const baseInput = {
  order_sync_id: "os_1",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  tracking_numbers: ["TRK1", "TRK2"],
}

beforeEach(() => {
  run.mockReset()
  ;(createOrderShipmentWorkflow as jest.Mock).mockClear()
})

describe("applyOrderShipmentStep", () => {
  it("invokes createOrderShipmentWorkflow with items:[] , no_notification:false and parcel labels", async () => {
    run.mockResolvedValue({ result: undefined })
    const service = makeService()
    const res = await invoke(baseInput, service)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        order_id: "order_1",
        fulfillment_id: "ful_1",
        items: [],
        labels: [
          { tracking_number: "TRK1", tracking_url: "", label_url: "" },
          { tracking_number: "TRK2", tracking_url: "", label_url: "" },
        ],
        no_notification: false,
      },
    })
    expect(res.output).toEqual({ applied: true, reason: "shipped" })
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("swallows the already-created MedusaError as idempotent success without writing an error row", async () => {
    run.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Shipment has already been created")
    )
    const service = makeService()
    const res = await invoke(baseInput, service)
    expect(res.output).toEqual({ applied: false, reason: "already_shipped" })
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("records error_class terminal and rethrows for a non-already-shipped MedusaError", async () => {
    run.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Cannot create shipment for a canceled fulfillment")
    )
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(MedusaError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "os_1",
        sync_state: "error",
        error_class: "terminal",
        last_error: "Cannot create shipment for a canceled fulfillment",
      })
    )
  })

  it("records the OngoingApiError kind and rethrows", async () => {
    run.mockRejectedValue(new OngoingApiError("down", { status: 503, kind: "retryable" }))
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(OngoingApiError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "os_1", sync_state: "error", error_class: "retryable", last_error: "down" })
    )
  })

  it("classifies a raw/unknown error as retryable and rethrows", async () => {
    run.mockRejectedValue(new TypeError("fetch failed"))
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(TypeError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "os_1", sync_state: "error", error_class: "retryable", last_error: "fetch failed" })
    )
  })

  it("passes empty labels when there are no tracking numbers", async () => {
    run.mockResolvedValue({ result: undefined })
    await invoke({ ...baseInput, tracking_numbers: [] }, makeService())
    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_1", fulfillment_id: "ful_1", items: [], labels: [], no_notification: false },
    })
  })
})
```

Run and confirm it fails:
```bash
yarn test src/workflows/steps/__tests__/apply-order-shipment.test.ts
```

- [ ] **Step 2: Implement** `src/workflows/steps/apply-order-shipment.ts` per the Behavior section. Keep the already-shipped check (`err.type === MedusaError.Types.NOT_ALLOWED && err.message === "Shipment has already been created"`) BEFORE the classification so it is never recorded as an error row.

- [ ] **Step 3: Verify** — `yarn test src/workflows/steps/__tests__/apply-order-shipment.test.ts` passes; `yarn lint` clean.

---

## Task 3: `markOrderSyncShippedStep` — mark the row shipped

**Files:**
- Create: `src/workflows/steps/mark-order-sync-shipped.ts`
- Test: `src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts`

**Interfaces:**
- Exported type `type MarkShippedInput = { order_sync_id: string; status_code: number; status_text: string }`.
- Exported `markOrderSyncShippedHandler(input: MarkShippedInput, ctx: { container: any }): Promise<StepResponse<{ order_sync_id: string }>>`.
- Exported `markOrderSyncShippedStep = createStep("mark-order-sync-shipped", markOrderSyncShippedHandler)`.

**Behavior (mirrors `mark-order-sync-cancelled.ts`):** resolve `ONGOING_MODULE`, then a single `updateOngoingOrderSyncs({ id: input.order_sync_id, sync_state: "shipped", shipped_at: new Date(), latest_status_code: input.status_code, latest_status_text: input.status_text, error_class: null, last_error: null, last_synced_at: new Date() })`; return `new StepResponse({ order_sync_id: input.order_sync_id })`.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts`:
```ts
import { markOrderSyncShippedHandler } from "../mark-order-sync-shipped"

describe("markOrderSyncShippedStep", () => {
  it("sets sync_state shipped, shipped_at, status fields and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const service = { updateOngoingOrderSyncs }
    const res = await markOrderSyncShippedHandler(
      { order_sync_id: "os_1", status_code: 200, status_text: "Shipped" },
      { container: { resolve: (_: string) => service } }
    )
    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("os_1")
    expect(arg.sync_state).toBe("shipped")
    expect(arg.latest_status_code).toBe(200)
    expect(arg.latest_status_text).toBe("Shipped")
    expect(arg.error_class).toBeNull()
    expect(arg.last_error).toBeNull()
    expect(arg.shipped_at).toBeInstanceOf(Date)
    expect(arg.last_synced_at).toBeInstanceOf(Date)
    expect(res.output).toEqual({ order_sync_id: "os_1" })
  })
})
```

Run and confirm it fails:
```bash
yarn test src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts
```

- [ ] **Step 2: Implement** `src/workflows/steps/mark-order-sync-shipped.ts` per Behavior.

- [ ] **Step 3: Verify** — `yarn test src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts` passes; `yarn lint` clean.

---

## Task 4: `syncOngoingShipmentWorkflow` composition + barrel export

**Files:**
- Create: `src/workflows/sync-ongoing-shipment.ts`
- Modify: `src/workflows/index.ts`
- Test: `src/workflows/__tests__/sync-ongoing-shipment.test.ts`

**Interfaces:**
- Exported `type SyncOngoingShipmentInput = { ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] }`.
- Re-export `ShipmentDecision` from the load step for callers (#34/#36) that inspect the result.
- Exported `syncOngoingShipmentWorkflow = createWorkflow("sync-ongoing-shipment", function (input: SyncOngoingShipmentInput) { ... })`; also `export default syncOngoingShipmentWorkflow`.

**Composition (mirror `src/workflows/cancel-ongoing-order.ts:17-39` — body obeys the no-async/arrow/conditional/loop rule):**
```ts
import {
  createWorkflow,
  WorkflowResponse,
  transform,
  when,
} from "@medusajs/framework/workflows-sdk"
import {
  loadSyncForShipmentStep,
  type ShipmentDecision,
} from "./steps/load-sync-for-shipment"
import { applyOrderShipmentStep } from "./steps/apply-order-shipment"
import { markOrderSyncShippedStep } from "./steps/mark-order-sync-shipped"

export type SyncOngoingShipmentInput = {
  ongoing_order_number: string
  status_code: number
  status_text: string
  tracking_numbers: string[]
}

export const syncOngoingShipmentWorkflow = createWorkflow(
  "sync-ongoing-shipment",
  function (input: SyncOngoingShipmentInput) {
    const decision = loadSyncForShipmentStep(
      transform({ input }, (data) => ({
        ongoing_order_number: data.input.ongoing_order_number,
      }))
    )

    when(decision, (d: ShipmentDecision) => !d.skip).then(() => {
      const applyInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        medusa_order_id: data.decision.medusa_order_id as string,
        medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
        tracking_numbers: data.input.tracking_numbers,
      }))

      applyOrderShipmentStep(applyInput)

      const markInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        status_code: data.input.status_code,
        status_text: data.input.status_text,
      }))

      markOrderSyncShippedStep(markInput)
    })

    return new WorkflowResponse(decision)
  }
)

export default syncOngoingShipmentWorkflow
export type { ShipmentDecision } from "./steps/load-sync-for-shipment"
```

Note: `markOrderSyncShippedStep` runs after `applyOrderShipmentStep` inside the `when` block. This is correct and idempotent — when `apply` swallows an out-of-band already-shipped fulfillment (`applied:false`), the row is still reconciled to `shipped`. The `decision.skip = true` cases (already-shipped row, no fulfillment id, no row) bypass both steps entirely.

**Barrel:** in `src/workflows/index.ts` add:
```ts
export { syncOngoingShipmentWorkflow } from "./sync-ongoing-shipment"
export type { SyncOngoingShipmentInput, ShipmentDecision } from "./sync-ongoing-shipment"
```

- [ ] **Step 1: Write the failing test**

Create `src/workflows/__tests__/sync-ongoing-shipment.test.ts`, building a real Medusa container so the orchestrator threads the mock service into each step (mirror `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts:53-60`). Mock `@medusajs/core-flows` so `createOrderShipmentWorkflow` does not touch a real order:
```ts
import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"

const run = jest.fn().mockResolvedValue({ result: undefined })
jest.mock("@medusajs/core-flows", () => ({
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { syncOngoingShipmentWorkflow } from "../sync-ongoing-shipment"

const makeService = (rows: any[]) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
})

const makeScope = (service: Record<string, unknown>) => {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  return container
}

const input = {
  ongoing_order_number: "1001-abc",
  status_code: 200,
  status_text: "Shipped",
  tracking_numbers: ["TRK1", "TRK2"],
}

beforeEach(() => {
  run.mockClear()
  ;(createOrderShipmentWorkflow as jest.Mock).mockClear()
})

describe("syncOngoingShipmentWorkflow", () => {
  it("applies the shipment and marks the row shipped on the happy path", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })

    expect(run).toHaveBeenCalledWith({
      input: {
        order_id: "order_1",
        fulfillment_id: "ful_1",
        items: [],
        labels: [
          { tracking_number: "TRK1", tracking_url: "", label_url: "" },
          { tracking_number: "TRK2", tracking_url: "", label_url: "" },
        ],
        no_notification: false,
      },
    })
    const shippedWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "shipped")
    expect(shippedWrite).toMatchObject({ id: "os_1", sync_state: "shipped", latest_status_code: 200, latest_status_text: "Shipped" })
    expect(result).toMatchObject({ skip: false, reason: "ok" })
  })

  it("no-ops when the row is already shipped", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date() },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "already_shipped" })
  })

  it("no-ops when there is no sync row", async () => {
    const service = makeService([])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "no_sync_row" })
  })

  it("no-ops when the row has no medusa_fulfillment_id", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "no_fulfillment_id" })
  })
})
```

Run and confirm it fails:
```bash
yarn test src/workflows/__tests__/sync-ongoing-shipment.test.ts
```

- [ ] **Step 2: Implement** `src/workflows/sync-ongoing-shipment.ts` (the composition above) and update `src/workflows/index.ts` with the two export lines.

- [ ] **Step 3: Verify** — `yarn test src/workflows/__tests__/sync-ongoing-shipment.test.ts` passes.

---

## Final verification

Run, in the worktree root, and show the output for each (superpowers:verification-before-completion):

- [ ] `yarn lint` — clean.
- [ ] `yarn build` — succeeds. This is the gate that catches any illegal `createWorkflow`-composition construct (async/arrow/conditional/loop in the workflow body); a green build proves the composition is legal.
- [ ] Each new test file passes individually:
  ```bash
  yarn test src/workflows/steps/__tests__/load-sync-for-shipment.test.ts
  yarn test src/workflows/steps/__tests__/apply-order-shipment.test.ts
  yarn test src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts
  yarn test src/workflows/__tests__/sync-ongoing-shipment.test.ts
  ```
- [ ] Full suite green: `yarn test`.

## Out of scope (separate issues)

- The poll job that calls `syncOngoingShipmentWorkflow` when a status code is in `shipped_status_codes` — issue #34.
- The webhook route (`POST /ongoing/webhooks/:credentialKey`, HMAC-authenticated) that calls the same workflow — issue #36.
- Populating `latest_status_code` from Ongoing and the `getOrdersByStatus`/tracking parser — the inbound status milestone work that feeds this workflow's input contract.
