# cancelOngoingOrder Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `cancelOngoingOrder` workflow (issue #28) that cancels a Medusa order in Ongoing — but only when the order's `latest_status_code` is in the integration's `cancellable_status_codes` — and is fully idempotent under duplicate triggers from `cancelFulfillment` (#22) and the `order.canceled` subscriber (#32).

**Architecture:** A single Medusa workflow (`src/workflows/cancel-ongoing-order.ts`) composed of three custom steps under `src/workflows/steps/`: (1) load the `OngoingOrderSync` row + its `OngoingIntegration` and decide whether to cancel, (2) call the Ongoing client `cancelOrder(ongoingOrderId)`, (3) mark the sync row `cancelled`. The decision step gates on `cancellable_status_codes` *first* (only when `latest_status_code` is known) and short-circuits the idempotent no-op cases (already `cancelled`, null `ongoing_order_id`, known-but-non-cancellable status). In M2 `latest_status_code` is NULL until the status-poll milestone (M3/M4), so a null/unknown status **attempts** the cancel rather than skipping — see the M2 null-status note in Global Constraints. The Ongoing `DELETE /orders/{orderId}` call is added to `OngoingClient` as part of this work (the client currently has no DELETE). A 4xx from Ongoing on an already-cancelled order is swallowed as idempotent success.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests, native `fetch` (Node ≥20) for HTTP.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes). The service module-registration key resolved from the container is `"ongoing"` (`ONGOING_MODULE` in `src/modules/ongoing/index.ts`).
- Workflows live under `src/workflows/`; steps under `src/workflows/steps/`.
- Workflow composition functions: **no async, no arrow functions, no conditionals/ternaries/`??`/`?.`/`||`/spread, no `try-catch`, no loops** — use `transform()` / `when()`. One mutation per step.
- Prices/quantities stored as-is — never ×100 or ÷100.
- Plugin build output is `.medusa/server`; verify with `yarn build`.
- TDD: a **failing Jest unit test** comes before each piece of business logic (client `cancelOrder`, each workflow step). Tests mock the Ongoing client and the module service — there is no DB or running Medusa in this plugin repo (per the M1 plan, plugin tests are pure unit tests with mocked dependencies).
- `OngoingApiError.kind` classification (`retryable` | `terminal`) is reused for error capture, consistent with the other workflows.
- Decision order (user decision): **gate on `cancellable_status_codes` first** *only when `latest_status_code` is known*; treat a 4xx on an already-cancelled order as idempotent success (swallow).
- **M2 null-status behavior (canonical M2 contract):** `OngoingOrderSync.latest_status_code` is **NULL until the status-poll milestone (M3/M4)**. So in M2, for CANCEL, a null/unknown `latest_status_code` must **ATTEMPT** the cancel (run the DELETE) rather than skip — relying on Ongoing's own "you can only cancel before the warehouse has started" enforcement plus the terminal-4xx swallow for idempotent safety. This keeps cancellation FUNCTIONAL in M2. Strict `cancellable_status_codes` gating still applies once `latest_status_code` is known.

---

## Background — verified facts the implementer must not re-derive

- **Ongoing cancel endpoint:** `DELETE /api/v1/orders/{orderId}` (OpenAPI v57, operationId `Orders_Delete`). `orderId` is an int32 **path** param. "You can only cancel an order if the warehouse has not started working on it." Returns `PostOrderResponse` `{ orderId, message }`. There is **no** `cancel` field on `PostOrderModel` — cancellation is the DELETE, not a status set.
- **Client today** (`src/lib/ongoing/client.ts`): `request<T>(method, path, body?)` and `doFetch<T>(method, path, body?)` both type `method` as `"GET" | "PUT"` only. There is **no** cancel/DELETE method. This plan widens the union to include `"DELETE"` and adds `cancelOrder`.
- **Which id to send:** use `OngoingOrderSync.ongoing_order_id` (the int captured from the push response — `src/modules/ongoing/models/order-sync.ts:9`), **not** `ongoing_order_number`. If `ongoing_order_id` is `null` (push never succeeded), there is nothing to cancel → no-op success.
- **`OngoingIntegration.cancellable_status_codes`** is `model.json().nullable()` (`src/modules/ongoing/models/integration.ts:16`). Treat it as `number[] | null`. The strict `cancellable_status_codes` gate only applies **when `latest_status_code` is known**: if the status is known and either the codes list is `null`/empty or the status is not in it ⇒ no-op success. When `latest_status_code` is null/unknown (the M2 reality), the codes list is **not** consulted — the workflow attempts the cancel (see next bullet).
- **`OngoingOrderSync.sync_state`** enum: `pending | sent | shipped | cancelled | error` (`order-sync.ts:12`). `latest_status_code` is `number | null` (`order-sync.ts:10`). **It is NULL throughout M2** — nothing populates it until the status-poll milestone (M3/M4). For CANCEL this means the M2 path is the null-status **attempt** path: the gate must not skip on null status.
- **Two converging triggers** (spec §5, §8): provider `cancelFulfillment` (#22) and the `order.canceled` subscriber (#32) both call this workflow; it must converge safely (idempotent).

---

## File Structure

**Create:**
- `src/workflows/steps/decide-ongoing-cancel.ts` — load sync row + integration, decide cancel vs no-op (the gate).
- `src/workflows/steps/cancel-ongoing-order.ts` — call `client.cancelOrder`, swallow already-cancelled 4xx, capture errors.
- `src/workflows/steps/mark-order-sync-cancelled.ts` — set `sync_state = "cancelled"` on the row.
- `src/workflows/cancel-ongoing-order.ts` — the workflow composition (`cancelOngoingOrderWorkflow`).
- `src/workflows/index.ts` — workflows barrel (export `cancelOngoingOrderWorkflow`); **create only if it does not already exist**, otherwise modify.
- Tests:
  - `src/lib/ongoing/__tests__/client.cancel.test.ts`
  - `src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts`
  - `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`
  - `src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`

**Modify:**
- `src/lib/ongoing/client.ts` — widen `request`/`doFetch` method union to include `"DELETE"`; add `cancelOrder(ongoingOrderId: number)`.

---

## Task 1: Client `cancelOrder` + `DELETE` support

> **Note (M2 rationale):** the `cancelOrder`/DELETE addition and the `"DELETE"` method-union widening are the mechanism that makes the M2 null-status **attempt** path safe — because `latest_status_code` isn't populated until the status-poll milestone (M3/M4), the workflow attempts the DELETE and relies on Ongoing's own "cancel only before the warehouse starts" enforcement, swallowing the terminal 4xx as idempotent success (Task 3).

**Files:**
- Modify: `src/lib/ongoing/client.ts`
- Test: `src/lib/ongoing/__tests__/client.cancel.test.ts`

**Interfaces:**
- Consumes: existing `request<T>` core, `OngoingApiError` (already imported in `client.ts`).
- Produces, on `OngoingClient`:
  - `cancelOrder(ongoingOrderId: number): Promise<{ ongoingOrderId: number; message?: string }>` — issues `DELETE /orders/{ongoingOrderId}` and maps the `PostOrderResponse` (`{ orderId, message }`). Re-throws `OngoingApiError` unchanged (the workflow step, not the client, decides what to swallow).
  - `request`/`doFetch` `method` parameter type widened from `"GET" | "PUT"` to `"GET" | "PUT" | "DELETE"`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/client.cancel.test.ts`:
```ts
import { OngoingClient } from "../client"
import { OngoingApiError } from "../errors"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "wh-a",
  baseUrl: "https://api.example.test/api/v1",
  username: "u",
  password: "p",
  goodsOwnerId: 7,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("OngoingClient.cancelOrder", () => {
  it("issues DELETE /orders/{id} and maps the response", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(json(200, { orderId: 999, message: "Cancelled" }))
    const client = new OngoingClient(creds, { fetchImpl })

    const result = await client.cancelOrder(999)

    expect(result).toEqual({ ongoingOrderId: 999, message: "Cancelled" })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders/999")
    expect(init.method).toBe("DELETE")
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("u:p").toString("base64")
    )
  })

  it("propagates a terminal OngoingApiError on 4xx", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(json(400, { message: "Order already cancelled" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.cancelOrder(999)).rejects.toBeInstanceOf(OngoingApiError)
    await expect(client.cancelOrder(999)).rejects.toMatchObject({
      kind: "terminal",
      status: 400,
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.cancel.test.ts`
Expected: FAIL — `client.cancelOrder is not a function`.

- [ ] **Step 3: Widen the method union**

In `src/lib/ongoing/client.ts`, change the `request` signature:
```ts
  protected async request<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
```
and the `doFetch` signature:
```ts
  private async doFetch<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
```

- [ ] **Step 4: Add the `cancelOrder` operation**

In `src/lib/ongoing/client.ts`, inside the `OngoingClient` class, in the `// --- public operations ---` block (immediately after the `putOrder` method), add:
```ts
  async cancelOrder(ongoingOrderId: number): Promise<{ ongoingOrderId: number; message?: string }> {
    const res = await this.request<any>("DELETE", `/orders/${ongoingOrderId}`)
    return {
      ongoingOrderId: res?.orderId ?? ongoingOrderId,
      message: res?.message,
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.cancel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full lib suite to confirm no regression**

Run: `yarn test src/lib/ongoing`
Expected: PASS (all lib tests green — existing request/operations tests still pass with the widened union).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.cancel.test.ts
git commit -m "feat(ongoing-client): add cancelOrder (DELETE /orders/{id}) for #28"
```

---

## Task 2: Decision step — gate on cancellable_status_codes

**Files:**
- Create: `src/workflows/steps/decide-ongoing-cancel.ts`
- Test: `src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts`

**Interfaces:**
- Consumes: the `"ongoing"` module service from the container (auto-CRUD `listOngoingOrderSyncs`, `listOngoingIntegrations`).
- Produces:
  - `type DecideCancelInput = { medusa_order_id?: string; medusa_fulfillment_id?: string; ongoing_order_number?: string }` — at least one identifier; the step prefers `ongoing_order_number`, then `medusa_fulfillment_id`, then `medusa_order_id`.
  - `type CancelDecision = { shouldCancel: boolean; reason: "ok" | "status_unknown_attempt" | "no_sync_row" | "already_cancelled" | "no_ongoing_order_id" | "status_not_cancellable"; orderSyncId?: string; ongoingOrderId?: number; credentialKey?: string }`
  - `export const decideOngoingCancelStep` — a `createStep` returning `StepResponse<CancelDecision>`.

Notes for the implementer:
- A normal step **is** `async` and **may** use `if`/`?.`/`??` — only the *workflow composition* function is restricted. Put all the branching logic here in the step.
- `cancellable_status_codes` is stored JSON; coerce defensively to `number[]` (`Array.isArray(x) ? x : []`).
- Resolve the integration by the sync row's `integration_id`. Map `credentialKey` from `integration.credential_key` so later workflows/steps can build a client if needed (not used by this workflow directly, but kept on the decision for parity with the other workflows' error capture, which key on `credential_key`).
- **M2 null-status note:** `latest_status_code` is NULL until the status-poll milestone (M3/M4), so check #4 below splits on whether the status is *known*. A null/unknown status **attempts** the cancel (`shouldCancel: true`, reason `status_unknown_attempt`), relying on the DELETE + terminal-4xx swallow (Task 3) for idempotent safety. The strict `cancellable_status_codes` gate only fires for a *known* status. This is the documented M2 behavior precisely because `latest_status_code` isn't populated until status-poll lands.
- Order of checks (idempotency short-circuits first, then the status gate; checks 1–4 yield `shouldCancel: false` no-ops, check 5 attempts):
  1. No sync row found → `{ shouldCancel: false, reason: "no_sync_row" }`.
  2. `sync_state === "cancelled"` → `{ shouldCancel: false, reason: "already_cancelled", orderSyncId }`.
  3. `ongoing_order_id == null` → `{ shouldCancel: false, reason: "no_ongoing_order_id", orderSyncId }`.
  4. `latest_status_code` is **known** (not null/undefined) AND not in `cancellable_status_codes` → `{ shouldCancel: false, reason: "status_not_cancellable", orderSyncId }`.
  5. otherwise → `{ shouldCancel: true, orderSyncId, ongoingOrderId, credentialKey }` with `reason: "ok"` when the status was known-and-cancellable, or `reason: "status_unknown_attempt"` when `latest_status_code` is null/undefined (the M2 path).

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts`:
```ts
import { decideOngoingCancelStep } from "../decide-ongoing-cancel"

// Invoke the step's inner handler directly with a mocked container.
const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service }
  // createStep stores the handler; call it via the step's `invoke` API.
  return (decideOngoingCancelStep as any).invoke.run({ input, container })
}

const baseSync = {
  id: "osync_1",
  integration_id: "oint_1",
  ongoing_order_id: 999,
  latest_status_code: 100,
  sync_state: "sent",
  ongoing_order_number: "1001-abc",
}

const integration = {
  id: "oint_1",
  credential_key: "wh-a",
  cancellable_status_codes: [100, 110],
}

const makeService = (overrides: any = {}) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(overrides.syncs ?? [baseSync]),
  listOngoingIntegrations: jest
    .fn()
    .mockResolvedValue(overrides.integrations ?? [integration]),
})

describe("decideOngoingCancelStep", () => {
  it("decides cancel when status is in cancellable_status_codes", async () => {
    const res = await invoke({ ongoing_order_number: "1001-abc" }, makeService())
    expect(res.output).toEqual({
      shouldCancel: true,
      reason: "ok",
      orderSyncId: "osync_1",
      ongoingOrderId: 999,
      credentialKey: "wh-a",
    })
  })

  it("no-ops when status is not cancellable", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, latest_status_code: 500 }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("status_not_cancellable")
  })

  it("ATTEMPTS the cancel (M2) when latest_status_code is null/unknown", async () => {
    // M2 reality: latest_status_code is NULL until the status-poll milestone.
    // The gate must not skip on null status — it attempts, relying on the
    // DELETE + terminal-4xx swallow (Task 3) for idempotent safety.
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, latest_status_code: null }] })
    )
    expect(res.output.shouldCancel).toBe(true)
    expect(res.output.reason).toBe("status_unknown_attempt")
    expect(res.output).toMatchObject({
      orderSyncId: "osync_1",
      ongoingOrderId: 999,
      credentialKey: "wh-a",
    })
  })

  it("no-ops (idempotent) when sync_state is already cancelled", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, sync_state: "cancelled" }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("already_cancelled")
  })

  it("no-ops when ongoing_order_id is null (push never succeeded)", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, ongoing_order_id: null }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("no_ongoing_order_id")
  })

  it("no-ops when no sync row exists", async () => {
    const res = await invoke(
      { medusa_order_id: "order_unknown" },
      makeService({ syncs: [] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("no_sync_row")
  })

  it("treats empty/null cancellable_status_codes as nothing-cancellable", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ integrations: [{ ...integration, cancellable_status_codes: null }] })
    )
    expect(res.output.reason).toBe("status_not_cancellable")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts`
Expected: FAIL — cannot find module `../decide-ongoing-cancel`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/decide-ongoing-cancel.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export type DecideCancelInput = {
  medusa_order_id?: string
  medusa_fulfillment_id?: string
  ongoing_order_number?: string
}

export type CancelDecisionReason =
  | "ok"
  | "status_unknown_attempt"
  | "no_sync_row"
  | "already_cancelled"
  | "no_ongoing_order_id"
  | "status_not_cancellable"

export type CancelDecision = {
  shouldCancel: boolean
  reason: CancelDecisionReason
  orderSyncId?: string
  ongoingOrderId?: number
  credentialKey?: string
}

function buildFilter(input: DecideCancelInput): Record<string, string> {
  if (input.ongoing_order_number) {
    return { ongoing_order_number: input.ongoing_order_number }
  }
  if (input.medusa_fulfillment_id) {
    return { medusa_fulfillment_id: input.medusa_fulfillment_id }
  }
  if (input.medusa_order_id) {
    return { medusa_order_id: input.medusa_order_id }
  }
  return {}
}

export const decideOngoingCancelStep = createStep(
  "decide-ongoing-cancel",
  async (input: DecideCancelInput, { container }): Promise<StepResponse<CancelDecision>> => {
    const ongoing = container.resolve("ongoing") as any

    const filter = buildFilter(input)
    const syncs = await ongoing.listOngoingOrderSyncs(filter)
    const sync = syncs?.[0]

    if (!sync) {
      return new StepResponse({ shouldCancel: false, reason: "no_sync_row" })
    }

    if (sync.sync_state === "cancelled") {
      return new StepResponse({
        shouldCancel: false,
        reason: "already_cancelled",
        orderSyncId: sync.id,
      })
    }

    if (sync.ongoing_order_id === null || sync.ongoing_order_id === undefined) {
      return new StepResponse({
        shouldCancel: false,
        reason: "no_ongoing_order_id",
        orderSyncId: sync.id,
      })
    }

    const [integration] = await ongoing.listOngoingIntegrations({
      id: sync.integration_id,
    })

    const raw = integration?.cancellable_status_codes
    const codes: number[] = Array.isArray(raw) ? raw : []
    const status = sync.latest_status_code
    const statusKnown = status !== null && status !== undefined

    // M2: latest_status_code is NULL until the status-poll milestone (M3/M4).
    // When the status is unknown, ATTEMPT the cancel — the DELETE + terminal-4xx
    // swallow (cancel step) gives idempotent safety. The strict
    // cancellable_status_codes gate only applies once the status is known.
    if (statusKnown && !codes.includes(status)) {
      return new StepResponse({
        shouldCancel: false,
        reason: "status_not_cancellable",
        orderSyncId: sync.id,
      })
    }

    return new StepResponse({
      shouldCancel: true,
      reason: statusKnown ? "ok" : "status_unknown_attempt",
      orderSyncId: sync.id,
      ongoingOrderId: sync.ongoing_order_id,
      credentialKey: integration?.credential_key,
    })
  }
)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/decide-ongoing-cancel.ts src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts
git commit -m "feat(ongoing-workflows): cancel-gate decision step keyed on cancellable_status_codes (#28)"
```

---

## Task 3: Cancel step — call client, swallow already-cancelled 4xx

**Files:**
- Create: `src/workflows/steps/cancel-ongoing-order.ts`
- Test: `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`

**Interfaces:**
- Consumes: the `"ongoing"` module service (`getClient(credentialKey)` from `src/modules/ongoing/service.ts`); `OngoingApiError` from `src/lib/ongoing/errors`.
- Produces:
  - `type CancelStepInput = { ongoingOrderId: number; credentialKey: string }`
  - `type CancelStepResult = { cancelled: boolean; swallowed: boolean }` — `cancelled: true` on a clean DELETE; `swallowed: true` when a `terminal` 4xx was treated as already-cancelled (idempotent success).
  - `export const cancelOngoingOrderStep` — `createStep` returning `StepResponse<CancelStepResult>`.

Notes for the implementer:
- Resolve the client via `ongoing.getClient(credentialKey)` (the service already builds a throttled client from plugin options).
- Swallow rule (user decision): if `client.cancelOrder` throws an `OngoingApiError` with `kind === "terminal"` (4xx — Ongoing rejecting because the order is already cancelled / not cancellable on their side), return `{ cancelled: false, swallowed: true }` so the workflow still proceeds to mark the row `cancelled`. A `retryable` error (429/5xx/network) is **re-thrown** so the workflow fails and `retryFailedSyncs` can re-attempt — consistent with the error taxonomy in spec §11.
- This step has no compensation: a DELETE in Ongoing is terminal and the `PUT /orders` upsert is the only "un-cancel" path, which is out of scope here. Leave compensation off.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`:
```ts
import { cancelOngoingOrderStep } from "../cancel-ongoing-order"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const invoke = (input: any, client: any) => {
  const service = { getClient: jest.fn().mockReturnValue(client) }
  const container = { resolve: (_: string) => service }
  return (cancelOngoingOrderStep as any).invoke.run({ input, container })
}

describe("cancelOngoingOrderStep", () => {
  it("calls client.cancelOrder with the ongoing order id", async () => {
    const cancelOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const res = await invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    expect(cancelOrder).toHaveBeenCalledWith(999)
    expect(res.output).toEqual({ cancelled: true, swallowed: false })
  })

  it("swallows a terminal 4xx (already cancelled) as idempotent success", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("already cancelled", { status: 400, kind: "terminal" })
    )
    const res = await invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
  })

  it("re-throws a retryable error (429/5xx) so retryFailedSyncs can re-attempt", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("down", { status: 503, kind: "retryable" })
    )
    await expect(
      invoke({ ongoingOrderId: 999, credentialKey: "wh-a" }, { cancelOrder })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`
Expected: FAIL — cannot find module `../cancel-ongoing-order`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/cancel-ongoing-order.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { OngoingApiError } from "../../lib/ongoing/errors"

export type CancelStepInput = {
  ongoingOrderId: number
  credentialKey: string
}

export type CancelStepResult = {
  cancelled: boolean
  swallowed: boolean
}

export const cancelOngoingOrderStep = createStep(
  "cancel-ongoing-order",
  async (input: CancelStepInput, { container }): Promise<StepResponse<CancelStepResult>> => {
    const ongoing = container.resolve("ongoing") as any
    const client = ongoing.getClient(input.credentialKey)

    try {
      await client.cancelOrder(input.ongoingOrderId)
      return new StepResponse({ cancelled: true, swallowed: false })
    } catch (err) {
      if (err instanceof OngoingApiError && err.kind === "terminal") {
        // 4xx — Ongoing already cancelled / cannot cancel: idempotent success.
        return new StepResponse({ cancelled: false, swallowed: true })
      }
      throw err
    }
  }
)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/cancel-ongoing-order.ts src/workflows/steps/__tests__/cancel-ongoing-order.test.ts
git commit -m "feat(ongoing-workflows): cancel step swallows already-cancelled 4xx, re-throws retryable (#28)"
```

---

## Task 4: Mark-cancelled step

**Files:**
- Create: `src/workflows/steps/mark-order-sync-cancelled.ts`
- Test: `src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`

**Interfaces:**
- Consumes: the `"ongoing"` module service (`updateOngoingOrderSyncs`).
- Produces:
  - `type MarkCancelledInput = { orderSyncId: string }`
  - `export const markOrderSyncCancelledStep` — `createStep` that sets `sync_state = "cancelled"`, `last_error = null`, `error_class = null`, and `last_synced_at = new Date()`. Returns `StepResponse<{ orderSyncId: string }>`. Idempotent: setting `cancelled` on an already-`cancelled` row is a harmless write.

Notes for the implementer:
- `MedusaService` auto-CRUD update signature: `updateOngoingOrderSyncs({ id, ...fields })`.
- No compensation: reverting `sync_state` after a confirmed Ongoing cancel would misrepresent reality; leave it off.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`:
```ts
import { markOrderSyncCancelledStep } from "../mark-order-sync-cancelled"

const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service }
  return (markOrderSyncCancelledStep as any).invoke.run({ input, container })
}

describe("markOrderSyncCancelledStep", () => {
  it("sets sync_state to cancelled and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "osync_1" }])
    const res = await invoke(
      { orderSyncId: "osync_1" },
      { updateOngoingOrderSyncs }
    )

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("osync_1")
    expect(arg.sync_state).toBe("cancelled")
    expect(arg.error_class).toBeNull()
    expect(arg.last_error).toBeNull()
    expect(res.output).toEqual({ orderSyncId: "osync_1" })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`
Expected: FAIL — cannot find module `../mark-order-sync-cancelled`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/mark-order-sync-cancelled.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export type MarkCancelledInput = {
  orderSyncId: string
}

export const markOrderSyncCancelledStep = createStep(
  "mark-order-sync-cancelled",
  async (input: MarkCancelledInput, { container }): Promise<StepResponse<{ orderSyncId: string }>> => {
    const ongoing = container.resolve("ongoing") as any

    await ongoing.updateOngoingOrderSyncs({
      id: input.orderSyncId,
      sync_state: "cancelled",
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
    })

    return new StepResponse({ orderSyncId: input.orderSyncId })
  }
)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/mark-order-sync-cancelled.ts src/workflows/steps/__tests__/mark-order-sync-cancelled.test.ts
git commit -m "feat(ongoing-workflows): mark-order-sync-cancelled step (#28)"
```

---

## Task 5: Workflow composition + barrel export

**Files:**
- Create: `src/workflows/cancel-ongoing-order.ts`
- Create or Modify: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `decideOngoingCancelStep` (Task 2), `cancelOngoingOrderStep` (Task 3), `markOrderSyncCancelledStep` (Task 4).
- Produces:
  - `type CancelOngoingOrderInput = DecideCancelInput` (exactly `{ medusa_order_id?: string; medusa_fulfillment_id?: string; ongoing_order_number? : string }` — **NO `order_id` key**). This is the canonical M2 cancel-workflow input contract (#28 owns); consumers #22 and #32 pass only these keys.
  - **Named export** `cancelOngoingOrderWorkflow` (canonical — #32 imports the *named* export) — `createWorkflow` that runs the decision step, then **only when `decision.shouldCancel`** (via `when()`) runs the cancel step followed by the mark-cancelled step. Returns `WorkflowResponse<CancelDecision>` (the `CancelDecision { shouldCancel; reason; ... }`, so callers/tests can assert what happened). A `default export` of the same workflow may also exist for convenience, but the **named export is the contract**.
  - **Gate resolution order** (canonical): the decision step resolves the sync row preferring `ongoing_order_number`, then `medusa_fulfillment_id`, then `medusa_order_id` (see Task 2 `buildFilter`).
  - `src/workflows/index.ts` re-exports `cancelOngoingOrderWorkflow`.

Composition constraints reminder: the `when()` predicate and any field plumbing into the cancel step must go through `transform()` — no `?.`/`??`/object-spread in the composition body. Inside the `when().then()` block, derive the cancel-step input with `transform()` from the decision.

- [ ] **Step 1: Implement the workflow composition**

Create `src/workflows/cancel-ongoing-order.ts`:
```ts
import {
  createWorkflow,
  WorkflowResponse,
  transform,
  when,
} from "@medusajs/framework/workflows-sdk"
import {
  decideOngoingCancelStep,
  type DecideCancelInput,
  type CancelDecision,
} from "./steps/decide-ongoing-cancel"
import { cancelOngoingOrderStep } from "./steps/cancel-ongoing-order"
import { markOrderSyncCancelledStep } from "./steps/mark-order-sync-cancelled"

export type CancelOngoingOrderInput = DecideCancelInput

export const cancelOngoingOrderWorkflow = createWorkflow(
  "cancel-ongoing-order",
  function (input: CancelOngoingOrderInput) {
    const decision = decideOngoingCancelStep(input)

    when(decision, (d: CancelDecision) => d.shouldCancel).then(() => {
      const cancelInput = transform({ decision }, (data) => ({
        ongoingOrderId: data.decision.ongoingOrderId as number,
        credentialKey: data.decision.credentialKey as string,
      }))

      cancelOngoingOrderStep(cancelInput)

      const markInput = transform({ decision }, (data) => ({
        orderSyncId: data.decision.orderSyncId as string,
      }))

      markOrderSyncCancelledStep(markInput)
    })

    return new WorkflowResponse(decision)
  }
)

export default cancelOngoingOrderWorkflow
```

- [ ] **Step 2: Create or update the workflows barrel**

If `src/workflows/index.ts` does NOT exist, create it:
```ts
export { cancelOngoingOrderWorkflow } from "./cancel-ongoing-order"
```
If it already exists, add the line above to it (do not remove existing exports).

- [ ] **Step 3: Run the entire test suite**

Run: `yarn test`
Expected: all suites PASS (client cancel, decision, cancel, mark, plus all pre-existing M1 suites).

- [ ] **Step 4: Build the plugin to validate compilation + workflow composition**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`. This catches workflow-composition mistakes (e.g. illegal `?.` in the composition body) that unit tests can't.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/cancel-ongoing-order.ts src/workflows/index.ts
git commit -m "feat(ongoing-workflows): cancelOngoingOrder workflow, idempotent + status-gated (#28)"
```

---

## Self-Review (completed during planning)

- **Issue #28 coverage:**
  - Cancel in Ongoing when `latest_status_code ∈ cancellable_status_codes` (known status) → decision step gates on known status (Task 2, check #4), workflow runs cancel only `when(decision.shouldCancel)` (Task 5) ✓
  - **M2 null-status reality** → `latest_status_code` is NULL until status-poll (M3/M4); the gate ATTEMPTS the cancel on null/unknown status (`status_unknown_attempt`, Task 2 check #5), relying on the DELETE + terminal-4xx swallow (Task 3). Keeps cancel FUNCTIONAL in M2. Strict gating still applies once codes are known ✓
  - Idempotent under duplicate triggers → `already_cancelled` short-circuit (Task 2), no-op `when` path, harmless re-write in mark step (Task 4); both #22 and #32 converge on the same workflow (via the canonical **named** export) ✓
  - Gate ordering → decision step applies the strict status gate (known status only) after the cheap idempotency short-circuits; unknown status attempts ✓
  - 4xx already-cancelled swallowed as idempotent success (user decision) → cancel step swallows `terminal` errors (Task 3); this is what makes the M2 attempt path safe ✓
  - Use `ongoing_order_id` not `ongoing_order_number`; null id → no-op → Task 2 check #3, Task 3 sends `ongoingOrderId` ✓
  - Client `cancelOrder` + DELETE union (required by issue) → Task 1 ✓
  - Error taxonomy / retryable re-throw consistent with other workflows → Task 3 re-throws `retryable` ✓
  - `yarn build` step → Task 5 Step 4 ✓
- **Tests-to-specify checklist (from the issue):** cancellable→cancelOrder called + state→cancelled (Task 2 cancel decision + Task 4 + workflow); known-non-cancellable→skipped/no call (Task 2 `status_not_cancellable` + `when` gate); **null/unknown status→ATTEMPT (M2)** (Task 2 `status_unknown_attempt` test) with the attempt's terminal 4xx swallowed as success (Task 3 swallow test); null ongoing_order_id→no-op (Task 2); duplicate/already-cancelled→idempotent no-op (Task 2 `already_cancelled`); 4xx already-cancelled→swallowed (Task 3); client DELETE addition (Task 1). All present ✓
- **Placeholder scan:** every code step contains complete code; the only conditional note (`src/workflows/index.ts` create-vs-modify) states the exact line to add. No TBD/TODO ✓
- **Type consistency:** `CancelDecision` produced by Task 2 is consumed unchanged by Task 5's `when`/`transform`; `cancelOngoingOrderStep` input `{ ongoingOrderId, credentialKey }` (Task 3) matches the `transform` output in Task 5; `markOrderSyncCancelledStep` input `{ orderSyncId }` (Task 4) matches Task 5; `client.cancelOrder(ongoingOrderId: number)` (Task 1) matches the call in Task 3 ✓

## Verify-points carried at implementation time

- The step-handler test harness uses `(step as any).invoke.run({ input, container })`. If the installed `@medusajs/framework` 2.16.0 exposes the step handler under a different property than `.invoke.run`, adjust the `invoke` helper in each step test accordingly (the handler signature `(input, { container }) => Promise<StepResponse>` is stable; only the access path may differ). Confirm against the first failing run.
- `when().then()` returning void inside the composition (no captured output) is the intended shape — the workflow returns the `decision`, not the cancel result.
```