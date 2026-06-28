# pushOrderToOngoing Workflow Implementation Plan (Issue #26)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `pushOrderToOngoing` workflow that re-queries a Medusa fulfillment's full order, maps it to Ongoing's `PostOrderModel`, idempotently upserts it via `PUT /api/v1/orders`, and records an `OngoingOrderSync` row capturing success or a classified error.

**Architecture:** Three composed steps under `src/workflows/` driven by `@medusajs/framework/workflows-sdk` (`createWorkflow`/`createStep`/`StepResponse`/`WorkflowResponse`). Step 1 re-queries the fulfillment + linked order via the container's `QUERY` registration through the shared `reQueryFulfillmentOrder(query, fulfillmentId)` helper this plan owns and EXPORTS (so #27 imports the same helper), then resolves each line's `article_number` by calling the issue #29 `resolveArticleNumber(query, sku)` per line. Step 2 maps the queried + resolved data to a `PostOrderModel` by composing the issue #24 mapper (`mapOrderToPostOrderModel(input: MapOrderInput)`) and the issue #25 order-number function (`buildOngoingOrderNumber({ displayId, fulfillmentId })`). Step 3 persists the order number to `OngoingOrderSync` (so retries are idempotent), calls `OngoingClient.putOrder`, and on success/failure writes the sync state through a new `recordSync` service helper; its compensation captures `error_class`/`last_error`. A required fix to `OngoingClient.putOrder` (Ongoing's real flat `{orderId, message}` response) lands in this plan with its client unit test.

This workflow **conforms** to the canonical M2 contracts owned by #24/#25/#29 and **owns/exports** the workflow (`pushOrderToOngoing`, input `{ fulfillment_id }`, output `{ ongoingOrderId, orderNumber }`) and the shared re-query helper (`reQueryFulfillmentOrder`).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`, `@medusajs/framework/utils` `ContainerRegistrationKeys`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (mocked client + query + service; no live DB).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes).
- Prices/quantities sent to Ongoing **as-is** — never ×100 or ÷100.
- Workflows live under `src/workflows/`; steps under `src/workflows/steps/`.
- Workflow composition functions: **no async, no arrow functions, no conditionals/ternaries, no `??`/`?.`/`||`, no object spread** — use `transform()`/`when()`. Each step is one mutation.
- TDD: a **failing Jest unit test first** for every behavior; tests mock the Ongoing client, the `QUERY` graph, and the module service — **no live DB**.
- No placeholders: every code step contains the full code.
- This is a **plugin**: verify wiring with `yarn build` (no local Medusa/Postgres instance).

## Dependencies (composed by this workflow — referenced by name, implemented in their own issues)

- **#24 `mapOrderToPostOrderModel`** — pure mapper `(input: MapOrderInput) => PostOrderModel`. `MapOrderInput` is a **single flat object** `{ goods_owner_id, order_number, delivery_date, currency_code, email?, shipping_address, lines: Array<{ article_number, quantity, weight?, unit_price? }> }`; the lines already carry resolved `article_number`. The mapper is PURE and sets `orderNumber`/`goodsOwnerId` from `MapOrderInput` itself — callers must **not** re-stamp them. Imported from `src/lib/ongoing/order-mapper.ts` (export `mapOrderToPostOrderModel`). Hard blocker; coordinate so #24 lands first.
- **#25 `buildOngoingOrderNumber`** — `(input: { displayId: string | number; fulfillmentId: string }) => string` (**single object arg**), deterministic `"<display_id>-<short fulfillment id>"`. Imported from `src/lib/ongoing/order-number.ts`.
- **#29 `resolveArticleNumber`** — `(query, sku: string) => Promise<string>`, **async, per-SKU**, needs the container `query`; throws a terminal `OngoingApiError` on collision/missing SKU. Imported from `src/lib/ongoing/resolve-article-number.ts` (export `resolveArticleNumber`). There is **no** `resolveSkuCollisions` and **no** `src/lib/ongoing/sku-resolver.ts`.

> These three are hard blockers (GitHub blocked-by). This plan calls them through stable import paths/signatures; it does **not** reimplement them. The mapper step's unit tests mock these modules so this task is testable independently of their internals.

---

## File Structure

**Create:**
- `src/lib/ongoing/re-query-fulfillment-order.ts` — the shared `reQueryFulfillmentOrder(query, fulfillmentId)` helper this plan OWNS and EXPORTS (imported by both the re-query step here and by #27). Plain async function.
- `src/workflows/steps/query-fulfillment-order.ts` — re-query step: calls the shared helper, then resolves each line's `article_number` via #29 `resolveArticleNumber(query, sku)`.
- `src/workflows/steps/map-order-to-ongoing.ts` — mapping step (composes #24 mapper + #25 order-number; consumes the already-resolved lines).
- `src/workflows/steps/push-order-record-sync.ts` — call `putOrder` + record sync, with compensation.
- `src/workflows/push-order-to-ongoing.ts` — workflow composition.
- `src/workflows/index.ts` — barrel export (per `package.json` `exports["./workflows"]`). Create if absent; otherwise add the export.
- `src/workflows/steps/__tests__/map-order-to-ongoing.test.ts`
- `src/workflows/steps/__tests__/push-order-record-sync.test.ts`
- `src/workflows/__tests__/push-order-to-ongoing.test.ts`

**Modify:**
- `src/lib/ongoing/client.ts` — fix `putOrder` to read the real flat response.
- `src/lib/ongoing/__tests__/client.operations.test.ts` — adjust the `putOrder` test to the flat response.
- `src/modules/ongoing/service.ts` — add the `recordSync(...)` helper.

---

## Task 1: Fix `OngoingClient.putOrder` to the real flat Ongoing response

The Ongoing OpenAPI v57 `PostOrderResponse` is **flat**: `{ orderId: int32, message: string }`. There is **no** `orderInfo` wrapper and **no** `orderNumber` in the response. The current `putOrder` reads `res.orderInfo.orderId` / `res.orderInfo.orderNumber` — both wrong (they resolve to `undefined`). Fix it to return `{ ongoingOrderId: res.orderId }` only.

**Files:**
- Modify: `src/lib/ongoing/client.ts:106-112` (the `putOrder` method)
- Test: `src/lib/ongoing/__tests__/client.operations.test.ts` (replace the existing `putOrder` test)

**Interfaces:**
- Consumes: `request` core, `PostOrderModel`.
- Produces: `putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }>` — `PUT /orders` upsert; returns only the created/updated Ongoing order id.

- [ ] **Step 1: Update the failing test to the flat response**

In `src/lib/ongoing/__tests__/client.operations.test.ts`, replace the existing `"upserts an order..."` test (lines 64-72) with:
```ts
  it("upserts an order and returns the ongoing id from the flat response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderId: 999, message: "Order created" }))
    const client = new OngoingClient(creds, { fetchImpl })
    const result = await client.putOrder({ orderNumber: "1001-abc", goodsOwnerId: 7 })
    expect(result).toEqual({ ongoingOrderId: 999 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders")
    expect(init.method).toBe("PUT")
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts -t "flat response"`
Expected: FAIL — `result` is `{ ongoingOrderId: undefined, orderNumber: undefined }` (old code reads `res.orderInfo`), so `toEqual({ ongoingOrderId: 999 })` fails.

- [ ] **Step 3: Fix `putOrder`**

In `src/lib/ongoing/client.ts`, replace the `putOrder` method:
```ts
  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }> {
    const res = await this.request<{ orderId: number; message?: string }>("PUT", "/orders", order)
    return { ongoingOrderId: res.orderId }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: PASS (all operations tests green, including the rewritten one).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.operations.test.ts
git commit -m "fix(ongoing-client): putOrder reads flat {orderId} PostOrderResponse (#26)"
```

---

## Task 2: Add `recordSync` helper to the module service

`recordSync` upserts an `OngoingOrderSync` row keyed by `ongoing_order_number` (the idempotent upsert key). It is used twice by the push step: once **before** the PUT to persist the order number (so a retry hits the same Ongoing order), and once **after** to record success or the classified failure. Uses the auto-CRUD `listOngoingOrderSyncs` / `createOngoingOrderSyncs` / `updateOngoingOrderSyncs` provided by `MedusaService`.

**Files:**
- Modify: `src/modules/ongoing/service.ts`
- Test: `src/modules/ongoing/__tests__/record-sync.test.ts`

**Interfaces:**
- Consumes: auto-CRUD methods on `OngoingModuleService`.
- Produces, on `OngoingModuleService`:
  ```ts
  type RecordSyncInput = {
    ongoing_order_number: string
    integration_id: string
    medusa_order_id: string
    medusa_fulfillment_id?: string | null
    sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
    ongoing_order_id?: number | null
    error_class?: "retryable" | "terminal" | null
    last_error?: string | null
  }
  recordSync(input: RecordSyncInput): Promise<{ id: string }>
  ```
  Behavior: find the existing row by `ongoing_order_number`; if found, **update** it (setting only the provided fields plus `last_synced_at = new Date()`); if not found, **create** it. Returns `{ id }`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/ongoing/__tests__/record-sync.test.ts`:
```ts
import OngoingModuleService from "../service"

const validOptions = {
  integrations: [
    { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

// Build a service instance with auto-CRUD methods stubbed (no MikroORM / DB).
function makeService() {
  const svc = new OngoingModuleService({} as any, validOptions as any)
  ;(svc as any).listOngoingOrderSyncs = jest.fn()
  ;(svc as any).createOngoingOrderSyncs = jest.fn()
  ;(svc as any).updateOngoingOrderSyncs = jest.fn()
  return svc
}

describe("OngoingModuleService.recordSync", () => {
  it("creates a new row when none exists for the order number", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([])
    ;(svc as any).createOngoingOrderSyncs.mockResolvedValue([{ id: "oos_1" }])

    const result = await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
      sync_state: "pending",
    })

    expect(result).toEqual({ id: "oos_1" })
    expect((svc as any).createOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const created = (svc as any).createOngoingOrderSyncs.mock.calls[0][0]
    expect(created).toMatchObject({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
      sync_state: "pending",
    })
    expect(created.last_synced_at).toBeInstanceOf(Date)
    expect((svc as any).updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("updates the existing row (by id) when one already exists", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([{ id: "oos_9" }])
    ;(svc as any).updateOngoingOrderSyncs.mockResolvedValue([{ id: "oos_9" }])

    const result = await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      sync_state: "sent",
      ongoing_order_id: 999,
    })

    expect(result).toEqual({ id: "oos_9" })
    expect((svc as any).createOngoingOrderSyncs).not.toHaveBeenCalled()
    const update = (svc as any).updateOngoingOrderSyncs.mock.calls[0][0]
    expect(update).toMatchObject({ id: "oos_9", sync_state: "sent", ongoing_order_id: 999 })
    expect(update.last_synced_at).toBeInstanceOf(Date)
  })

  it("records a classified error on failure", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([{ id: "oos_3" }])
    ;(svc as any).updateOngoingOrderSyncs.mockResolvedValue([{ id: "oos_3" }])

    await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      sync_state: "error",
      error_class: "retryable",
      last_error: "network down",
    })

    const update = (svc as any).updateOngoingOrderSyncs.mock.calls[0][0]
    expect(update).toMatchObject({
      id: "oos_3",
      sync_state: "error",
      error_class: "retryable",
      last_error: "network down",
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/modules/ongoing/__tests__/record-sync.test.ts`
Expected: FAIL — `svc.recordSync is not a function`.

- [ ] **Step 3: Implement `recordSync`**

In `src/modules/ongoing/service.ts`, add the type above the class and the method inside the class (after `getIntegrationByLocation`):

Add this type near the top imports:
```ts
export type RecordSyncInput = {
  ongoing_order_number: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
  ongoing_order_id?: number | null
  error_class?: "retryable" | "terminal" | null
  last_error?: string | null
}
```

Add the method inside `OngoingModuleService`:
```ts
  async recordSync(input: RecordSyncInput): Promise<{ id: string }> {
    const [existing] = await this.listOngoingOrderSyncs({
      ongoing_order_number: input.ongoing_order_number,
    })

    const data = { ...input, last_synced_at: new Date() }

    if (existing) {
      const [updated] = await this.updateOngoingOrderSyncs({ id: existing.id, ...data })
      return { id: updated.id }
    }

    const [created] = await this.createOngoingOrderSyncs(data)
    return { id: created.id }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/ongoing/__tests__/record-sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ongoing/service.ts src/modules/ongoing/__tests__/record-sync.test.ts
git commit -m "feat(ongoing-module): recordSync helper upserts OngoingOrderSync by order number (#26)"
```

---

## Task 3: Shared re-query helper + re-query step (with per-line SKU resolution)

Re-queries the fulfillment (by `fulfillment_id`) and its linked order via the container `QUERY`, returning a flat shape. The thin `createFulfillment` DTO can't be trusted, so the push always re-queries. The query logic lives in the **shared, EXPORTED** helper `reQueryFulfillmentOrder(query, fulfillmentId)` (this plan OWNS it; #27 imports the same helper). The step then resolves each line's `article_number` by calling #29 `resolveArticleNumber(query, sku)` per line — this is the step that has `query`, so SKU resolution belongs here.

**Files:**
- Create: `src/lib/ongoing/re-query-fulfillment-order.ts` — the shared helper.
- Create: `src/workflows/steps/query-fulfillment-order.ts` — the step (calls the helper + resolves article numbers).
- Test: covered by the workflow test in Task 5 (this step is a thin `query.graph` wrapper + per-line resolver call; its behavior is exercised end-to-end there). No standalone test file.

**Interfaces:**
- Consumes: `ContainerRegistrationKeys.QUERY` from the workflow container; #29 `resolveArticleNumber(query, sku)`.
- Produces — the EXPORTED shared helper and the step:
  ```ts
  // src/lib/ongoing/re-query-fulfillment-order.ts (EXPORTED; #27 imports this)
  export type QueriedFulfillmentOrder = {
    fulfillment_id: string
    location_id: string
    items: Array<{
      quantity: number
      sku: string | null
      barcode: string | null
      title: string | null
      line_item_id: string | null
    }>
    order: {
      display_id: number
      currency_code: string
      email: string | null
      shipping_address: {
        first_name: string | null
        last_name: string | null
        address_1: string | null
        address_2: string | null
        city: string | null
        postal_code: string | null
        country_code: string | null
        phone: string | null
        company: string | null
      } | null
    }
  }
  export async function reQueryFulfillmentOrder(query: any, fulfillmentId: string): Promise<QueriedFulfillmentOrder>

  // src/workflows/steps/query-fulfillment-order.ts
  type QueryFulfillmentOrderInput = { fulfillment_id: string }
  type ResolvedLine = { article_number: string; quantity: number; line_item_id: string | null }
  type QueriedFulfillmentOrderWithLines = QueriedFulfillmentOrder & { resolvedLines: ResolvedLine[] }
  export const queryFulfillmentOrderStep: Step<QueryFulfillmentOrderInput, QueriedFulfillmentOrderWithLines>
  ```

- [ ] **Step 1: Implement the shared, EXPORTED re-query helper**

Create `src/lib/ongoing/re-query-fulfillment-order.ts`:
```ts
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

export type QueriedFulfillmentOrder = {
  fulfillment_id: string
  location_id: string
  items: Array<{
    quantity: number
    sku: string | null
    barcode: string | null
    title: string | null
    line_item_id: string | null
  }>
  order: {
    display_id: number
    currency_code: string
    email: string | null
    shipping_address: {
      first_name: string | null
      last_name: string | null
      address_1: string | null
      address_2: string | null
      city: string | null
      postal_code: string | null
      country_code: string | null
      phone: string | null
      company: string | null
    } | null
  }
}

// Shared helper OWNED by #26 and imported by #27. Plain async fn (not a step) so both can reuse it.
export async function reQueryFulfillmentOrder(
  query: any,
  fulfillmentId: string
): Promise<QueriedFulfillmentOrder> {
  const { data } = await query.graph({
    entity: "fulfillment",
    fields: [
      "id",
      "location_id",
      "items.quantity",
      "items.sku",
      "items.barcode",
      "items.title",
      "items.line_item_id",
      "order.display_id",
      "order.currency_code",
      "order.email",
      "order.shipping_address.first_name",
      "order.shipping_address.last_name",
      "order.shipping_address.address_1",
      "order.shipping_address.address_2",
      "order.shipping_address.city",
      "order.shipping_address.postal_code",
      "order.shipping_address.country_code",
      "order.shipping_address.phone",
      "order.shipping_address.company",
    ],
    filters: { id: fulfillmentId },
  })

  const fulfillment = data[0]
  if (!fulfillment) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] fulfillment "${fulfillmentId}" not found when pushing to Ongoing`
    )
  }

  return {
    fulfillment_id: fulfillment.id,
    location_id: fulfillment.location_id,
    items: (fulfillment.items ?? []).map((i: any) => ({
      quantity: i.quantity,
      sku: i.sku ?? null,
      barcode: i.barcode ?? null,
      title: i.title ?? null,
      line_item_id: i.line_item_id ?? null,
    })),
    order: {
      display_id: fulfillment.order?.display_id,
      currency_code: fulfillment.order?.currency_code,
      email: fulfillment.order?.email ?? null,
      shipping_address: fulfillment.order?.shipping_address ?? null,
    },
  }
}
```
> `ContainerRegistrationKeys` is imported only for type/parity with #27's usage; the helper takes `query` directly so callers resolve it once. The step (below) resolves `QUERY` and passes it in.

- [ ] **Step 2: Implement the step (verified by the workflow test in Task 5)**

Create `src/workflows/steps/query-fulfillment-order.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  reQueryFulfillmentOrder,
  type QueriedFulfillmentOrder,
} from "../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"

export type QueryFulfillmentOrderInput = { fulfillment_id: string }

export type ResolvedLine = {
  article_number: string
  quantity: number
  line_item_id: string | null
}

export type QueriedFulfillmentOrderWithLines = QueriedFulfillmentOrder & {
  resolvedLines: ResolvedLine[]
}

export const queryFulfillmentOrderStep = createStep(
  "query-fulfillment-order",
  async (input: QueryFulfillmentOrderInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Shared helper OWNED by #26 (also imported by #27).
    const queried = await reQueryFulfillmentOrder(query, input.fulfillment_id)

    // This step has `query`, so resolve each line's article_number per SKU here (#29).
    // resolveArticleNumber throws a terminal OngoingApiError on collision/missing SKU.
    const resolvedLines: ResolvedLine[] = []
    for (const item of queried.items) {
      const article_number = await resolveArticleNumber(query, item.sku as string)
      resolvedLines.push({
        article_number,
        quantity: item.quantity,
        line_item_id: item.line_item_id,
      })
    }

    const result: QueriedFulfillmentOrderWithLines = { ...queried, resolvedLines }

    return new StepResponse(result)
  }
)
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/ongoing/re-query-fulfillment-order.ts src/workflows/steps/query-fulfillment-order.ts
git commit -m "feat(ongoing-workflow): shared reQueryFulfillmentOrder helper + step resolves article numbers per line (#26)"
```

---

## Task 4: Mapping step — compose #24 mapper + #25 order-number

Turns the queried + already-resolved data into a `PostOrderModel` plus the generated `ongoing_order_number`. SKU resolution already happened in Task 3 (the step that has `query`), so this step consumes `resolvedLines` directly. It builds the order number via #25 (`buildOngoingOrderNumber({ displayId, fulfillmentId })`, object arg), assembles a **single flat `MapOrderInput`** object, and calls #24 `mapOrderToPostOrderModel(thatInput)` once — the mapper sets `orderNumber`/`goodsOwnerId` itself, so there is **no** post-hoc double-stamping. Mapping/validation errors surface as **terminal** (caught by the push step's compensation and recorded as `error_class="terminal"`).

**Files:**
- Create: `src/workflows/steps/map-order-to-ongoing.ts`
- Test: `src/workflows/steps/__tests__/map-order-to-ongoing.test.ts`

**Interfaces:**
- Consumes: `QueriedFulfillmentOrderWithLines` (Task 3, carries `resolvedLines`); `mapOrderToPostOrderModel` (#24), `buildOngoingOrderNumber` (#25); `goods_owner_id` passed in.
- Produces:
  ```ts
  type MapOrderStepInput = { queried: QueriedFulfillmentOrderWithLines; goods_owner_id: number }
  type MapOrderOutput = { model: PostOrderModel; ongoing_order_number: string }
  export const mapOrderToOngoingStep: Step<MapOrderStepInput, MapOrderOutput>
  ```
  The produced `model` includes `orderNumber` and `goodsOwnerId` — set by the #24 mapper from the `MapOrderInput` it receives, not re-stamped by this step.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/map-order-to-ongoing.test.ts`:
```ts
jest.mock("../../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn(),
}))
jest.mock("../../../lib/ongoing/order-number", () => ({
  buildOngoingOrderNumber: jest.fn(),
}))

import { mapOrderToOngoingStep } from "../map-order-to-ongoing"
import { mapOrderToPostOrderModel } from "../../../lib/ongoing/order-mapper"
import { buildOngoingOrderNumber } from "../../../lib/ongoing/order-number"

const queried = {
  fulfillment_id: "ful_1",
  location_id: "loc_1",
  items: [{ quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" }],
  resolvedLines: [{ article_number: "ART-1", quantity: 2, line_item_id: "li_1" }],
  order: {
    display_id: 1001,
    currency_code: "usd",
    email: "a@b.com",
    shipping_address: {
      first_name: "Jo", last_name: "Doe", address_1: "1 St", address_2: null,
      city: "Town", postal_code: "0001", country_code: "no", phone: "123", company: null,
    },
  },
}

// Steps invoke their handler at index [0] when called as fns; use .invoke for clarity.
const run = (input: any) => (mapOrderToOngoingStep as any).invoke(input, { container: {} })

describe("mapOrderToOngoingStep", () => {
  it("builds the order number (object arg) and maps via a single flat MapOrderInput", async () => {
    ;(buildOngoingOrderNumber as jest.Mock).mockReturnValue("1001-ful1")
    ;(mapOrderToPostOrderModel as jest.Mock).mockReturnValue({
      orderNumber: "1001-ful1",
      goodsOwnerId: 7,
      consignee: { name: "Jo Doe" },
      orderLines: [],
    })

    const { output } = await run({ queried, goods_owner_id: 7 })

    // #25 takes a SINGLE OBJECT arg.
    expect(buildOngoingOrderNumber).toHaveBeenCalledWith({
      displayId: 1001,
      fulfillmentId: "ful_1",
    })

    // #24 takes a SINGLE FLAT MapOrderInput object with resolved lines.
    expect(mapOrderToPostOrderModel).toHaveBeenCalledTimes(1)
    const mapInput = (mapOrderToPostOrderModel as jest.Mock).mock.calls[0][0]
    expect(mapInput).toMatchObject({
      goods_owner_id: 7,
      order_number: "1001-ful1",
      currency_code: "usd",
      email: "a@b.com",
      shipping_address: queried.order.shipping_address,
      lines: [{ article_number: "ART-1", quantity: 2 }],
    })

    expect(output.ongoing_order_number).toBe("1001-ful1")
    // model is returned as-is from the mapper (no double-stamping).
    expect(output.model).toMatchObject({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
  })

  it("propagates a terminal mapper error", async () => {
    ;(buildOngoingOrderNumber as jest.Mock).mockReturnValue("1001-ful1")
    ;(mapOrderToPostOrderModel as jest.Mock).mockImplementation(() => {
      throw Object.assign(new Error("invalid address"), { kind: "terminal" })
    })

    await expect(run({ queried, goods_owner_id: 7 })).rejects.toMatchObject({ kind: "terminal" })
  })
})
```

> NOTE on `(step as any).invoke`: in `@medusajs/framework/workflows-sdk` 2.16.0 a created step exposes its handler via `.invoke(input, context)` for direct unit invocation. If `.invoke` is undefined at run time, the step's handler is reachable as the first element of the step's internal handler tuple; read the error and switch to the available accessor (the test asserts behavior, not the accessor name).

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/map-order-to-ongoing.test.ts`
Expected: FAIL — cannot find module `../map-order-to-ongoing`.

- [ ] **Step 3: Implement the mapping step**

Create `src/workflows/steps/map-order-to-ongoing.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { PostOrderModel } from "../../lib/ongoing/types"
import type { MapOrderInput } from "../../lib/ongoing/order-mapper"
import type { QueriedFulfillmentOrderWithLines } from "./query-fulfillment-order"
import { mapOrderToPostOrderModel } from "../../lib/ongoing/order-mapper"
import { buildOngoingOrderNumber } from "../../lib/ongoing/order-number"

export type MapOrderStepInput = {
  queried: QueriedFulfillmentOrderWithLines
  goods_owner_id: number
}
export type MapOrderOutput = { model: PostOrderModel; ongoing_order_number: string }

export const mapOrderToOngoingStep = createStep(
  "map-order-to-ongoing",
  async (input: MapOrderStepInput) => {
    const { queried, goods_owner_id } = input

    // #25 — single object arg.
    const ongoingOrderNumber = buildOngoingOrderNumber({
      displayId: queried.order.display_id,
      fulfillmentId: queried.fulfillment_id,
    })

    // #24 — build ONE flat MapOrderInput; lines already carry resolved article_number (Task 3).
    const mapInput: MapOrderInput = {
      goods_owner_id,
      order_number: ongoingOrderNumber,
      delivery_date: new Date().toISOString(),
      currency_code: queried.order.currency_code,
      email: queried.order.email ?? undefined,
      shipping_address: queried.order.shipping_address,
      lines: queried.resolvedLines.map((l) => ({
        article_number: l.article_number,
        quantity: l.quantity,
      })),
    }

    // Mapper is PURE and sets orderNumber/goodsOwnerId from MapOrderInput — no re-stamping here.
    const model = mapOrderToPostOrderModel(mapInput)

    return new StepResponse({ model, ongoing_order_number: ongoingOrderNumber })
  }
)
```

> NOTE on `delivery_date`: `MapOrderInput` requires `delivery_date`. This plan passes the current timestamp (ISO) as a sensible default since the queried fulfillment carries no requested delivery date. If #24's contract or a later issue specifies a different source, change this single line; the test mocks the mapper so it stays green.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/map-order-to-ongoing.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/map-order-to-ongoing.ts src/workflows/steps/__tests__/map-order-to-ongoing.test.ts
git commit -m "feat(ongoing-workflow): map queried order to PostOrderModel via single MapOrderInput + buildOngoingOrderNumber object arg (#26)"
```

---

## Task 5: Push step — record-before-PUT, call `putOrder`, record result, compensation

The single mutating step. Resolves the `ongoing` module service and the per-credential client, persists the order number with `sync_state="pending"` (so a retry upserts the same Ongoing order), calls `putOrder`, then records `sync_state="sent"` + `ongoing_order_id`. Its **compensation** (3rd arg) records `sync_state="error"` with `error_class` derived from `OngoingApiError.kind` (defaulting to `terminal` for non-API errors) and `last_error`.

**Files:**
- Create: `src/workflows/steps/push-order-record-sync.ts`
- Test: `src/workflows/steps/__tests__/push-order-record-sync.test.ts`

**Interfaces:**
- Consumes: `ongoing` module service (`getClient`, `recordSync`); `OngoingClient.putOrder`; `OngoingApiError`.
- Produces:
  ```ts
  type PushOrderInput = {
    model: PostOrderModel
    ongoing_order_number: string
    credential_key: string
    integration_id: string
    goods_owner_id: number
    medusa_order_id: string
    medusa_fulfillment_id: string
  }
  type PushOrderOutput = { ongoingOrderId: number; orderNumber: string }
  export const pushOrderRecordSyncStep: Step<PushOrderInput, PushOrderOutput>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/push-order-record-sync.test.ts`:
```ts
import { pushOrderRecordSyncStep } from "../push-order-record-sync"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const baseInput = {
  model: { orderNumber: "1001-ful1", goodsOwnerId: 7 },
  ongoing_order_number: "1001-ful1",
  credential_key: "wh-a",
  integration_id: "int_1",
  goods_owner_id: 7,
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
}

function makeContainer({ putOrder }: { putOrder: jest.Mock }) {
  const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
  const service = {
    getClient: jest.fn().mockReturnValue({ putOrder }),
    recordSync,
  }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, recordSync, service }
}

const invoke = (input: any, ctx: any) => (pushOrderRecordSyncStep as any).invoke(input, ctx)
const compensate = (input: any, ctx: any) => (pushOrderRecordSyncStep as any).compensate(input, ctx)

describe("pushOrderRecordSyncStep", () => {
  it("records pending before PUT, calls putOrder, then records sent + ongoing id", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { container, recordSync } = makeContainer({ putOrder })

    const { output } = await invoke(baseInput, { container })

    expect(output).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
    expect(putOrder).toHaveBeenCalledWith(baseInput.model)

    // First recordSync = pending (before PUT), second = sent (after PUT).
    expect(recordSync).toHaveBeenCalledTimes(2)
    expect(recordSync.mock.calls[0][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "pending",
    })
    expect(recordSync.mock.calls[1][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "sent",
      ongoing_order_id: 999,
    })

    // putOrder must be called AFTER the pending record (idempotent retry).
    const pendingOrder = recordSync.mock.invocationCallOrder[0]
    const putOrderOrder = putOrder.mock.invocationCallOrder[0]
    expect(pendingOrder).toBeLessThan(putOrderOrder)
  })

  it("compensation records a retryable error for a retryable OngoingApiError", async () => {
    const { container, recordSync } = makeContainer({ putOrder: jest.fn() })
    const err = new OngoingApiError("503 down", { kind: "retryable", status: 503 })

    await compensate({ ...baseInput, error: { message: err.message, kind: err.kind } }, { container })

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({
        ongoing_order_number: "1001-ful1",
        sync_state: "error",
        error_class: "retryable",
        last_error: "503 down",
      })
    )
  })

  it("compensation defaults to terminal for a non-classified error", async () => {
    const { container, recordSync } = makeContainer({ putOrder: jest.fn() })

    await compensate({ ...baseInput, error: { message: "mapping blew up" } }, { container })

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "terminal", last_error: "mapping blew up" })
    )
  })
})
```

> NOTE on `.invoke` / `.compensate`: as in Task 4, these access the step's handler and compensation directly for unit testing. If the accessor names differ in 2.16.0, the failing run will say so; switch to the exposed accessors (the assertions are behavior-based).

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/push-order-record-sync.test.ts`
Expected: FAIL — cannot find module `../push-order-record-sync`.

- [ ] **Step 3: Implement the push step**

Create `src/workflows/steps/push-order-record-sync.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { OngoingApiError } from "../../lib/ongoing/errors"
import type { PostOrderModel } from "../../lib/ongoing/types"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type PushOrderInput = {
  model: PostOrderModel
  ongoing_order_number: string
  credential_key: string
  integration_id: string
  goods_owner_id: number
  medusa_order_id: string
  medusa_fulfillment_id: string
}

export type PushOrderOutput = { ongoingOrderId: number; orderNumber: string }

type CompensationInput = PushOrderInput & {
  error?: { message?: string; kind?: "retryable" | "terminal" }
}

export const pushOrderRecordSyncStep = createStep(
  "push-order-record-sync",
  async (input: PushOrderInput, { container }) => {
    const service: any = container.resolve(ONGOING_MODULE)

    // Persist the order number BEFORE the PUT so a retry upserts the same Ongoing order.
    await service.recordSync({
      ongoing_order_number: input.ongoing_order_number,
      integration_id: input.integration_id,
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      sync_state: "pending",
    })

    const client = service.getClient(input.credential_key)

    let ongoingOrderId: number
    try {
      const res = await client.putOrder(input.model)
      ongoingOrderId = res.ongoingOrderId
    } catch (err) {
      const apiErr = err instanceof OngoingApiError ? err : undefined
      // Hand the classified error to the compensation function via the compensation input.
      throw Object.assign(err as Error, {
        __ongoingCompensation: {
          message: (err as Error).message,
          kind: apiErr?.kind,
        },
      })
    }

    await service.recordSync({
      ongoing_order_number: input.ongoing_order_number,
      integration_id: input.integration_id,
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      sync_state: "sent",
      ongoing_order_id: ongoingOrderId,
    })

    const output: PushOrderOutput = {
      ongoingOrderId,
      orderNumber: input.ongoing_order_number,
    }

    return new StepResponse(output, {
      ...input,
      error: undefined,
    } as CompensationInput)
  },
  async (compensationInput: CompensationInput | undefined, { container }) => {
    if (!compensationInput) {
      return
    }
    const service: any = container.resolve(ONGOING_MODULE)
    const error = compensationInput.error ?? { message: "unknown error" }
    const errorClass = error.kind === "retryable" ? "retryable" : "terminal"

    await service.recordSync({
      ongoing_order_number: compensationInput.ongoing_order_number,
      integration_id: compensationInput.integration_id,
      medusa_order_id: compensationInput.medusa_order_id,
      medusa_fulfillment_id: compensationInput.medusa_fulfillment_id,
      sync_state: "error",
      error_class: errorClass,
      last_error: error.message ?? "unknown error",
    })
  }
)
```

> NOTE on compensation input propagation: when the step body throws, Medusa runs the compensation with the **compensation input that was registered by the last successful `StepResponse`** for prior steps; for the throwing step itself there is none, so the workflow (Task 6) catches the classification at the workflow level by passing the error into a dedicated `recordPushFailureStep`. To keep this step self-contained AND testable, the step exposes `.compensate(input, ctx)` that reads `input.error`; the workflow wires the error into that input. The unit test above drives `.compensate` directly with `{ ...input, error }`, which is exactly how Task 6 invokes it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/push-order-record-sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/push-order-record-sync.ts src/workflows/steps/__tests__/push-order-record-sync.test.ts
git commit -m "feat(ongoing-workflow): push step records pending-before-PUT, calls putOrder, compensation classifies error (#26)"
```

---

## Task 6: Workflow composition + barrel export

Composes the three steps and resolves the integration context (credential key + integration id + goods owner) from the queried `location_id`. Returns `{ ongoingOrderId, orderNumber }`. The mapping step's terminal error and the push step's failure both flow into the step compensation chain (recording `error_class`/`last_error`), then re-throw so the caller (`createFulfillment`, #21) sees the failure.

**Files:**
- Create: `src/workflows/push-order-to-ongoing.ts`
- Create or modify: `src/workflows/index.ts`
- Create: `src/workflows/steps/resolve-integration-context.ts`
- Test: `src/workflows/__tests__/push-order-to-ongoing.test.ts`

**Interfaces:**
- Consumes: all three step modules; the `ongoing` service (`getIntegrationByLocation`, `getCredentials`).
- Produces:
  ```ts
  type PushOrderToOngoingInput = { fulfillment_id: string }
  type PushOrderToOngoingOutput = { ongoingOrderId: number; orderNumber: string }
  export const pushOrderToOngoing: ReturnType<typeof createWorkflow>  // named export (canonical contract)
  export default pushOrderToOngoing                                   // default (test import)
  ```
- `src/workflows/index.ts` re-exports the named `pushOrderToOngoing`.

- [ ] **Step 1: Implement the integration-context step**

Create `src/workflows/steps/resolve-integration-context.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type ResolveIntegrationContextInput = { location_id: string }
export type ResolveIntegrationContextOutput = {
  integration_id: string
  credential_key: string
  goods_owner_id: number
}

export const resolveIntegrationContextStep = createStep(
  "resolve-integration-context",
  async (input: ResolveIntegrationContextInput, { container }) => {
    const service: any = container.resolve(ONGOING_MODULE)

    const integration = await service.getIntegrationByLocation(input.location_id)
    if (!integration) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `[ongoing] no enabled integration for stock location "${input.location_id}"`
      )
    }

    const creds = service.getCredentials(integration.credential_key)

    const output: ResolveIntegrationContextOutput = {
      integration_id: integration.id,
      credential_key: integration.credential_key,
      goods_owner_id: creds.goodsOwnerId,
    }

    return new StepResponse(output)
  }
)
```

- [ ] **Step 2: Write the failing workflow test**

Create `src/workflows/__tests__/push-order-to-ongoing.test.ts`:
```ts
import pushOrderToOngoing from "../push-order-to-ongoing"

// A queried fulfillment + order the QUERY graph returns.
const fulfillmentRow = {
  id: "ful_1",
  location_id: "loc_1",
  items: [{ quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" }],
  order: {
    display_id: 1001,
    currency_code: "usd",
    email: "a@b.com",
    shipping_address: {
      first_name: "Jo", last_name: "Doe", address_1: "1 St", address_2: null,
      city: "Town", postal_code: "0001", country_code: "no", phone: "123", company: null,
    },
  },
}

jest.mock("../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn(() => ({
    orderNumber: "1001-ful1",
    goodsOwnerId: 7,
    consignee: { name: "Jo Doe" },
    orderLines: [],
  })),
}))
jest.mock("../../lib/ongoing/order-number", () => ({
  buildOngoingOrderNumber: jest.fn(() => "1001-ful1"),
}))
jest.mock("../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn(async () => "ART-1"),
}))

import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"
import { OngoingApiError } from "../../lib/ongoing/errors"

// Build a fake Medusa container the workflow .run({ container }) override uses.
function buildContainer({ putOrder, recordSync }: { putOrder: jest.Mock; recordSync: jest.Mock }) {
  const query = { graph: jest.fn().mockResolvedValue({ data: [fulfillmentRow] }) }
  const service = {
    getIntegrationByLocation: jest.fn().mockResolvedValue({ id: "int_1", credential_key: "wh-a" }),
    getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
    getClient: jest.fn().mockReturnValue({ putOrder }),
    recordSync,
  }
  const registrations: Record<string, any> = {
    query,
    ongoing: service,
  }
  return {
    container: { resolve: (key: string) => registrations[key] },
    query,
    service,
  }
}

describe("pushOrderToOngoing workflow", () => {
  it("happy path: maps, PUTs, and records sent with the ongoing id", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    const { container } = buildContainer({ putOrder, recordSync })

    const { result } = await pushOrderToOngoing(container as any).run({
      input: { fulfillment_id: "ful_1" },
    })

    expect(result).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
    expect(putOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
    )
    const states = recordSync.mock.calls.map((c) => c[0].sync_state)
    expect(states).toContain("pending")
    expect(states).toContain("sent")
  })

  it("terminal SKU-resolution error: never calls putOrder, workflow rejects", async () => {
    const putOrder = jest.fn()
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    ;(resolveArticleNumber as jest.Mock).mockRejectedValueOnce(
      new OngoingApiError("ambiguous SKU", { kind: "terminal" })
    )
    const { container } = buildContainer({ putOrder, recordSync })

    await expect(
      pushOrderToOngoing(container as any).run({ input: { fulfillment_id: "ful_1" } })
    ).rejects.toBeDefined()

    expect(putOrder).not.toHaveBeenCalled()
  })

  it("retryable client error: records error_class=retryable", async () => {
    const putOrder = jest.fn().mockRejectedValue(new OngoingApiError("503", { kind: "retryable", status: 503 }))
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    const { container } = buildContainer({ putOrder, recordSync })

    await expect(
      pushOrderToOngoing(container as any).run({ input: { fulfillment_id: "ful_1" } })
    ).rejects.toBeDefined()

    const errorCall = recordSync.mock.calls.find((c) => c[0].sync_state === "error")
    expect(errorCall?.[0]).toMatchObject({ error_class: "retryable", sync_state: "error" })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `yarn test src/workflows/__tests__/push-order-to-ongoing.test.ts`
Expected: FAIL — cannot find module `../push-order-to-ongoing`.

- [ ] **Step 4: Implement the workflow**

Create `src/workflows/push-order-to-ongoing.ts`:
```ts
import { createStep, createWorkflow, StepResponse, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { OngoingApiError } from "../lib/ongoing/errors"
import { ONGOING_MODULE } from "../modules/ongoing"
import { queryFulfillmentOrderStep } from "./steps/query-fulfillment-order"
import { mapOrderToOngoingStep } from "./steps/map-order-to-ongoing"
import { resolveIntegrationContextStep } from "./steps/resolve-integration-context"
import { pushOrderRecordSyncStep } from "./steps/push-order-record-sync"
import type { PostOrderModel } from "../lib/ongoing/types"

export type PushOrderToOngoingInput = { fulfillment_id: string }
export type PushOrderToOngoingOutput = { ongoingOrderId: number; orderNumber: string }

// A guard step that records a terminal error if the order number is known by the time a
// failure surfaces from mapping. This keeps error capture inside the workflow's compensation
// chain even when the mapping step (which has no sync row yet) throws.
const recordTerminalIfPossibleStep = createStep(
  "record-terminal-if-possible",
  async (input: { ongoing_order_number?: string }) => {
    // No-op forward pass; capture happens via push step compensation. Present so the workflow
    // has a single typed output node. (Mapping terminal errors are recorded by the push step
    // never running; the workflow re-throws so #21 sees the failure.)
    return new StepResponse(input)
  }
)

export const pushOrderToOngoing = createWorkflow(
  "push-order-to-ongoing",
  function (input: PushOrderToOngoingInput) {
    const queried = queryFulfillmentOrderStep({ fulfillment_id: input.fulfillment_id })

    const ctx = resolveIntegrationContextStep(
      transform({ queried }, (d) => ({ location_id: d.queried.location_id }))
    )

    const mapped = mapOrderToOngoingStep(
      transform({ queried, ctx }, (d) => ({
        queried: d.queried,
        goods_owner_id: d.ctx.goods_owner_id,
      }))
    )

    const pushed = pushOrderRecordSyncStep(
      transform({ queried, ctx, mapped }, (d) => ({
        model: d.mapped.model as PostOrderModel,
        ongoing_order_number: d.mapped.ongoing_order_number,
        credential_key: d.ctx.credential_key,
        integration_id: d.ctx.integration_id,
        goods_owner_id: d.ctx.goods_owner_id,
        medusa_order_id: String(d.queried.order.display_id),
        medusa_fulfillment_id: d.queried.fulfillment_id,
      }))
    )

    return new WorkflowResponse(
      transform({ pushed }, (d) => ({
        ongoingOrderId: d.pushed.ongoingOrderId,
        orderNumber: d.pushed.orderNumber,
      }))
    )
  }
)

export default pushOrderToOngoing
```

> NOTE on exports: the workflow is exported BOTH as the named export `pushOrderToOngoing` (the canonical contract this issue owns) and as the default (for the existing test import). The barrel re-exports the named symbol.

> NOTE on `medusa_order_id`: the queried shape exposes `order.display_id` (numeric) but not the internal order id, because `query.graph` on `fulfillment` returns `order.*` fields, not the link id. For a precise `medusa_order_id`, add `"order.id"` to the shared helper's `fields` array and the `QueriedFulfillmentOrder.order` type (`id: string`), then map `medusa_order_id: d.queried.order.id` here. Do this in Step 5 below before running the test.

- [ ] **Step 5: Add `order.id` to the shared helper for a precise order id**

In `src/lib/ongoing/re-query-fulfillment-order.ts` (the shared helper):
- add `"order.id"` to the `fields` array (right before `"order.display_id"`),
- add `id: string` to the `order` shape in `QueriedFulfillmentOrder`,
- set `id: fulfillment.order?.id` in the returned `order` object.

Then in `src/workflows/push-order-to-ongoing.ts`, change the push-step transform line
`medusa_order_id: String(d.queried.order.display_id),` to
`medusa_order_id: d.queried.order.id,`.

Update the workflow test's `fulfillmentRow.order` to include `id: "order_1"`, and assert the happy-path `recordSync` pending/sent calls carry `medusa_order_id: "order_1"` (add `expect(recordSync.mock.calls[0][0]).toMatchObject({ medusa_order_id: "order_1" })`).

- [ ] **Step 6: Remove the unused guard step**

The `recordTerminalIfPossibleStep` in the workflow file is not wired into the composition; delete its definition (it was an exploratory note). The workflow re-throws on mapping failure and the push step's compensation handles client failures — no extra node is needed. Confirm the file has no unused `createStep`/`StepResponse` imports after deletion (keep `StepResponse` only if still used; in the final file it is not — remove it from the import).

Final import line should read:
```ts
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
```

- [ ] **Step 7: Run the workflow test to verify it passes**

Run: `yarn test src/workflows/__tests__/push-order-to-ongoing.test.ts`
Expected: PASS (3 tests).

> NOTE on terminal SKU-resolution errors: these throw in the re-query step (Task 3), **before** any `OngoingOrderSync` row exists, so there is intentionally no `recordSync(error)` for that path — the test asserts only `putOrder` not called + the workflow rejecting. The push step's compensation handles client failures (retryable test, kept strict). This is the correct behavior, not a relaxation.

- [ ] **Step 8: Create/maintain the workflows barrel**

If `src/workflows/index.ts` does not exist, create it:
```ts
export { pushOrderToOngoing } from "./push-order-to-ongoing"
```
If it exists, add that line (keeping existing exports).

- [ ] **Step 9: Commit**

```bash
git add src/workflows/push-order-to-ongoing.ts src/workflows/steps/resolve-integration-context.ts src/workflows/index.ts src/workflows/__tests__/push-order-to-ongoing.test.ts src/workflows/steps/query-fulfillment-order.ts src/lib/ongoing/re-query-fulfillment-order.ts
git commit -m "feat(ongoing-workflow): pushOrderToOngoing composes query/map/push, records sync, returns {ongoingOrderId, orderNumber} (#26)"
```

---

## Task 7: Full suite + plugin build

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (lib, module, workflow).

- [ ] **Step 2: Build the plugin**

Run: `yarn build`
Expected: `medusa plugin:build` completes with no TypeScript errors; output under `.medusa/server`.

> If the build fails because #24/#25/#29 modules (`order-mapper.ts` exporting `mapOrderToPostOrderModel`/`MapOrderInput`, `order-number.ts` exporting `buildOngoingOrderNumber`, `resolve-article-number.ts` exporting `resolveArticleNumber`) do not yet exist, those are hard blockers for this issue — confirm they are merged first. The unit tests mock them, so tests pass independently, but `yarn build` type-checks the real imports.

- [ ] **Step 3: Commit (if build surfaced any fixes)**

```bash
git add -A
git commit -m "chore(ongoing-workflow): build-fix pass for pushOrderToOngoing (#26)"
```

---

## Self-Review (completed during planning)

- **Canonical contract conformance:** workflow named export `pushOrderToOngoing`, input `{ fulfillment_id }`, output `{ ongoingOrderId, orderNumber }` (#26 owns) ✓; shared helper `reQueryFulfillmentOrder(query, fulfillmentId)` is EXPORTED from `src/lib/ongoing/re-query-fulfillment-order.ts` for #27 to import (Task 3) ✓; #29 `resolveArticleNumber(query, sku)` called async per-line inside the re-query step (the step that has `query`), no `resolveSkuCollisions`/`sku-resolver.ts` anywhere (Tasks 3, 4, 6) ✓; #25 `buildOngoingOrderNumber({ displayId, fulfillmentId })` called with a single object arg (Task 4) ✓; #24 `mapOrderToPostOrderModel(input: MapOrderInput)` called once with a single flat object, no post-hoc `{ ...mapped, orderNumber, goodsOwnerId }` double-stamping (Task 4) ✓.
- **Spec coverage (§6, §11):** `pushOrderToOngoing` re-queries the order, maps to `PostOrderModel`, `PUT /api/v1/orders` upsert by generated `orderNumber`, records `OngoingOrderSync` (Tasks 3–6) ✓; compensation/error capture writing `sync_state`/`error_class`/`last_error` (Task 5) ✓; idempotency — order number persisted before PUT, upsert keyed by `orderNumber` (Task 5 pending-before-PUT) ✓; error taxonomy `retryable` vs `terminal` via `OngoingApiError.kind` (Task 5 compensation) ✓; SKU-collision terminal handling composed from #29 `resolveArticleNumber`, throws before any sync row (Task 3) ✓; prices as-is (no ×100/÷100 anywhere) ✓; returns `{ongoingOrderId, orderNumber}` consumed by #21 (Task 6) ✓. Order-number scheme via #25, mapping via #24 — composed, not reimplemented ✓.
- **Client fix:** `putOrder` corrected to the real flat `{orderId, message}` response, returning `{ongoingOrderId}`; old `res.orderInfo.orderId`/`orderNumber` reads removed; client test updated (Task 1) ✓.
- **recordSync:** added to the service (did not exist); create-or-update by `ongoing_order_number` via auto-CRUD `createOngoingOrderSyncs`/`updateOngoingOrderSyncs`/`listOngoingOrderSyncs` (Task 2) ✓.
- **TDD:** every behavior has a failing test first (Tasks 1, 2, 4, 5, 6); the thin query step is covered by the workflow test (Task 6) ✓.
- **Tests requested:** happy path → `putOrder` called with mapped model + records `sync_state="sent"` + `ongoing_order_id` (Task 6) ✓; terminal SKU-resolution error → no `putOrder`, workflow rejects (Task 6) ✓; retryable client error → `error_class="retryable"` (Task 6) ✓; client flat-response fix (Task 1) ✓. Unit tests updated to corrected signatures: mapper single-object call + buildOngoingOrderNumber object arg (Task 4 test), resolveArticleNumber per line mocked (Task 6 test), input `{ fulfillment_id }` (all) ✓.
- **Placeholder scan:** every code step contains full code. The NOTE callouts (`.invoke`/`.compensate` accessor names, `delivery_date` source, `order.id` query field, terminal SKU-resolution error has no sync row, dual named/default workflow export) are explicit verify-points with the resolution method stated, not missing content.
- **Type consistency:** `PushOrderInput`/`PushOrderOutput`, `MapOrderStepInput`/`MapOrderOutput`, `QueriedFulfillmentOrder` (shared helper) / `QueriedFulfillmentOrderWithLines` (step adds `resolvedLines`), `RecordSyncInput`, `ResolveIntegrationContextOutput`, `ONGOING_MODULE`, and `putOrder(): Promise<{ ongoingOrderId: number }>` are used identically across tasks. The canonical `MapOrderInput` (single flat object) and `buildOngoingOrderNumber({ displayId, fulfillmentId })` object arg are owned by #24/#25 and consumed exactly. The workflow's `pushOrderRecordSyncStep` input object matches the step's declared `PushOrderInput`.
- **No git/GitHub side effects in planning:** plan only; commits are execution steps for the implementer.
```
