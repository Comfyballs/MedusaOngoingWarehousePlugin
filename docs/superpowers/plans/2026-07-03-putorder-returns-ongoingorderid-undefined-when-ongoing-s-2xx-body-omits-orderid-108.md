# putOrder returns `{ ongoingOrderId: undefined }` when Ongoing's 2xx body omits orderId (#108) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is business logic (a client-contract fix plus a data-repair workflow) and follows superpowers:test-driven-development — a failing test precedes each implementation step.

**Goal:** `OngoingClient.putOrder` (`src/lib/ongoing/client.ts:114-117`) must never return `{ ongoingOrderId: undefined }` (or `null`) when Ongoing answers `PUT /orders` with a 2xx status but a body that omits `orderId` or sets it to `null`. Today the declared return type (`{ ongoingOrderId: number }`) lies to the type checker, and both callers — `pushOrderRecordSyncHandler` (`src/workflows/steps/push-order-record-sync.ts:54-55,100`) and `upsertOngoingOrderEditStep` (`src/workflows/steps/upsert-ongoing-order-edit.ts:73-88`) — persist the undefined straight into `OngoingOrderSync.ongoing_order_id`, permanently breaking every later cancel/status/tracking lookup for that order with no error trail. Fix `putOrder` to throw a typed, retryable `OngoingApiError` instead, and add a one-time repair path for `OngoingOrderSync` rows that are already stuck in this broken state from before the fix.

**Relationship to #107:** Scoped **narrowly** to `putOrder`'s missing/invalid-`orderId` contract, not generalized into #107's broader `doFetch`/`safeJson` content-type + shape validation. #107 (CRIT-1) targets a *different* failure surface: a non-JSON 2xx body (HTML error page, truncated response) that `safeJson` silently stringifies and `doFetch` casts to `T` uninspected — that gap affects every operation on the client (`getOrderStatuses`, `getInventory`, `getOrdersByStatus`, `cancelOrder`, `putOrder`). This issue (#108, CRIT-2) is narrower: a **well-formed JSON** 2xx body (`content-type: application/json`, parses fine) that simply omits the `orderId` field or sets it to `null` — a case #107's proposed content-type check would *not* catch, since the content-type is correct and the JSON is valid. The two fixes are complementary, not competing, and touch disjoint code (`putOrder`'s body only vs. `doFetch`/`safeJson` shared by all operations) — **no ordering dependency**. This plan does not modify `doFetch` or `safeJson`; whichever of #107/#108 lands first, the other applies cleanly.

**Architecture:**
- Task 1: `putOrder` validates `res.orderId` is a `number` before returning; throws `new OngoingApiError(..., { kind: "retryable", body: res })` otherwise. `OngoingApiError` and its `kind` are already imported in `client.ts` (`client.ts:1`) — no new import. `kind: "retryable"` follows the existing precedent in `classifyError` (`src/lib/ongoing/errors.ts:15-17`, #67): an unclassified/anomalous failure defaults to retryable rather than terminal, and the existing bounded retry-then-dead-letter pipeline (`src/lib/ongoing/retry-policy.ts`, `MAX_SYNC_RETRIES = 5`) already caps the blast radius if it keeps recurring. Once `putOrder` throws, both existing callers need **no code changes** — `pushOrderRecordSyncHandler`'s and `upsertOngoingOrderEditStep`'s existing `try/catch` blocks (`push-order-record-sync.ts:50-92`, `upsert-ongoing-order-edit.ts:37-103`) already classify the error, write `sync_state: "error"` with `error_class`/`last_error`, and rethrow — they just never got a chance to run before because `putOrder` used to return normally with `undefined` baked in. This is why the fix is entirely contained in `client.ts` plus its test file.
- Task 2: a one-time repair path for `OngoingOrderSync` rows already stuck in `sync_state: "sent"` with `ongoing_order_id: null` from before this fix shipped (see "Existing state" below). New `flagOrphanedOrderSyncsStep`/`flagOrphanedOrderSyncsWorkflow` (mirrors the existing `retryOngoingSyncsStep`/`retryOngoingSyncsWorkflow` vertical slice in `src/workflows/steps/retry-ongoing-syncs.ts` and `src/workflows/retry-ongoing-syncs.ts`) finds those rows and flips them to `sync_state: "error"`, `error_class: "retryable"`, `last_synced_at: null`. That state is then picked up automatically by the existing `ongoing-retry-failed-syncs` cron job (`src/jobs/retry-failed-syncs.ts`, queries exactly `sync_state: "error" AND error_class: "retryable"`, `isRetryDue` treats `null` `last_synced_at` as always due) or by an operator via the existing `POST /admin/ongoing/syncs/retry` route once the row shows up in the existing syncs dashboard query (`DASHBOARD_SYNC_STATES` already includes `"error"`, `src/api/admin/ongoing/syncs/route.ts:7`). No new admin UI is needed — the dashboard/retry flow already exists for `sync_state: "error"` rows; this plan only adds the one-time reclassification endpoint (mirrors the existing ops-only `POST /admin/ongoing/orders/[orderId]/repush` route, which also has no dedicated UI button).
- **Existing state check:** yes — rows with `sync_state: "sent"` and `ongoing_order_id: null` are a real, reachable pre-fix state. Before this fix, `pushOrderRecordSyncHandler` (`push-order-record-sync.ts:49-55,94-103`) unconditionally recorded `sync_state: "sent"` with `ongoing_order_id: ongoingOrderId` right after `putOrder` returned — if `putOrder` returned `{ ongoingOrderId: undefined }`, that `undefined` (or, for `upsertOngoingOrderEditStep`, the equivalent read at `upsert-ongoing-order-edit.ts:77,88`) flows straight into `recordSync`/`updateOngoingOrderSyncs`. `OngoingOrderSync.ongoing_order_id` is `model.number().nullable()` (`src/modules/ongoing/models/order-sync.ts:9`), so such a row persists indistinguishable from a legitimate `null`. Task 2 repairs exactly this state.

**Tech Stack:** Medusa 2.16.0, TypeScript 5.6 (`Node16` module resolution, decorators enabled — root `tsconfig.json`), yarn 4.6.0, Node >= 20, Jest (`@swc/jest`, `testEnvironment: "node"`, `clearMocks: true`, config at `jest.config.js`).

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6**; yarn **4.6.0**; Node **>= 20**.
- **Mutations only via workflows** (`medusa-dev:building-with-medusa` `arch-workflow-required`): Task 2's repair write goes through `flagOrphanedOrderSyncsWorkflow(req.scope).run(...)`, never a direct `updateOngoingOrderSyncs` call from the route — mirrors `src/api/admin/ongoing/syncs/retry/route.ts:28-30`.
- **Error classification precedent (#67):** an anomalous/unclassified failure defaults to `"retryable"`, never `"terminal"`, unless it's a deterministic 4xx validation error. Task 1's new `OngoingApiError` uses `kind: "retryable"`.
- **Test command:** `yarn test <path>` (Jest substring/path match); full suite `yarn test`.
- **No schema change:** `OngoingOrderSync.ongoing_order_id` is already `model.number().nullable()` (`src/modules/ongoing/models/order-sync.ts:9`) — Task 2 needs no migration.
- **Placeholder scan:** no `TODO`/`TBD`/`FIXME`/`<...>`/`XXX` anywhere in this plan.

---

## File Structure

**Modify (Task 1 — `putOrder` throws on missing/invalid `orderId`):**
- `src/lib/ongoing/client.ts` — `putOrder` (currently lines 114-117) validates `res.orderId` is a `number` before returning; throws `OngoingApiError` otherwise.
- `src/lib/ongoing/__tests__/client.operations.test.ts` — add `import { OngoingApiError } from "../errors"`; add two new `it(...)` cases to the `describe("OngoingClient operations", ...)` block (after the existing `"upserts an order and returns the ongoing id from the flat response"` test, lines 74-87).

**Create (Task 2 — data repair for orphaned `sent`/`null`-id rows):**
- `src/workflows/steps/flag-orphaned-order-syncs.ts` — `flagOrphanedOrderSyncsHandler` + `flagOrphanedOrderSyncsStep`.
- `src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts` — unit tests for the handler.
- `src/workflows/flag-orphaned-order-syncs.ts` — `flagOrphanedOrderSyncsWorkflow` (thin `createWorkflow` wrapper, mirrors `src/workflows/retry-ongoing-syncs.ts`).
- `src/api/admin/ongoing/syncs/repair-orphaned/route.ts` — `POST` handler, mirrors `src/api/admin/ongoing/syncs/retry/route.ts`.
- `src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts` — route unit test, mirrors `src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts`.

**Modify (Task 2, continued):**
- `src/workflows/index.ts` — add the two new barrel exports (`flagOrphanedOrderSyncsWorkflow`, `FlagOrphanedOrderSyncsOutput`).

**Depends on (already exists, unmodified):**
- `src/lib/ongoing/errors.ts` — `OngoingApiError`, `classifyError`, `classifyHttpStatus`.
- `src/lib/ongoing/retry-policy.ts` — `resolveRetryOutcome`, `computeRetryBackoffMs` (consumed downstream by the existing retry job; not called directly by this plan).
- `src/jobs/retry-failed-syncs.ts` — the existing cron sweep that will pick up Task 2's flagged rows on its next tick with zero changes.
- `src/api/admin/ongoing/syncs/route.ts` — the existing dashboard list query, already includes `"error"` in `DASHBOARD_SYNC_STATES`.
- `src/api/admin/ongoing/syncs/retry/route.ts` + `src/workflows/retry-ongoing-syncs.ts` + `src/workflows/steps/retry-ongoing-syncs.ts` — the existing operator-triggered retry vertical slice that Task 2 mirrors and that consumes Task 2's flagged rows.

---

## Task 1: `putOrder` throws instead of silently returning an undefined/null `ongoingOrderId` (TDD)

**Files:**
- Modify: `src/lib/ongoing/client.ts`
- Test: `src/lib/ongoing/__tests__/client.operations.test.ts`

**Interfaces:**
- Consumes: nothing new — `OngoingApiError` is already imported in `client.ts:1`.
- Produces: `OngoingClient.putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }>` keeps its exact signature. Behavior change only: on a 2xx response whose body's `orderId` is not a `number` (missing, `undefined`, or `null`), it now throws `OngoingApiError` with `kind: "retryable"` instead of returning `{ ongoingOrderId: undefined }`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/ongoing/__tests__/client.operations.test.ts`, add the import at the top (after the existing imports, currently lines 1-2):

```ts
import { OngoingClient } from "../client"
import { OngoingApiError } from "../errors"
import type { OngoingCredentials } from "../types"
```

Then add two new `it(...)` cases inside `describe("OngoingClient operations", ...)`, immediately after the existing `"upserts an order and returns the ongoing id from the flat response"` test (currently lines 74-87):

```ts
  it("throws a retryable OngoingApiError when the 2xx response omits orderId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ message: "Order queued" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putOrder({
        orderNumber: "1001-abc",
        goodsOwnerId: 7,
        deliveryDate: "2026-07-01T10:00:00.000Z",
        consignee: { name: "Ada Lovelace", postCode: "0155", countryCode: "no" },
      })
    ).rejects.toMatchObject({ kind: "retryable" })
  })

  it("throws a retryable OngoingApiError when the 2xx response has orderId: null", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderId: null, message: "Order queued" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putOrder({
        orderNumber: "1001-abc",
        goodsOwnerId: 7,
        deliveryDate: "2026-07-01T10:00:00.000Z",
        consignee: { name: "Ada Lovelace", postCode: "0155", countryCode: "no" },
      })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
```

The pre-existing `"upserts an order and returns the ongoing id from the flat response"` test (lines 74-87, `orderId: 999`) already covers the happy path (`orderId: 12345`-equivalent) — no change needed there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: both new tests FAIL. `putOrder` currently returns `{ ongoingOrderId: undefined }` for the first case (a resolved promise, not a rejection — `rejects` fails immediately) and `{ ongoingOrderId: null }` for the second. The pre-existing tests still pass.

- [ ] **Step 3: Fix `putOrder`**

In `src/lib/ongoing/client.ts`, replace (currently lines 114-117):

```ts
  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }> {
    const res = await this.request<{ orderId: number; message?: string }>("PUT", "/orders", order)
    return { ongoingOrderId: res.orderId }
  }
```

with:

```ts
  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }> {
    const res = await this.request<{ orderId?: number | null; message?: string }>(
      "PUT",
      "/orders",
      order
    )
    if (typeof res?.orderId !== "number") {
      // #108: a 2xx response that omits (or nulls) orderId must not silently flow
      // an undefined/null ongoing_order_id into the callers that persist it
      // (push-order-record-sync.ts, upsert-ongoing-order-edit.ts). Throw so the
      // existing OngoingApiError catch/record-error/retry pipeline (#67,
      // retry-policy.ts) handles it instead of a type-hole return value.
      throw new OngoingApiError(
        "Ongoing PUT /orders returned a 2xx response without a numeric orderId",
        { kind: "retryable", body: res }
      )
    }
    return { ongoingOrderId: res.orderId }
  }
```

(No new import — `OngoingApiError` is already imported at `client.ts:1`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: PASS — both new tests plus all pre-existing tests in the file (including `"upserts an order and returns the ongoing id from the flat response"`).

- [ ] **Step 5: Run the dependent caller test suites (no code change expected, confirm no regression)**

Run: `yarn test src/workflows/steps/__tests__/push-order-record-sync.test.ts src/workflows/steps/__tests__/upsert-ongoing-order-edit.test.ts`
Expected: PASS unchanged — both files already exercise `putOrder` throwing an `OngoingApiError` (e.g. `push-order-record-sync.test.ts`'s `"records a retryable error for a retryable OngoingApiError, then rethrows"`, lines 74-90) via a mocked `client.putOrder`, so Task 1's real-`client.ts` change is orthogonal to these mock-based tests and requires no edits here.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.operations.test.ts
git commit -m "fix(ongoing): throw when putOrder's 2xx response omits orderId (#108)"
```

---

## Task 2: Repair `OngoingOrderSync` rows already stuck `sent` with a missing `ongoing_order_id` (TDD)

**Files:**
- Create: `src/workflows/steps/flag-orphaned-order-syncs.ts`
- Test: `src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts`
- Create: `src/workflows/flag-orphaned-order-syncs.ts`
- Create: `src/api/admin/ongoing/syncs/repair-orphaned/route.ts`
- Test: `src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts`
- Modify: `src/workflows/index.ts`

**Interfaces:**
- Produces: `flagOrphanedOrderSyncsHandler(input: FlagOrphanedOrderSyncsInput, { container }: { container: any }): Promise<FlagOrphanedOrderSyncsOutput>` where `FlagOrphanedOrderSyncsInput = Record<string, never>` and `FlagOrphanedOrderSyncsOutput = { repaired: string[] }`. `flagOrphanedOrderSyncsStep` wraps it via `createStep`. `flagOrphanedOrderSyncsWorkflow` wraps the step via `createWorkflow`, exported from `src/workflows/index.ts`. `POST /admin/ongoing/syncs/repair-orphaned` runs the workflow with `{ input: {} }` and returns its result JSON (`{ repaired: string[] }`).
- Consumes: `ONGOING_MODULE`'s auto-generated `listOngoingOrderSyncs({ sync_state: "sent", ongoing_order_id: null })` and `updateOngoingOrderSyncs({ id, sync_state: "error", error_class: "retryable", last_error, last_synced_at: null })` — same auto-CRUD methods already used identically elsewhere (e.g. `src/workflows/steps/retry-ongoing-syncs.ts:29,41`).

- [ ] **Step 1: Write the failing step-handler tests**

Create `src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts`:

```ts
import { flagOrphanedOrderSyncsHandler } from "../flag-orphaned-order-syncs"

function makeContainer(rows: Array<{ id: string }>) {
  const listOngoingOrderSyncs = jest.fn().mockResolvedValue(rows)
  const updateOngoingOrderSyncs = jest.fn().mockResolvedValue({})
  const service = { listOngoingOrderSyncs, updateOngoingOrderSyncs }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, service }
}

// The createStep wrapper does not expose its invoke fn; test the exported handler
// directly, same pattern as retryOngoingSyncsHandler
// (src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts).
const invoke = (ctx: any) => flagOrphanedOrderSyncsHandler({}, ctx)

describe("flagOrphanedOrderSyncsHandler", () => {
  it("queries sent rows with a null ongoing_order_id", async () => {
    const { container, service } = makeContainer([])

    await invoke({ container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({
      sync_state: "sent",
      ongoing_order_id: null,
    })
  })

  it("flags each orphaned row to error/retryable and resets last_synced_at", async () => {
    const { container, service } = makeContainer([{ id: "oos_1" }, { id: "oos_2" }])

    const output = await invoke({ container })

    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledTimes(2)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      sync_state: "error",
      error_class: "retryable",
      last_error:
        "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push",
      last_synced_at: null,
    })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_2",
      sync_state: "error",
      error_class: "retryable",
      last_error:
        "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push",
      last_synced_at: null,
    })
    expect(output).toEqual({ repaired: ["oos_1", "oos_2"] })
  })

  it("returns an empty repaired list and issues no writes when there are no orphaned rows", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ repaired: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts`
Expected: FAIL — `Cannot find module '../flag-orphaned-order-syncs'` (the handler does not exist yet).

- [ ] **Step 3: Create the step**

Create `src/workflows/steps/flag-orphaned-order-syncs.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type FlagOrphanedOrderSyncsInput = Record<string, never>
export type FlagOrphanedOrderSyncsOutput = { repaired: string[] }

type OrphanedSyncRow = { id: string }

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: "sent"
    ongoing_order_id: null
  }) => Promise<OrphanedSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    sync_state: "error"
    error_class: "retryable"
    last_error: string
    last_synced_at: null
  }) => Promise<unknown>
}

const ORPHANED_SYNC_ERROR_MESSAGE =
  "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push"

// #108: putOrder used to return { ongoingOrderId: undefined } when Ongoing's 2xx body
// omitted orderId, and push-order-record-sync.ts/upsert-ongoing-order-edit.ts persisted
// that undefined (stored as null, OngoingOrderSync.ongoing_order_id is nullable) as
// sync_state="sent". putOrder now throws instead (client.ts), so no NEW rows can reach
// this state -- this step is a one-time repair for rows already stuck in it before the
// fix shipped. Flips each row to sync_state="error"/error_class="retryable" with
// last_synced_at reset to null so it is picked up by the existing retry pipeline: the
// ongoing-retry-failed-syncs job (src/jobs/retry-failed-syncs.ts) queries exactly
// sync_state="error" AND error_class="retryable", and isRetryDue treats a null
// last_synced_at as always due. Idempotent: once flipped, sync_state is no longer
// "sent" so a re-run finds nothing.
export async function flagOrphanedOrderSyncsHandler(
  _input: FlagOrphanedOrderSyncsInput,
  { container }: { container: any }
): Promise<FlagOrphanedOrderSyncsOutput> {
  const service: OngoingServiceLike = container.resolve(ONGOING_MODULE)

  const rows = await service.listOngoingOrderSyncs({
    sync_state: "sent",
    ongoing_order_id: null,
  })

  const repaired: string[] = []
  for (const row of rows) {
    await service.updateOngoingOrderSyncs({
      id: row.id,
      sync_state: "error",
      error_class: "retryable",
      last_error: ORPHANED_SYNC_ERROR_MESSAGE,
      last_synced_at: null,
    })
    repaired.push(row.id)
  }

  return { repaired }
}

export const flagOrphanedOrderSyncsStep = createStep(
  "flag-orphaned-order-syncs",
  async (input: FlagOrphanedOrderSyncsInput, context) => {
    const output = await flagOrphanedOrderSyncsHandler(input, context as any)
    return new StepResponse(output)
  }
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts`
Expected: PASS — all three tests.

- [ ] **Step 5: Write the failing route test**

Create `src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts`:

```ts
// Mock the workflows barrel BEFORE importing the route (hoisted by @swc/jest,
// same pattern as src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts).
const runMock = jest.fn()
jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  flagOrphanedOrderSyncsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { POST } from "../route"
import { flagOrphanedOrderSyncsWorkflow as flagOrphanedOrderSyncsWorkflowImport } from "../../../../../../workflows"

const flagOrphanedOrderSyncsWorkflow =
  flagOrphanedOrderSyncsWorkflowImport as jest.MockedFunction<
    typeof flagOrphanedOrderSyncsWorkflowImport
  >

const makeReq = () => ({ scope: {} }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  runMock.mockReset()
  flagOrphanedOrderSyncsWorkflow.mockClear()
})

describe("POST /admin/ongoing/syncs/repair-orphaned", () => {
  it("runs flagOrphanedOrderSyncsWorkflow with no input and returns its result", async () => {
    runMock.mockResolvedValue({ result: { repaired: ["oos_1"] } })
    const res = makeRes()

    await POST(makeReq(), res)

    expect(runMock).toHaveBeenCalledWith({ input: {} })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ repaired: ["oos_1"] })
  })

  it("returns an empty repaired list when there is nothing to flag", async () => {
    runMock.mockResolvedValue({ result: { repaired: [] } })
    const res = makeRes()

    await POST(makeReq(), res)

    expect(res.json).toHaveBeenCalledWith({ repaired: [] })
  })
})
```

- [ ] **Step 6: Run the route test to verify it fails**

Run: `yarn test src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts`
Expected: FAIL — `Cannot find module '../route'` (the route does not exist yet).

- [ ] **Step 7: Create the workflow, the route, and the barrel export**

Create `src/workflows/flag-orphaned-order-syncs.ts`:

```ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  flagOrphanedOrderSyncsStep,
  type FlagOrphanedOrderSyncsInput,
} from "./steps/flag-orphaned-order-syncs"

export const flagOrphanedOrderSyncsWorkflow = createWorkflow(
  "flag-orphaned-order-syncs",
  function (input: FlagOrphanedOrderSyncsInput) {
    const result = flagOrphanedOrderSyncsStep(input)
    return new WorkflowResponse(result)
  }
)

export default flagOrphanedOrderSyncsWorkflow
```

Create `src/api/admin/ongoing/syncs/repair-orphaned/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { flagOrphanedOrderSyncsWorkflow } from "../../../../../workflows"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { result } = await flagOrphanedOrderSyncsWorkflow(req.scope).run({
    input: {},
  })

  res.status(200).json(result)
}
```

In `src/workflows/index.ts`, add (after the existing `retryOngoingSyncsWorkflow` export block, currently lines 33-37):

```ts
export { flagOrphanedOrderSyncsWorkflow } from "./flag-orphaned-order-syncs"
export type { FlagOrphanedOrderSyncsOutput } from "./steps/flag-orphaned-order-syncs"
```

- [ ] **Step 8: Run the route test to verify it passes**

Run: `yarn test src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts`
Expected: PASS — both tests.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/steps/flag-orphaned-order-syncs.ts src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts src/workflows/flag-orphaned-order-syncs.ts src/api/admin/ongoing/syncs/repair-orphaned/route.ts src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts src/workflows/index.ts
git commit -m "fix(ongoing): add one-time repair for OngoingOrderSync rows orphaned by #108"
```

---

## Task 3: Full verification before review

No new code — run the full gates and confirm green.

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: PASS — all suites green, in particular `client.operations.test.ts`, `flag-orphaned-order-syncs.test.ts`, and `repair-orphaned/__tests__/route.test.ts` with their new/added cases, and no regression elsewhere (especially `push-order-record-sync.test.ts` and `upsert-ongoing-order-edit.test.ts`, which already assert the `OngoingApiError`-thrown path via mocks).

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: PASS — `medusa lint` (eslint flat config, `@medusajs/eslint-plugin` recommended) reports no errors on the new/modified files.

- [ ] **Step 3: Build**

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles to `.medusa/server` with no type errors (in particular `putOrder`'s narrowed `res?.orderId` check and the new `flag-orphaned-order-syncs` step/workflow/route).

- [ ] **Step 4: Confirm the diff scope**

Verify the working tree touches only: `src/lib/ongoing/client.ts`, `src/lib/ongoing/__tests__/client.operations.test.ts`, `src/workflows/steps/flag-orphaned-order-syncs.ts`, `src/workflows/steps/__tests__/flag-orphaned-order-syncs.test.ts`, `src/workflows/flag-orphaned-order-syncs.ts`, `src/api/admin/ongoing/syncs/repair-orphaned/route.ts`, `src/api/admin/ongoing/syncs/repair-orphaned/__tests__/route.test.ts`, `src/workflows/index.ts`. No changes to `doFetch`/`safeJson` (#107's scope), no schema/migration changes, no admin UI changes. Per `CLAUDE.md` ("Code review before merging"), the reviewer must independently load `medusa-dev:building-with-medusa` before merge.

---

## Self-Review (completed during planning)

- **Issue coverage:** File (`client.ts:115`) → Task 1. Failure scenario (undefined `orderId` persisted by both named callers) → Task 1's fix at the source plus Step 5's regression check that both callers already handle the thrown error correctly with zero code changes. Compare (`cancelOrder`'s `res?.orderId ?? ongoingOrderId` fallback) → explicitly not reused; the issue's own "Recommended fix" prefers the throw path ("Prefer the throw path so a missing orderId is surfaced, not silently persisted") over a silent fallback, which Task 1 follows. Recommended fix → Task 1. Relationship to #107 → stated explicitly above (narrow scope, no ordering dependency, justified by disjoint failure surfaces). Test cases (200 without `orderId`, 200 with `orderId: null`, 200 with `orderId: 12345`) → Task 1 Step 1's two new tests plus the pre-existing `orderId: 999` happy-path test. Existing-state check → answered above and covered by Task 2's repair path.
- **Placeholder scan:** no `TODO`/`TBD`/`FIXME`/`<...>`/`XXX`; every code step shows complete code; every command has expected output; no `path/to/...`-style placeholders.
- **Touched-file sets:** every task's Files/Interfaces block lists the exact file set up front; Task 2 groups the whole repair vertical (step + workflow + route + barrel export + two test files) into one task since they are one coherent, always-reviewed-together change, avoiding a one-file-per-task split.
- **No caller changes needed:** confirmed by reading `push-order-record-sync.ts:49-92` and `upsert-ongoing-order-edit.ts:37-103` — both already wrap their `putOrder` call in a `try/catch` that records `sync_state: "error"` with `error_class`/`last_error` and rethrows on any thrown error, and both already have passing unit tests asserting this for `OngoingApiError`. Task 1 Step 5 runs those suites unmodified to prove it.
- **Idempotency of Task 2:** `flagOrphanedOrderSyncsHandler` queries `sync_state: "sent" AND ongoing_order_id: null`; after a row is flagged its `sync_state` becomes `"error"`, so a second run of the same workflow finds nothing — safe to re-run (e.g. after a partial failure) or to leave wired as a standing ops endpoint.
