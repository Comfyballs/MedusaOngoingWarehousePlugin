# `syncOrderEditToOngoing` Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a status-gated, idempotent `syncOrderEditToOngoing` workflow that re-sends the full `PostOrderModel` (same `orderNumber`) to Ongoing via `PUT /api/v1/orders` **only when `OngoingIntegration.edit_sync_rules` allow the edit category for the order's current `latest_status_code`** — and fix the `getOrderStatuses` client parser it implicitly relies on.

**Architecture:** The workflow (named export `syncOrderEditToOngoing`, owned by this issue #27) takes the canonical `GateInput` `{ medusa_order_id: string; medusa_fulfillment_id?: string | null; category: 'line_items' | 'address_contact' }` and runs two phases. Phase 1 is a **gate step** that **selects the `OngoingOrderSync` row by `medusa_fulfillment_id` when present, else by `medusa_order_id`**, loads its `OngoingIntegration`, reads `edit_sync_rules[category]` and compares against the row's cached `latest_status_code`, and returns a decision `{ allowed, reason, ... }` — no Ongoing call, pure read + comparison. Phase 2 runs **only when allowed** (via `when()`): an **upsert step** that re-queries the full fulfillment order via #26's shared `reQueryFulfillmentOrder`, resolves article numbers via #29, re-maps to `PostOrderModel` via #24's pure mapper, calls `client.putOrder` (idempotent upsert by `orderNumber`), and updates the sync row. Blocked edits short-circuit to the canonical result `{ synced: false, blocked: true, reason }` so the consumers (#31/#54) can emit a warning event. The gate decision is conditional logic, which workflow composition forbids inline — so the decision is computed inside a step and the upsert is guarded with `when()`. **M2 note:** because `latest_status_code` is null in M2 until the status-poll milestone (M3/M4), the gate returns `blocked` with `reason: "status_unknown"` for every edit until status codes are populated — an intentional, conservative skip-and-warn, not a defect. A separate, self-contained fix corrects `client.getOrderStatuses` to parse Ongoing's real `{ orderStatuses: [{ number, text }] }` envelope.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (mock the Ongoing client, the module service, and `query.graph`).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Copy from `package.json`.
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"`; module service resolved via the `ONGOING_MODULE` token exported from `src/modules/ongoing/index.ts`.
- Workflows live under `src/workflows/`; steps under `src/workflows/steps/`. Composition functions in `src/workflows/<name>.ts`.
- **Workflow composition rules:** the composition function is a **regular `function`** (not `async`, not arrow); **no inline conditionals/ternaries/`??`/`?.`/`||`/`...`/`new Date()`/loops/try-catch** — use `transform()` and `when()`. (Reference: medusa-dev `building-with-medusa` → workflows.)
- Only GET/POST/DELETE for HTTP routes (N/A here — no routes in this issue), workflows for ALL mutations.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100. (The mapper from #26 owns this; this workflow does not touch prices.)
- TDD: write the failing Jest unit test first (mocked client + `query` + service), then implement. No placeholders.
- Plugin build output is `.medusa/server`; this issue ships a `yarn build` validation step.
- **DEPENDS ON #26** — reuses the same re-query helper + the #24 `PostOrderModel` mapper + the fixed `putOrder`. The exact consumed contract is pinned in Task 3's **Interfaces** block; if #26 named these symbols differently, adapt the imports to #26's actual exports (the workflow logic is unchanged).

---

## File Structure

**Create:**
- `src/workflows/steps/gate-order-edit.ts` — pure gate step: load sync row + integration, compute `{ allowed, reason, ... }` from `edit_sync_rules[category]` vs `latest_status_code`. One read, no mutation, no compensation.
- `src/workflows/steps/upsert-ongoing-order-edit.ts` — re-query the fulfillment order via #26's shared `reQueryFulfillmentOrder`, resolve each line's `article_number` via #29's `resolveArticleNumber`, build a flat `MapOrderInput` and map to `PostOrderModel` via #24's pure mapper, `client.putOrder` upsert, update sync row. One Ongoing call + one mutation; compensation records the error on the sync row.
- `src/workflows/sync-order-edit-to-ongoing.ts` — composition: gate step → `when(allowed).then(upsert step)` → `WorkflowResponse`.
- `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts` — unit tests for the gate logic + the composed workflow (allowed → putOrder called; blocked → putOrder NOT called).
- `src/workflows/index.ts` — barrel re-export (create if absent; append if present).

**Modify:**
- `src/lib/ongoing/client.ts` — fix `getOrderStatuses` parser (and `mapStatus`) to read `{ orderStatuses: [{ number, text }] }`.
- `src/lib/ongoing/__tests__/client.operations.test.ts` — update the existing `getOrderStatuses` test to the real envelope/shape.

---

## Task 1: Fix `getOrderStatuses` to parse Ongoing's real envelope

**Files:**
- Modify: `src/lib/ongoing/client.ts:84-87` (`getOrderStatuses`) and `src/lib/ongoing/client.ts:135-137` (`mapStatus`)
- Test: `src/lib/ongoing/__tests__/client.operations.test.ts` (update the existing `"maps order statuses"` and `"testConnection..."` cases)

**Interfaces:**
- Consumes: `OngoingOrderStatus { number: number; text: string }` (unchanged, from `src/lib/ongoing/types.ts`).
- Produces (changed behavior, same signature): `getOrderStatuses(): Promise<OngoingOrderStatus[]>` now parses `GetOrderStatusesModel = { orderStatuses: { number: number; text: string }[] }` (lowercase keys, wrapped object) instead of a bare `[{ Number, Text }]` array. `testConnection()` is unchanged (it just awaits `getOrderStatuses`).

**Context (why):** The current parser maps `raw.Number`/`raw.Text` off a bare array. Per the Ongoing OpenAPI (v57), `GET /api/v1/orders/statuses` returns a wrapped object `GetOrderStatusesModel { orderStatuses: [{ number, text }] }` with **lowercase** keys. The current code yields `[{ number: undefined, text: undefined }]`. Fix the parser + its test.

- [ ] **Step 1: Update the failing test to the real shape**

In `src/lib/ongoing/__tests__/client.operations.test.ts`, replace the existing `"maps order statuses"` test and the `"testConnection returns true when statuses load"` test with the real envelope:

```ts
  it("maps order statuses from the wrapped GetOrderStatusesModel envelope", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        orderStatuses: [
          { number: 200, text: "Open" },
          { number: 400, text: "Sent" },
        ],
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    const statuses = await client.getOrderStatuses()
    expect(statuses).toEqual([
      { number: 200, text: "Open" },
      { number: 400, text: "Sent" },
    ])
  })

  it("testConnection returns true when statuses load", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderStatuses: [{ number: 200, text: "Open" }] }))
    const client = new OngoingClient(creds, { fetchImpl })
    await expect(client.testConnection()).resolves.toBe(true)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts -t "order statuses"`
Expected: FAIL — the current parser maps `raw.Number`/`raw.Text` off the wrapper object's properties and returns `[]` (or `[{ number: undefined, text: undefined }]`), not the expected array.

- [ ] **Step 3: Fix the parser**

In `src/lib/ongoing/client.ts`, change `getOrderStatuses` (currently around lines 84-87) so it reads the `orderStatuses` array off the wrapper:

```ts
  async getOrderStatuses(): Promise<OngoingOrderStatus[]> {
    const raw = await this.request<{ orderStatuses?: { number: number; text: string }[] }>(
      "GET",
      `/orders/statuses?goodsOwnerId=${this.creds.goodsOwnerId}`
    )
    return (raw?.orderStatuses ?? []).map(mapStatus)
  }
```

And change `mapStatus` (currently around lines 135-137) to read the lowercase keys:

```ts
function mapStatus(raw: { number: number; text: string }): OngoingOrderStatus {
  return { number: raw.number, text: raw.text }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: PASS (all operations tests, including the two updated cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.operations.test.ts
git commit -m "fix(ongoing-client): parse getOrderStatuses GetOrderStatusesModel envelope

Refs #27"
```

---

## Task 2: Gate step — `gateOrderEditStep`

**Files:**
- Create: `src/workflows/steps/gate-order-edit.ts`
- Test: `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts` (the `gateOrderEditStep` describe block; the file is created here and extended in Task 3)

**Interfaces:**
- Consumes:
  - `ONGOING_MODULE` from `../../modules/ongoing` (the module token).
  - The module service (resolved via `container.resolve(ONGOING_MODULE)`) auto-CRUD methods: `listOngoingOrderSyncs(filters)` and `retrieveOngoingIntegration(id)` (auto-generated by `MedusaService` from the `OngoingOrderSync` / `OngoingIntegration` models).
  - `OngoingOrderSync` fields used: `id`, `integration_id`, `ongoing_order_number`, `latest_status_code`. `OngoingIntegration` field used: `edit_sync_rules` (JSON: `{ [category: string]: number[] }`).
- Produces:
  - `type OrderEditCategory = "address_contact" | "line_items"`
  - `type GateInput = { medusa_order_id: string; medusa_fulfillment_id?: string | null; category: OrderEditCategory }`
  - `type GateDecision = { allowed: boolean; reason: string; order_sync_id?: string; integration_id?: string; ongoing_order_number?: string; latest_status_code?: number | null; medusa_order_id: string; medusa_fulfillment_id?: string | null; category: OrderEditCategory }`
  - `const gateOrderEditStep` — a `createStep` returning `StepResponse<GateDecision>`.
- Gate semantics (verified against spec §8): blocked when **no sync row** (`reason: "no_sync_row"`), when **no integration / no `edit_sync_rules`** (`reason: "no_edit_rules"`), or when `latest_status_code` is **not in** the allowed list for `category` (`reason: "status_blocked"`). Allowed only when `latest_status_code` is present **and** included in `edit_sync_rules[category]` (`reason: "allowed"`). A `null`/missing `latest_status_code` is treated as **blocked** (`reason: "status_unknown"`) — we never upsert without a known, allowed status.

- [ ] **Step 1: Write the failing test for the gate logic**

Create `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`:

```ts
import { gateOrderEditStep } from "../steps/gate-order-edit"

// Invoke a Medusa step's inner function directly. createStep returns an
// invocable whose underlying handler is reachable for unit testing via the
// step's `invoke` — but the simplest, version-stable approach is to export and
// test the pure decision function. We test the pure function here (see Step 3).
import { decideOrderEditGate } from "../steps/gate-order-edit"

describe("decideOrderEditGate", () => {
  const base = {
    medusa_order_id: "order_1",
    category: "line_items" as const,
  }

  it("allows when latest_status_code is in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 200,
      },
      integration: { edit_sync_rules: { line_items: [200, 210], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("allowed")
    expect(decision.ongoing_order_number).toBe("1001-abc")
    expect(decision.order_sync_id).toBe("os_1")
    expect(decision.integration_id).toBe("int_1")
  })

  it("blocks when latest_status_code is NOT in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 500,
      },
      integration: { edit_sync_rules: { line_items: [200], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_blocked")
  })

  it("uses the category-specific allow list (address_contact vs line_items)", () => {
    const sync = {
      id: "os_1",
      integration_id: "int_1",
      ongoing_order_number: "1001-abc",
      latest_status_code: 300,
    }
    const rules = { line_items: [200], address_contact: [300] }
    expect(decideOrderEditGate({ input: { ...base, category: "address_contact" }, sync, integration: { edit_sync_rules: rules } }).allowed).toBe(true)
    expect(decideOrderEditGate({ input: { ...base, category: "line_items" }, sync, integration: { edit_sync_rules: rules } }).allowed).toBe(false)
  })

  it("blocks with status_unknown when latest_status_code is null", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: null },
      integration: { edit_sync_rules: { line_items: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_unknown")
  })

  it("blocks with no_sync_row when there is no sync row", () => {
    const decision = decideOrderEditGate({ input: base, sync: undefined, integration: undefined })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_sync_row")
  })

  it("blocks with no_edit_rules when integration has no edit_sync_rules", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 200 },
      integration: { edit_sync_rules: null },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_edit_rules")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`
Expected: FAIL — cannot find module `../steps/gate-order-edit`.

- [ ] **Step 3: Implement the gate step (pure decision + step wrapper)**

Create `src/workflows/steps/gate-order-edit.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type OrderEditCategory = "address_contact" | "line_items"

export type GateInput = {
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  category: OrderEditCategory
}

export type GateDecision = {
  allowed: boolean
  reason: string
  order_sync_id?: string
  integration_id?: string
  ongoing_order_number?: string
  latest_status_code?: number | null
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  category: OrderEditCategory
}

type SyncRow = {
  id: string
  integration_id: string
  ongoing_order_number: string
  latest_status_code: number | null
}

type IntegrationRow = {
  edit_sync_rules: Record<string, number[]> | null
}

/**
 * Pure gate decision. Exported for direct unit testing (no container needed).
 * Blocked unless the sync row + integration exist, the integration has
 * edit_sync_rules for the category, the order's cached latest_status_code is
 * known, and that code is in the allow list for the edit category.
 */
export function decideOrderEditGate(args: {
  input: GateInput
  sync?: SyncRow
  integration?: IntegrationRow
}): GateDecision {
  const { input, sync, integration } = args
  const base = {
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    category: input.category,
  }

  if (!sync) {
    return { allowed: false, reason: "no_sync_row", ...base }
  }

  const carried = {
    order_sync_id: sync.id,
    integration_id: sync.integration_id,
    ongoing_order_number: sync.ongoing_order_number,
    latest_status_code: sync.latest_status_code,
    ...base,
  }

  const rules = integration?.edit_sync_rules
  if (!rules) {
    return { allowed: false, reason: "no_edit_rules", ...carried }
  }

  if (sync.latest_status_code === null || sync.latest_status_code === undefined) {
    return { allowed: false, reason: "status_unknown", ...carried }
  }

  const allowedCodes = rules[input.category] ?? []
  if (!allowedCodes.includes(sync.latest_status_code)) {
    return { allowed: false, reason: "status_blocked", ...carried }
  }

  return { allowed: true, reason: "allowed", ...carried }
}

export const gateOrderEditStep = createStep(
  "ongoing-gate-order-edit",
  async (input: GateInput, { container }) => {
    const service = container.resolve(ONGOING_MODULE) as {
      listOngoingOrderSyncs: (filters: Record<string, unknown>) => Promise<SyncRow[]>
      retrieveOngoingIntegration: (id: string) => Promise<IntegrationRow>
    }

    const filters: Record<string, unknown> = input.medusa_fulfillment_id
      ? { medusa_fulfillment_id: input.medusa_fulfillment_id }
      : { medusa_order_id: input.medusa_order_id }

    const [sync] = await service.listOngoingOrderSyncs(filters)
    const integration = sync
      ? await service.retrieveOngoingIntegration(sync.integration_id)
      : undefined

    const decision = decideOrderEditGate({ input, sync, integration })
    return new StepResponse(decision)
  }
)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`
Expected: PASS (6 `decideOrderEditGate` assertions).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/gate-order-edit.ts src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts
git commit -m "feat(ongoing-workflow): edit-gate step with edit_sync_rules vs latest_status_code

Refs #27"
```

---

## Task 3: Upsert step + composed `syncOrderEditToOngoing` workflow

**Files:**
- Create: `src/workflows/steps/upsert-ongoing-order-edit.ts`
- Create: `src/workflows/sync-order-edit-to-ongoing.ts`
- Modify: `src/workflows/index.ts` (create if absent)
- Test: `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts` (add the workflow describe block)

**Interfaces:**
- Consumes:
  - From Task 2: `gateOrderEditStep`, `GateInput`, `GateDecision`, `OrderEditCategory`.
  - **From #26 (canonical pinned contracts — these are authoritative):**
    - `reQueryFulfillmentOrder(query, fulfillmentId: string): Promise<QueriedFulfillmentOrder>` (and the `QueriedFulfillmentOrder` type) from `../../lib/ongoing/re-query-fulfillment-order` (the **shared, exported** re-query helper #26 owns). Import THIS — do not invent a `reQueryOrderForOngoing` (it does not exist). It re-queries the full fulfillment order via `query.graph`, keyed by the **`medusa_fulfillment_id`** on the targeted sync row. **Result shape (canonical):** `items` is **top-level** (`Array<{ quantity, sku, barcode, title, line_item_id }>`); the order fields are **nested** under `.order` (`order.display_id`, `order.currency_code`, `order.email`, `order.shipping_address.*`). There is **no `delivery_date`** on the helper result. For this issue's unit tests it is **mocked** via `jest.mock`.
    - `mapOrderToPostOrderModel(input: MapOrderInput): PostOrderModel` from `src/lib/ongoing/order-mapper.ts` (#24) — **PURE**, takes a single flat `MapOrderInput` object `{ goods_owner_id, order_number, delivery_date, currency_code, email?, shipping_address, lines: Array<{ article_number, quantity, weight?, unit_price? }> }`; **mocked** in tests. Each line's `article_number` is resolved **upstream** via #29's `resolveArticleNumber(query, sku)` (same as #26 does), not by the mapper.
    - `resolveArticleNumber(query, sku): Promise<string>` from `src/lib/ongoing/resolve-article-number.ts` (#29) — resolve each line's `article_number` from its Medusa SKU, in a step that has `query`. **Mocked** in tests.
    - `OngoingClient.putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }>` (the fixed client; obtained from `service.getClient(credentialKey)`). The flat `PostOrderResponse` does **not** echo `orderNumber` — reuse the `ongoing_order_number` already carried on the gate decision when writing the sync row.
  - `ONGOING_MODULE` module service: `retrieveOngoingIntegration(id)` (to resolve `credential_key` + `goods_owner_id`), `getClient(credentialKey)`, and `updateOngoingOrderSyncs(...)` (auto-CRUD).
- Produces:
  - `const upsertOngoingOrderEditStep` — `createStep` taking `GateDecision` (the allowed decision; carries `ongoing_order_number`, `order_sync_id`, `integration_id`, `medusa_order_id`, `medusa_fulfillment_id`), runs re-query (by `medusa_fulfillment_id`) → resolve article numbers → map → `putOrder` → update sync row, returns `StepResponse<{ ongoing_order_id: number; ongoing_order_number: string }>`. Compensation records `sync_state: "error"` + `error_class` + `last_error` on the sync row.
  - `const syncOrderEditToOngoing` — `createWorkflow` taking `GateInput`, returns `WorkflowResponse<{ synced: boolean; blocked: boolean; reason: string }>`.
  - `src/workflows/index.ts` re-exports `syncOrderEditToOngoing` (default) and the step/type names.

> NOTE on the #26/#24/#29 contracts (canonical, authoritative): this issue is sequenced after #26, so the **shared exported** `reQueryFulfillmentOrder(query, fulfillmentId)` helper (#26), the **pure** `mapOrderToPostOrderModel(input: MapOrderInput)` mapper (#24), and `resolveArticleNumber(query, sku)` (#29) already exist and are reused verbatim (DRY). The upsert step imports `reQueryFulfillmentOrder` (and the `QueriedFulfillmentOrder` type) from `../../lib/ongoing/re-query-fulfillment-order` — there is no `reQueryOrderForOngoing`. Its result has **top-level `items`** and **nested `order.*`** fields and **no `delivery_date`**. Do not re-implement the mapper, the re-query, or the SKU resolver here.

> NOTE on M2 status-gate reality (intentional inert behavior): in M2, `OngoingOrderSync.latest_status_code` is **NULL** until the status-poll milestone (M3/M4) populates it. So for EDIT-SYNC in M2 the gate **always** returns `{ synced: false, blocked: true, reason: "status_unknown" }` (skip + warn) — this is the conservative, documented behavior: we never upsert without a known, allowed status. The full gate logic (allow lists per category) is built and tested now so it activates automatically once status codes are populated; until then the inert "skip with status_unknown" result is **intended, not a bug**.

- [ ] **Step 1: Write the failing test for the composed workflow**

Append to `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`:

```ts
import { syncOrderEditToOngoing } from "../sync-order-edit-to-ongoing"

// Mock the #26 shared re-query helper, the #24 pure mapper, and the #29 SKU
// resolver so the upsert step is isolated. The re-query helper returns #26's
// canonical QueriedFulfillmentOrder shape: items TOP-LEVEL, order fields NESTED
// under .order, and NO delivery_date.
jest.mock("../../lib/ongoing/re-query-fulfillment-order", () => ({
  reQueryFulfillmentOrder: jest.fn().mockResolvedValue({
    items: [{ quantity: 2, sku: "SKU-1", barcode: "BC-1", title: "Item 1", line_item_id: "li_1" }],
    order: {
      display_id: 1001,
      currency_code: "eur",
      email: "a@b.com",
      shipping_address: { first_name: "A", last_name: "B" },
    },
  }),
}))
jest.mock("../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn().mockResolvedValue("ART-1"),
}))
jest.mock("../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn().mockReturnValue({ orderNumber: "1001-abc", goodsOwnerId: 7 }),
}))

const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })

const makeService = (overrides: Record<string, unknown> = {}) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue([
    { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 200 },
  ]),
  retrieveOngoingIntegration: jest.fn().mockResolvedValue({
    edit_sync_rules: { line_items: [200], address_contact: [200] },
    credential_key: "wh-a",
    goods_owner_id: 7,
  }),
  getClient: jest.fn().mockReturnValue({ putOrder }),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
  ...overrides,
})

// Minimal fake container the workflow steps resolve against.
const makeScope = (service: Record<string, unknown>) => {
  const container = {
    resolve: (key: string) => {
      if (key === "ongoing") return service
      if (key === "query") return { graph: jest.fn() }
      throw new Error(`unexpected resolve("${key}")`)
    },
  }
  return container as any
}

describe("syncOrderEditToOngoing workflow", () => {
  beforeEach(() => {
    putOrder.mockClear()
  })

  it("calls putOrder with the re-mapped model when the status is allowed", async () => {
    const service = makeService()
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
    })

    expect(putOrder).toHaveBeenCalledTimes(1)
    expect(putOrder).toHaveBeenCalledWith({ orderNumber: "1001-abc", goodsOwnerId: 7 })
    expect(result).toMatchObject({ synced: true, blocked: false, reason: "allowed" })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalled()
  })

  it("does NOT call putOrder when the status is blocked", async () => {
    const service = makeService({
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([
        { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 999 },
      ]),
    })
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
    })

    expect(putOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({ synced: false, blocked: true, reason: "status_blocked" })
  })

  it("does NOT call putOrder when there is no sync row", async () => {
    const service = makeService({ listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) })
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_x", category: "address_contact" },
    })

    expect(putOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({ synced: false, blocked: true, reason: "no_sync_row" })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`
Expected: FAIL — cannot find module `../sync-order-edit-to-ongoing`.

- [ ] **Step 3: Implement the upsert step**

Create `src/workflows/steps/upsert-ongoing-order-edit.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import { OngoingApiError } from "../../lib/ongoing/errors"
// Canonical #26 contract: the SHARED, EXPORTED re-query helper #26 owns.
import { reQueryFulfillmentOrder } from "../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"
import { mapOrderToPostOrderModel } from "../../lib/ongoing/order-mapper"
import type { GateDecision } from "./gate-order-edit"

export type UpsertResult = {
  ongoing_order_id: number
  ongoing_order_number: string
}

export const upsertOngoingOrderEditStep = createStep(
  "ongoing-upsert-order-edit",
  async (decision: GateDecision, { container }) => {
    const service = container.resolve(ONGOING_MODULE) as {
      retrieveOngoingIntegration: (id: string) => Promise<{ credential_key: string; goods_owner_id: number }>
      getClient: (credentialKey: string) => {
        putOrder: (order: Record<string, unknown>) => Promise<{ ongoingOrderId: number }>
      }
      updateOngoingOrderSyncs: (data: Record<string, unknown>) => Promise<unknown>
    }
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const integration = await service.retrieveOngoingIntegration(decision.integration_id as string)
    const client = service.getClient(integration.credential_key)

    // Re-query the full fulfillment order via #26's SHARED exported helper,
    // keyed by the medusa_fulfillment_id on the targeted sync row. The result is
    // #26's canonical QueriedFulfillmentOrder: items TOP-LEVEL, order fields
    // NESTED under .order, NO delivery_date.
    const result = await reQueryFulfillmentOrder(query, decision.medusa_fulfillment_id as string)

    // Resolve each line's article_number upstream via #29 (same as #26 does),
    // then build a SINGLE flat MapOrderInput and call the PURE #24 mapper.
    // Keep the SAME order_number from the sync row so PUT /orders upserts.
    const lines = await Promise.all(
      result.items.map(async (item) => ({
        article_number: await resolveArticleNumber(query, item.sku),
        quantity: item.quantity,
      }))
    )
    const model = mapOrderToPostOrderModel({
      goods_owner_id: integration.goods_owner_id,
      order_number: decision.ongoing_order_number as string,
      // The re-query helper carries no delivery_date — source it the same way
      // #26 does.
      delivery_date: new Date().toISOString(),
      currency_code: result.order.currency_code,
      email: result.order.email,
      shipping_address: result.order.shipping_address,
      lines,
    })

    const res = await client.putOrder(model)

    await service.updateOngoingOrderSyncs({
      id: decision.order_sync_id,
      ongoing_order_id: res.ongoingOrderId,
      // putOrder does NOT echo orderNumber — reuse the value carried on the gate
      // decision (the same idempotency key we upserted by).
      ongoing_order_number: decision.ongoing_order_number,
      sync_state: "sent",
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
    })

    const upsertResult: UpsertResult = {
      ongoing_order_id: res.ongoingOrderId,
      ongoing_order_number: decision.ongoing_order_number as string,
    }
    return new StepResponse(upsertResult, decision.order_sync_id)
  },
  // Compensation: on failure, record the error on the sync row.
  async (orderSyncId, { container }) => {
    if (!orderSyncId) {
      return
    }
    const service = container.resolve(ONGOING_MODULE) as {
      updateOngoingOrderSyncs: (data: Record<string, unknown>) => Promise<unknown>
    }
    await service.updateOngoingOrderSyncs({
      id: orderSyncId,
      sync_state: "error",
      error_class: "retryable",
      last_error: "syncOrderEditToOngoing upsert failed",
    })
  }
)

// Re-exported so the error type used in classification stays adjacent to the step.
export { OngoingApiError }
```

> NOTE on error classification: the compensation above records a generic `retryable` error so the row is picked up by `retryFailedSyncs`. A terminal classification (validation / 4xx) is handled at the point the `OngoingApiError` is thrown by the client (`err.kind`); a follow-up issue refines compensation to read `err.kind`. For #27, recording the error + state is sufficient and matches spec §6 ("error capture writing OngoingOrderSync").

- [ ] **Step 4: Implement the composed workflow**

Create `src/workflows/sync-order-edit-to-ongoing.ts`:

```ts
import { createWorkflow, WorkflowResponse, transform, when } from "@medusajs/framework/workflows-sdk"
import { gateOrderEditStep, type GateInput } from "./steps/gate-order-edit"
import { upsertOngoingOrderEditStep } from "./steps/upsert-ongoing-order-edit"

export type SyncOrderEditResult = {
  synced: boolean
  blocked: boolean
  reason: string
}

const syncOrderEditToOngoing = createWorkflow(
  "sync-order-edit-to-ongoing",
  function (input: GateInput) {
    const decision = gateOrderEditStep(input)

    // Only run the upsert when the gate allows it. when() replaces the
    // forbidden inline conditional in workflow composition.
    const upsert = when(decision, (d) => d.allowed).then(() => {
      return upsertOngoingOrderEditStep(decision)
    })

    const result = transform({ decision, upsert }, (data): SyncOrderEditResult => {
      const allowed = data.decision.allowed
      return {
        synced: allowed && !!data.upsert,
        blocked: !allowed,
        reason: data.decision.reason,
      }
    })

    return new WorkflowResponse(result)
  }
)

export default syncOrderEditToOngoing
export { syncOrderEditToOngoing }
```

- [ ] **Step 5: Run the workflow test to verify it passes**

Run: `yarn test src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts`
Expected: PASS (the 6 gate assertions from Task 2 + the 3 workflow assertions: allowed → `putOrder` called once with the mapped model; blocked status → not called, `reason: "status_blocked"`; no sync row → not called, `reason: "no_sync_row"`).

- [ ] **Step 6: Add/extend the workflows barrel**

If `src/workflows/index.ts` does not exist, create it. If it exists, append the exports. Content (or appended lines):

```ts
export { default as syncOrderEditToOngoing } from "./sync-order-edit-to-ongoing"
export type { SyncOrderEditResult } from "./sync-order-edit-to-ongoing"
export { gateOrderEditStep, decideOrderEditGate } from "./steps/gate-order-edit"
export type { GateInput, GateDecision, OrderEditCategory } from "./steps/gate-order-edit"
export { upsertOngoingOrderEditStep } from "./steps/upsert-ongoing-order-edit"
export type { UpsertResult } from "./steps/upsert-ongoing-order-edit"
```

> NOTE: If `src/workflows/index.ts` already re-exports other workflows from #26 (e.g. `pushOrderToOngoing`), keep those lines and only add the ones above — do not overwrite the file.

- [ ] **Step 7: Build the plugin to validate types compile**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`. If the build errors because #26's `reQueryFulfillmentOrder` (`src/lib/ongoing/re-query-fulfillment-order.ts`), #24's `order-mapper`, or #29's `resolve-article-number` are absent (e.g. building this issue before they land), confirm those deliverables exist at their canonical paths.

- [ ] **Step 8: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/steps/upsert-ongoing-order-edit.ts src/workflows/sync-order-edit-to-ongoing.ts src/workflows/index.ts src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts
git commit -m "feat(ongoing-workflow): syncOrderEditToOngoing status-gated idempotent PUT /orders upsert

Closes #27"
```

---

## Self-Review (completed during planning)

- **Spec coverage:**
  - §6 line 193 (`syncOrderEditToOngoing` — status-gated `PUT /api/v1/orders` upsert, same idempotent endpoint) → Tasks 2+3 ✓.
  - §8 lines 236-239 (resolve `OngoingOrderSync` + `latest_status_code`; classify by category vs `edit_sync_rules`; allowed → run `syncOrderEditToOngoing`; blocked → skip + return blocked so the subscriber emits a warning) → gate step (Task 2) + workflow result `{ synced, blocked, reason }` (Task 3) ✓.
  - §6 line 204 (every Ongoing call has error capture writing `OngoingOrderSync` sync_state/error_class/last_error) → upsert-step compensation (Task 3) ✓.
  - §6 line 209 + §11 (idempotency: upsert by `orderNumber`) → upsert step reuses the SAME `ongoing_order_number` from the sync row (Task 3) ✓.
  - Client fix (`getOrderStatuses` → `{ orderStatuses: [{ number, text }] }` envelope) → Task 1 ✓.
- **Placeholder scan:** every code step contains full, runnable code. The two NOTEs (#26 import names; error-classification refinement) are explicit verify/scope points with stated resolutions, not missing content.
- **Type consistency:** `GateInput`, `GateDecision`, `OrderEditCategory`, `decideOrderEditGate`, `gateOrderEditStep`, `upsertOngoingOrderEditStep`, `syncOrderEditToOngoing`, and `SyncOrderEditResult` are named identically across the Interfaces blocks, implementations, tests, and the barrel. The gate `reason` strings (`allowed`/`status_blocked`/`status_unknown`/`no_sync_row`/`no_edit_rules`) match between the gate impl, the workflow result mapping, and the assertions.
- **Consumed-contract note (canonical):** #26's **shared exported** `reQueryFulfillmentOrder(query, fulfillmentId)` from `src/lib/ongoing/re-query-fulfillment-order.ts` (result: top-level `items`, nested `order.*`, no `delivery_date`), #29's `resolveArticleNumber(query, sku)`, #24's **pure** `mapOrderToPostOrderModel(input: MapOrderInput)` (single flat object; lines carry resolved `article_number`), and the fixed `putOrder` (returns `{ ongoingOrderId: number }` only — no `orderNumber` echo) are reused, not re-implemented (DRY). There is no `reQueryOrderForOngoing`. The mapper is called with one `MapOrderInput` object — not `(orderContext, { orderNumber })`. The sync row's `ongoing_order_number` is reused from the gate decision, not read off the `putOrder` response.
- **Gate I/O contract (canonical, consumed by #31/#54):** `GateInput = { medusa_order_id: string; medusa_fulfillment_id?: string | null; category: 'line_items' | 'address_contact' }`; result `{ synced: boolean; blocked: boolean; reason: string }`. The gate selects the sync row by `medusa_fulfillment_id` when present, else `medusa_order_id`.
- **M2 status-gate reality:** `latest_status_code` is null in M2 until the status-poll milestone, so the gate returns `blocked` with `reason: "status_unknown"` (skip + warn) until codes are populated — intentional inert behavior, documented in the Task 3 NOTE.
- **Workflow-rule compliance:** composition uses a regular `function`, `when()` for the gate-conditional upsert, and `transform()` for the result object — no inline conditionals/spreads/`new Date()` in the composition (the `new Date()` calls live inside step bodies, which is allowed).

## Known verify-points
- #26's `reQueryFulfillmentOrder` is exported from `src/lib/ongoing/re-query-fulfillment-order.ts` (import + `jest.mock` path: `../../lib/ongoing/re-query-fulfillment-order`); the helper name, `(query, fulfillmentId)` signature, and `QueriedFulfillmentOrder` result shape (top-level `items`, nested `order.*`, no `delivery_date`) are canonical and fixed.
- Terminal-vs-retryable refinement in upsert compensation (Task 3 NOTE) — deferred to a follow-up; #27 records the error + state, satisfying spec §6.
