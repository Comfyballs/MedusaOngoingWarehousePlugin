# syncOngoingInventory Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. REQUIRED: follow superpowers:test-driven-development — write the failing Jest test first for every step that contains logic, then make it pass.

**Goal:** Build the `syncOngoingInventoryWorkflow` (issue #37) that pulls all inventory from Ongoing via `GetInventoryByQuery`, matches each row to a Medusa `InventoryItem` by SKU, and reconciles `stocked_quantity` + `incoming_quantity` at the integration's stock location using one of three configurable modes (`sellable_plus_reserved`, `precise`, `onhand`). The read of Medusa reservations and the write of `stocked_quantity` happen inside a **single step** to minimize the concurrent-reservation clobber window (spec §9). Rows with no SKU match, multiple SKU matches, or no inventory level at the location are silently skipped with a `logger.warn` and a counter increment. The workflow returns `{ written: number; skipped: number }` for the dispatcher (#38) to log; timestamp-stamping and lock release live in the dispatcher, not here.

**Architecture:** One Medusa workflow (`src/workflows/sync-ongoing-inventory.ts`) composed of two custom steps: (1) `fetchOngoingInventoryStep` — calls the Ongoing client and returns the raw `OngoingInventoryRow[]`; (2) `reconcileInventoryLevelsStep` — resolves the Medusa inventory service and (for `precise` mode) the query service, loops all rows, reads reservations, computes stocked quantity, clamps to zero, and writes both `stocked_quantity` and `incoming_quantity` in a single `updateInventoryLevels` call per row. The composition uses `transform()` to thread step outputs into step inputs — no logic in the `createWorkflow` body itself.

**Also includes a bug fix:** `src/lib/ongoing/client.ts` `getInventory()` does not pass `pageSize` to the API (unlike `getOrdersByStatus` which does). This must be fixed before the new workflow so the pagination sentinel (`batch.length < ONGOING_PAGE_SIZE`) fires correctly.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`, `@medusajs/framework/utils`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest 29 + `@swc/jest`.

## Global Constraints

- Medusa version floor: **2.16.0**. Package manager **yarn 4.6.0**, Node **>= 20**.
- Module id is `"ongoing"`; resolve with `container.resolve(ONGOING_MODULE)` where `ONGOING_MODULE = "ongoing"` (`src/modules/ongoing/index.ts:5`).
- Inventory module: `container.resolve(Modules.INVENTORY)` from `@medusajs/framework/utils`. `Modules.INVENTORY` is the standard string constant for the Medusa inventory module service.
- **Workflow composition body rules** (`createWorkflow(...)` body): no `async`, no arrow-function steps, no conditionals/ternaries/`??`/`?.`/`||`/spread, no `try/catch`, no loops. Use `transform()`. Step handler bodies are ordinary runtime code (conditionals, loops, try/catch allowed). `yarn build` catches illegal constructs.
- TDD: a **failing Jest unit test** comes before each step's logic.
- No new migration: `OngoingIntegration` already has `stock_reconcile_mode`, `stock_location_id`, `credential_key` (`src/modules/ongoing/models/integration.ts`).
- Prices/quantities stored as-is — never x100 or /100 (spec §11).

---

## Background — verified facts the implementer must not re-derive

- **`getInventory()` bug:** `src/lib/ongoing/client.ts:100` sends `&page=${page}` but NOT `&pageSize=${ONGOING_PAGE_SIZE}`. `getOrdersByStatus` at line 108 passes both. The `paginate()` sentinel at line 138 stops when `batch.length < ONGOING_PAGE_SIZE` (= 50). If Ongoing's default page size differs from 50, the sentinel misfires and silently drops pages. Fix: append `&pageSize=${ONGOING_PAGE_SIZE}` to the inventory URL, mirroring line 108.

- **`getInventory()` signature:** `async getInventory(articleNumbers?: string[]): Promise<OngoingInventoryRow[]>` at `src/lib/ongoing/client.ts:97`. Call with no args for all inventory. The `OngoingInventoryRow` interface (`src/lib/ongoing/types.ts:17-24`) has: `articleNumber: string`, `articleSystemId?: number`, `numberOfItems: number`, `allocatedNumberOfItems: number`, `sellableNumberOfItems: number`, `toReceiveNumberOfItems: number`.

- **Pagination + 429 handling:** `paginate()` at `src/lib/ongoing/client.ts:132-143` and `request()` at `src/lib/ongoing/client.ts:36-57` already handle throttling, 429/Retry-After backoff, and retries. No extra handling needed in the workflow steps.

- **Medusa inventory service methods:** resolved via `container.resolve(Modules.INVENTORY)`.
  - `listInventoryItems({ sku: string }, config?)` returns `InventoryItemDTO[]` with `{ id, sku }`.
  - `listInventoryLevels({ inventory_item_id: string, location_id: string }, config?)` returns `InventoryLevelDTO[]` with `{ id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity, available_quantity }`.
  - `listReservationItems({ inventory_item_id: string, location_id: string }, config?)` returns `ReservationItemDTO[]` with `{ id, inventory_item_id, location_id, quantity, line_item_id }`.
  - `updateInventoryLevels([{ id, inventory_item_id, location_id, stocked_quantity, incoming_quantity }])` — array input; both fields in one object. The level `id` comes from the prior `listInventoryLevels` read.

- **Skip-with-warn decisions (settled):**
  - `listInventoryItems` returns 0 matches for `row.articleNumber` — `logger.warn("[ongoing] inventory-sync: SKU not found in Medusa — skipping")`, increment `skipped`.
  - `listInventoryItems` returns more than 1 match — `logger.warn("[ongoing] inventory-sync: SKU collision — skipping")`, increment `skipped`.
  - `listInventoryLevels` returns 0 entries for `(inventory_item_id, stock_location_id)` — `logger.warn("[ongoing] inventory-sync: no inventory level at location — skipping")`, increment `skipped`. Do NOT auto-create a level.

- **Reconcile formulas (spec §9).** Let `M_res = level.reserved_quantity` (from the `listInventoryLevels` read):
  - **A `sellable_plus_reserved` (default):** `stocked_quantity = Math.max(0, row.sellableNumberOfItems + Math.min(M_res, row.allocatedNumberOfItems))`
  - **B `precise`:** `stocked_quantity = Math.max(0, row.sellableNumberOfItems + M_res_synced)` where `M_res_synced` is computed per-row (see below).
  - **C `onhand`:** `stocked_quantity = Math.max(0, row.numberOfItems)`
  - All modes: `incoming_quantity = row.toReceiveNumberOfItems`.
  - Clamp: the `Math.max(0, ...)` in every formula is the clamp.

- **`M_res_synced` for `precise` mode** (pre-fetched once before the row loop):
  1. `const syncs = await ongoing.listOngoingOrderSyncs({ integration_id, sync_state: 'sent' })` — only `'sent'` rows count (`'pending'` rows are not yet Ongoing allocations).
  2. `const syncedOrderIds = syncs.map(s => s.medusa_order_id).filter(Boolean)`.
  3. If `syncedOrderIds.length > 0`: call `query.graph({ entity: 'order', fields: ['id', 'items.id'], filters: { id: syncedOrderIds } })` — build `syncedLineItemIds: Set<string>` from `order.items[].id`.
  4. **DEV VERIFICATION (see Task 2):** confirm the field path `'items.id'` (vs `'line_items.id'`) against a live Medusa 2.16.0 instance during implementation. Adjust if needed.
  5. Per row in the loop: `const reservations = await inventoryService.listReservationItems({ inventory_item_id: item.id, location_id: stockLocationId })`. `M_res_synced = reservations.filter(r => r.line_item_id != null && syncedLineItemIds.has(r.line_item_id)).reduce((sum, r) => sum + (r.quantity ?? 0), 0)`.

- **`ContainerRegistrationKeys.QUERY`:** resolve via `container.resolve(ContainerRegistrationKeys.QUERY)` from `@medusajs/framework/utils` — same pattern as `src/workflows/steps/upsert-ongoing-order-edit.ts:35`.

- **`ONGOING_MODULE`:** imported from `src/modules/ongoing/index.ts` (exports `const ONGOING_MODULE = "ongoing"`).

- **Workflow input:** `SyncOngoingInventoryInput = { integration_id: string; credential_key: string; stock_location_id: string; goods_owner_id: number; stock_reconcile_mode: 'sellable_plus_reserved' | 'precise' | 'onhand' }`. All fields pre-resolved by the dispatcher (#38) before calling this workflow. `goods_owner_id` is on the input type for dispatcher contract consistency even though inventory fetch does not use it.

- **Barrel:** `src/workflows/index.ts` currently ends at line 23. Append the new exports after the existing `syncOngoingShipmentWorkflow` export block.

- **Test infrastructure:** Jest 29 + `@swc/jest`; `"test": "jest"` already in `package.json:34`; container mock via `createMedusaContainer` + `asValue` from `awilix` (pattern from `src/workflows/__tests__/sync-ongoing-shipment.test.ts:1-3`).

---

## File Structure

**Modify:**
- `src/lib/ongoing/client.ts` — add `&pageSize=${ONGOING_PAGE_SIZE}` to the `getInventory()` URL at line 100.

**Create:**
- `src/workflows/steps/fetch-ongoing-inventory.ts` — `fetchOngoingInventoryStep` + exported `fetchOngoingInventoryHandler`.
- `src/workflows/steps/reconcile-inventory-levels.ts` — `reconcileInventoryLevelsStep` + exported `reconcileInventoryLevelsHandler`.
- `src/workflows/sync-ongoing-inventory.ts` — `syncOngoingInventoryWorkflow` + `SyncOngoingInventoryInput` type.
- `src/workflows/steps/__tests__/fetch-ongoing-inventory.test.ts`
- `src/workflows/steps/__tests__/reconcile-inventory-levels.test.ts`
- `src/workflows/__tests__/sync-ongoing-inventory.test.ts`

**Modify:**
- `src/workflows/index.ts` — export `syncOngoingInventoryWorkflow` and `SyncOngoingInventoryInput`.

---

## Task 0: Fix `getInventory()` missing `pageSize` parameter

**Files:**
- Modify: `src/lib/ongoing/client.ts`
- Extend/create: `src/lib/ongoing/__tests__/client.test.ts`

**Behavior:** Line 100 of `src/lib/ongoing/client.ts` currently reads:

```ts
this.request<any[]>("GET", `/articles/inventory?goodsOwnerId=${this.creds.goodsOwnerId}&page=${page}${filter}`)
```

After the fix it must read:

```ts
this.request<any[]>("GET", `/articles/inventory?goodsOwnerId=${this.creds.goodsOwnerId}&page=${page}&pageSize=${ONGOING_PAGE_SIZE}${filter}`)
```

`ONGOING_PAGE_SIZE` is already defined at `src/lib/ongoing/client.ts:146`.

- [ ] **Step 1: Write the failing test**

Check whether `src/lib/ongoing/__tests__/client.test.ts` exists. Extend it if present; create it if not. Add a test that verifies every inventory fetch call includes `pageSize=50`:

```ts
// src/lib/ongoing/__tests__/client.test.ts  (extend or create)
import { OngoingClient } from "../client"

describe("OngoingClient.getInventory — pageSize", () => {
  it("passes pageSize=50 on every inventory page request", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      article: { articleNumber: `SKU-${i}`, articleSystemId: i },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 0,
        SellableNumberOfItems: 10,
        ToReceiveNumberOfItems: 0,
      },
    }))
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(fullPage),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([]),
        headers: { get: () => null },
      })
    const client = new OngoingClient(
      { key: "k", baseUrl: "https://api.example.com/api/v1", username: "u", password: "p", goodsOwnerId: 42 },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    await client.getInventory()
    const allUrls: string[] = (fetchImpl as jest.Mock).mock.calls.map(([url]: [string]) => url)
    for (const url of allUrls) {
      expect(url).toContain("pageSize=50")
    }
  })
})
```

Run `yarn test -- --testPathPattern="client.test"` — must fail because `pageSize` is absent from the current URL.

- [ ] **Step 2: Apply the fix**

In `src/lib/ongoing/client.ts` line 100, change the template string to:

```ts
this.request<any[]>("GET", `/articles/inventory?goodsOwnerId=${this.creds.goodsOwnerId}&page=${page}&pageSize=${ONGOING_PAGE_SIZE}${filter}`)
```

- [ ] **Step 3: Verify**

Run `yarn test -- --testPathPattern="client.test"`. The new test must pass.

---

## Task 1: `fetchOngoingInventoryStep`

**Files:**
- Create: `src/workflows/steps/fetch-ongoing-inventory.ts`
- Create: `src/workflows/steps/__tests__/fetch-ongoing-inventory.test.ts`

**Exported symbols:**
- `type FetchOngoingInventoryInput = { credential_key: string }`
- `fetchOngoingInventoryHandler(input: FetchOngoingInventoryInput, { container }: { container: any }): Promise<StepResponse<OngoingInventoryRow[]>>` — export the handler directly for unit testing (mirrors `loadSyncForShipmentHandler` in `src/workflows/steps/load-sync-for-shipment.ts:22`).
- `fetchOngoingInventoryStep = createStep("fetch-ongoing-inventory", fetchOngoingInventoryHandler)`

**Handler body:**

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { OngoingInventoryRow } from "../../lib/ongoing/types"

export type FetchOngoingInventoryInput = { credential_key: string }

export async function fetchOngoingInventoryHandler(
  input: FetchOngoingInventoryInput,
  { container }: { container: any }
): Promise<StepResponse<OngoingInventoryRow[]>> {
  const service: any = container.resolve(ONGOING_MODULE)
  const rows: OngoingInventoryRow[] = await service.getClient(input.credential_key).getInventory()
  return new StepResponse(rows)
}

export const fetchOngoingInventoryStep = createStep(
  "fetch-ongoing-inventory",
  fetchOngoingInventoryHandler
)
```

- [ ] **Step 1: Write the failing test**

```ts
// src/workflows/steps/__tests__/fetch-ongoing-inventory.test.ts
import { fetchOngoingInventoryHandler } from "../fetch-ongoing-inventory"
import type { OngoingInventoryRow } from "../../../lib/ongoing/types"

const makeRow = (sku: string): OngoingInventoryRow => ({
  articleNumber: sku,
  numberOfItems: 10,
  allocatedNumberOfItems: 2,
  sellableNumberOfItems: 8,
  toReceiveNumberOfItems: 5,
})

const invoke = (rows: OngoingInventoryRow[]) => {
  const getInventory = jest.fn().mockResolvedValue(rows)
  const getClient = jest.fn().mockReturnValue({ getInventory })
  const service = { getClient }
  const container = { resolve: () => service }
  return fetchOngoingInventoryHandler({ credential_key: "wh1" }, { container })
}

describe("fetchOngoingInventoryStep", () => {
  it("calls getClient with the credential_key and returns the rows", async () => {
    const rows = [makeRow("SKU-A"), makeRow("SKU-B")]
    const res = await invoke(rows)
    expect(res.output).toEqual(rows)
  })

  it("returns an empty array when Ongoing has no inventory", async () => {
    const res = await invoke([])
    expect(res.output).toEqual([])
  })
})
```

Run `yarn test -- --testPathPattern="fetch-ongoing-inventory.test"` — must fail (file does not exist yet).

- [ ] **Step 2: Implement `fetch-ongoing-inventory.ts`**

Create the file with the handler and step as shown above.

- [ ] **Step 3: Verify**

Run `yarn test -- --testPathPattern="fetch-ongoing-inventory.test"`. Both tests must pass.

---

## Task 2: `reconcileInventoryLevelsStep`

**Files:**
- Create: `src/workflows/steps/reconcile-inventory-levels.ts`
- Create: `src/workflows/steps/__tests__/reconcile-inventory-levels.test.ts`

This is the core step. It handles all three reconcile modes and every skip scenario in a single handler body. There is no intermediate `StepResponse` between the reservation read and the level write — the entire loop is one unit of execution.

**Exported symbols:**

```ts
export type ReconcileInventoryInput = {
  rows: OngoingInventoryRow[]
  integration_id: string
  stock_location_id: string
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

export type ReconcileInventoryOutput = {
  written: number
  skipped: number
}

export async function reconcileInventoryLevelsHandler(
  input: ReconcileInventoryInput,
  { container }: { container: any }
): Promise<StepResponse<ReconcileInventoryOutput>>

export const reconcileInventoryLevelsStep = createStep(
  "reconcile-inventory-levels",
  reconcileInventoryLevelsHandler
)
```

**Handler implementation sketch** (all logic in one function body):

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { OngoingInventoryRow } from "../../lib/ongoing/types"

// ... type exports ...

export async function reconcileInventoryLevelsHandler(
  input: ReconcileInventoryInput,
  { container }: { container: any }
): Promise<StepResponse<ReconcileInventoryOutput>> {
  const { rows, integration_id, stock_location_id, stock_reconcile_mode } = input
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const inventoryService: any = container.resolve(Modules.INVENTORY)
  const ongoing: any = container.resolve(ONGOING_MODULE)

  // --- Precise mode: pre-fetch synced line-item ids once (not per row) ---
  let syncedLineItemIds: Set<string> = new Set()
  if (stock_reconcile_mode === "precise") {
    const query: any = container.resolve(ContainerRegistrationKeys.QUERY)
    const syncs: Array<{ medusa_order_id: string }> = await ongoing.listOngoingOrderSyncs({
      integration_id,
      sync_state: "sent",
    })
    const syncedOrderIds = syncs.map((s) => s.medusa_order_id).filter(Boolean)
    if (syncedOrderIds.length > 0) {
      const { data: orders } = await query.graph({
        entity: "order",
        fields: ["id", "items.id"],
        filters: { id: syncedOrderIds },
      })
      // DEV VERIFICATION: confirm 'items.id' is the correct Medusa 2.16.0 field path
      // for order line items. Run a live query and check the returned shape.
      // Adjust to 'line_items.id' (or the actual path) if the shape differs.
      for (const order of orders) {
        for (const item of (order.items ?? [])) {
          syncedLineItemIds.add(item.id)
        }
      }
    }
  }

  let written = 0
  let skipped = 0

  for (const row of rows) {
    // --- SKU match ---
    const items: Array<{ id: string; sku: string }> =
      await inventoryService.listInventoryItems({ sku: row.articleNumber })

    if (items.length === 0) {
      logger.warn(
        `[ongoing] inventory-sync: SKU "${row.articleNumber}" matched 0 Medusa inventory items — skipping`
      )
      skipped++
      continue
    }
    if (items.length > 1) {
      logger.warn(
        `[ongoing] inventory-sync: SKU "${row.articleNumber}" matched ${items.length} Medusa inventory items (collision) — skipping`
      )
      skipped++
      continue
    }
    const item = items[0]

    // --- Level lookup ---
    const levels: Array<{
      id: string; inventory_item_id: string; location_id: string;
      stocked_quantity: number; reserved_quantity: number;
      incoming_quantity: number; available_quantity: number
    }> = await inventoryService.listInventoryLevels({
      inventory_item_id: item.id,
      location_id: stock_location_id,
    })
    if (levels.length === 0) {
      logger.warn(
        `[ongoing] inventory-sync: no inventory level for item "${item.id}" at location "${stock_location_id}" — skipping`
      )
      skipped++
      continue
    }
    const level = levels[0]
    const M_res: number = level.reserved_quantity ?? 0

    // --- Compute stocked_quantity per mode ---
    let stocked_quantity: number
    if (stock_reconcile_mode === "sellable_plus_reserved") {
      stocked_quantity = Math.max(
        0,
        row.sellableNumberOfItems + Math.min(M_res, row.allocatedNumberOfItems)
      )
    } else if (stock_reconcile_mode === "precise") {
      const reservations: Array<{ line_item_id?: string | null; quantity: number }> =
        await inventoryService.listReservationItems({
          inventory_item_id: item.id,
          location_id: stock_location_id,
        })
      const M_res_synced = reservations
        .filter((r) => r.line_item_id != null && syncedLineItemIds.has(r.line_item_id as string))
        .reduce((sum, r) => sum + (r.quantity ?? 0), 0)
      stocked_quantity = Math.max(0, row.sellableNumberOfItems + M_res_synced)
    } else {
      // onhand
      stocked_quantity = Math.max(0, row.numberOfItems)
    }

    // --- Write both stocked_quantity and incoming_quantity in one call ---
    await inventoryService.updateInventoryLevels([{
      id: level.id,
      inventory_item_id: item.id,
      location_id: stock_location_id,
      stocked_quantity,
      incoming_quantity: row.toReceiveNumberOfItems,
    }])
    written++
  }

  return new StepResponse({ written, skipped })
}

export const reconcileInventoryLevelsStep = createStep(
  "reconcile-inventory-levels",
  reconcileInventoryLevelsHandler
)
```

- [ ] **Step 1: Write the failing tests**

The test file must cover: formula A computation, mode A min-cap, mode A clamp-to-zero, mode B precise with mocked synced reservations, mode B clamp-to-zero, mode C onhand, mode C clamp-to-zero, incoming_quantity mapping, SKU 0-match skip, SKU >1-match skip (collision), missing-level skip, and mixed written+skipped across multiple rows.

```ts
// src/workflows/steps/__tests__/reconcile-inventory-levels.test.ts
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { reconcileInventoryLevelsHandler } from "../reconcile-inventory-levels"
import type { OngoingInventoryRow } from "../../../lib/ongoing/types"

const makeRow = (overrides: Partial<OngoingInventoryRow> = {}): OngoingInventoryRow => ({
  articleNumber: "SKU-A",
  numberOfItems: 20,
  allocatedNumberOfItems: 3,
  sellableNumberOfItems: 14,
  toReceiveNumberOfItems: 7,
  ...overrides,
})

const makeLevel = (overrides: Partial<{
  id: string; inventory_item_id: string; location_id: string;
  stocked_quantity: number; reserved_quantity: number;
  incoming_quantity: number; available_quantity: number
}> = {}) => ({
  id: "lvl_1",
  inventory_item_id: "inv_1",
  location_id: "loc_1",
  stocked_quantity: 10,
  reserved_quantity: 2,
  incoming_quantity: 0,
  available_quantity: 8,
  ...overrides,
})

const makeContainer = (opts: {
  items?: any[]
  levels?: any[]
  reservations?: any[]
  syncs?: any[]
  orderGraph?: any[]
}) => {
  const {
    items = [{ id: "inv_1", sku: "SKU-A" }],
    levels = [makeLevel()],
    reservations = [],
    syncs = [],
    orderGraph = [],
  } = opts

  const inventoryService = {
    listInventoryItems: jest.fn().mockResolvedValue(items),
    listInventoryLevels: jest.fn().mockResolvedValue(levels),
    listReservationItems: jest.fn().mockResolvedValue(reservations),
    updateInventoryLevels: jest.fn().mockResolvedValue(undefined),
  }
  const ongoingService = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(syncs),
  }
  const query = {
    graph: jest.fn().mockResolvedValue({ data: orderGraph }),
  }
  const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() }

  const serviceMap: Record<string, unknown> = {
    [Modules.INVENTORY]: inventoryService,
    [ContainerRegistrationKeys.QUERY]: query,
    [ContainerRegistrationKeys.LOGGER]: logger,
    ongoing: ongoingService,
  }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key in serviceMap) return serviceMap[key]
      throw new Error(`Unknown container key: ${key}`)
    }),
  }
  return { container, inventoryService, ongoingService, query, logger }
}

const BASE_A = {
  integration_id: "int_1",
  stock_location_id: "loc_1",
  stock_reconcile_mode: "sellable_plus_reserved" as const,
}

describe("reconcileInventoryLevelsStep — mode A (sellable_plus_reserved)", () => {
  it("writes correct stocked_quantity: sellable=14, alloc=3, M_res=2 → 14+min(2,3)=16", async () => {
    const { container, inventoryService } = makeContainer({})
    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([{
      id: "lvl_1",
      inventory_item_id: "inv_1",
      location_id: "loc_1",
      stocked_quantity: 16,
      incoming_quantity: 7,
    }])
    expect(res.output).toEqual({ written: 1, skipped: 0 })
  })

  it("caps add-back at alloc when M_res > alloc: sellable=14, alloc=3, M_res=10 → 14+3=17", async () => {
    const { container, inventoryService } = makeContainer({
      levels: [makeLevel({ reserved_quantity: 10 })],
    })
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 17 }),
    ])
  })

  it("clamps to 0 when sellable is negative: sellable=-5, alloc=0, M_res=0 → max(0,-5)=0", async () => {
    const { container, inventoryService } = makeContainer({
      levels: [makeLevel({ reserved_quantity: 0 })],
    })
    await reconcileInventoryLevelsHandler(
      {
        rows: [makeRow({ sellableNumberOfItems: -5, allocatedNumberOfItems: 0 })],
        ...BASE_A,
      },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 0 }),
    ])
  })

  it("maps incoming_quantity from toReceiveNumberOfItems", async () => {
    const { container, inventoryService } = makeContainer({})
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow({ toReceiveNumberOfItems: 42 })], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ incoming_quantity: 42 }),
    ])
  })
})

describe("reconcileInventoryLevelsStep — mode C (onhand)", () => {
  const BASE_C = {
    integration_id: "int_1",
    stock_location_id: "loc_1",
    stock_reconcile_mode: "onhand" as const,
  }

  it("uses numberOfItems for stocked_quantity: numberOfItems=20 → 20", async () => {
    const { container, inventoryService } = makeContainer({})
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow({ numberOfItems: 20 })], ...BASE_C },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 20 }),
    ])
  })

  it("clamps onhand to 0 when numberOfItems is negative", async () => {
    const { container, inventoryService } = makeContainer({})
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow({ numberOfItems: -3 })], ...BASE_C },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 0 }),
    ])
  })
})

describe("reconcileInventoryLevelsStep — mode B (precise)", () => {
  const BASE_B = {
    integration_id: "int_1",
    stock_location_id: "loc_1",
    stock_reconcile_mode: "precise" as const,
  }

  it("adds only synced-order reservations to sellable: sellable=14, M_res_synced=3 → 17", async () => {
    const { container, inventoryService } = makeContainer({
      syncs: [{ medusa_order_id: "order_1" }],
      orderGraph: [{ id: "order_1", items: [{ id: "li_synced" }] }],
      reservations: [
        { line_item_id: "li_synced", quantity: 3 },
        { line_item_id: "li_unsynced", quantity: 5 },
      ],
    })
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_B },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 17 }),
    ])
  })

  it("clamps precise to 0 when sellable is negative and no synced reservations", async () => {
    const { container, inventoryService } = makeContainer({
      syncs: [],
      reservations: [],
    })
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow({ sellableNumberOfItems: -5 })], ...BASE_B },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 0 }),
    ])
  })

  it("excludes pending-sync reservations (only sent rows counted)", async () => {
    // syncs = [] (no sent rows) → syncedLineItemIds is empty → M_res_synced=0
    // sellable=14 → stocked=14
    const { container, inventoryService } = makeContainer({
      syncs: [],
      reservations: [{ line_item_id: "li_1", quantity: 10 }],
    })
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_B },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ stocked_quantity: 14 }),
    ])
  })
})

describe("reconcileInventoryLevelsStep — skip scenarios", () => {
  it("skips with warn when SKU matches 0 inventory items", async () => {
    const { container, inventoryService, logger } = makeContainer({ items: [] })
    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("SKU-A"))
    expect(res.output).toEqual({ written: 0, skipped: 1 })
  })

  it("skips with warn when SKU matches more than 1 inventory item (collision)", async () => {
    const { container, inventoryService, logger } = makeContainer({
      items: [{ id: "inv_1", sku: "SKU-A" }, { id: "inv_2", sku: "SKU-A" }],
    })
    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("collision"))
    expect(res.output).toEqual({ written: 0, skipped: 1 })
  })

  it("skips with warn when no inventory level exists at the location", async () => {
    const { container, inventoryService, logger } = makeContainer({ levels: [] })
    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no inventory level"))
    expect(res.output).toEqual({ written: 0, skipped: 1 })
  })

  it("correctly mixes written and skipped across multiple rows", async () => {
    const inventoryService = {
      listInventoryItems: jest.fn()
        .mockResolvedValueOnce([{ id: "inv_1", sku: "SKU-A" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "inv_2", sku: "SKU-C" }]),
      listInventoryLevels: jest.fn().mockResolvedValue([makeLevel()]),
      listReservationItems: jest.fn().mockResolvedValue([]),
      updateInventoryLevels: jest.fn().mockResolvedValue(undefined),
    }
    const serviceMap: Record<string, unknown> = {
      [Modules.INVENTORY]: inventoryService,
      [ContainerRegistrationKeys.QUERY]: { graph: jest.fn().mockResolvedValue({ data: [] }) },
      [ContainerRegistrationKeys.LOGGER]: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
      ongoing: { listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) },
    }
    const container = { resolve: jest.fn((key: string) => serviceMap[key]) }

    const res = await reconcileInventoryLevelsHandler(
      {
        rows: [
          makeRow({ articleNumber: "SKU-A" }),
          makeRow({ articleNumber: "SKU-B" }),
          makeRow({ articleNumber: "SKU-C" }),
        ],
        ...BASE_A,
      },
      { container } as any
    )
    expect(res.output).toEqual({ written: 2, skipped: 1 })
  })
})
```

Run `yarn test -- --testPathPattern="reconcile-inventory-levels.test"` — all tests must fail (file does not exist yet).

- [ ] **Step 2: Implement `reconcile-inventory-levels.ts`**

Create `src/workflows/steps/reconcile-inventory-levels.ts` with the full handler body as shown in the implementation sketch above. Import:
- `createStep`, `StepResponse` from `@medusajs/framework/workflows-sdk`
- `ContainerRegistrationKeys`, `Modules` from `@medusajs/framework/utils`
- `ONGOING_MODULE` from `../../modules/ongoing`
- `OngoingInventoryRow` type from `../../lib/ongoing/types`

**DEV VERIFICATION NOTE (inline, not a blocker):** The `precise` mode `query.graph` call uses `fields: ['id', 'items.id']` on entity `'order'`. During implementation, verify this returns line-item ids correctly by checking a live Medusa 2.16.0 instance or the type definitions in `node_modules/@medusajs/types`. If the correct field path is `line_items.id` (or another name), update both this file and the `orderGraph` shape in the tests.

- [ ] **Step 3: Verify**

Run `yarn test -- --testPathPattern="reconcile-inventory-levels.test"`. All tests must pass.

---

## Task 3: `syncOngoingInventoryWorkflow`

**Files:**
- Create: `src/workflows/sync-ongoing-inventory.ts`
- Create: `src/workflows/__tests__/sync-ongoing-inventory.test.ts`

**Exported types and workflow:**

```ts
// src/workflows/sync-ongoing-inventory.ts
import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk"
import { fetchOngoingInventoryStep } from "./steps/fetch-ongoing-inventory"
import { reconcileInventoryLevelsStep } from "./steps/reconcile-inventory-levels"

export type SyncOngoingInventoryInput = {
  integration_id: string
  credential_key: string
  stock_location_id: string
  goods_owner_id: number
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

export const syncOngoingInventoryWorkflow = createWorkflow(
  "sync-ongoing-inventory",
  function (input: SyncOngoingInventoryInput) {
    const rows = fetchOngoingInventoryStep(
      transform({ input }, (data) => ({ credential_key: data.input.credential_key }))
    )

    const result = reconcileInventoryLevelsStep(
      transform({ rows, input }, (data) => ({
        rows: data.rows,
        integration_id: data.input.integration_id,
        stock_location_id: data.input.stock_location_id,
        stock_reconcile_mode: data.input.stock_reconcile_mode,
      }))
    )

    return new WorkflowResponse(result)
  }
)

export default syncOngoingInventoryWorkflow
```

- [ ] **Step 1: Write the failing workflow integration test**

```ts
// src/workflows/__tests__/sync-ongoing-inventory.test.ts
import { createMedusaContainer, Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { syncOngoingInventoryWorkflow } from "../sync-ongoing-inventory"

const makeRow = (sku: string, overrides = {}) => ({
  articleNumber: sku,
  numberOfItems: 20,
  allocatedNumberOfItems: 5,
  sellableNumberOfItems: 10,
  toReceiveNumberOfItems: 3,
  ...overrides,
})

const makeLevel = (overrides = {}) => ({
  id: "lvl_1",
  inventory_item_id: "inv_1",
  location_id: "loc_1",
  stocked_quantity: 5,
  reserved_quantity: 2,
  incoming_quantity: 0,
  available_quantity: 3,
  ...overrides,
})

describe("syncOngoingInventoryWorkflow", () => {
  it("writes stocked_quantity for every matched row in mode A", async () => {
    // `getInventory()` is mocked at the client-object level, where pagination is
    // already resolved internally by `OngoingClient.paginate()` — so it returns the
    // COMPLETE row set in a single call. (The pagination sentinel itself is tested at
    // the HTTP-fetch level in Task 0's client test, not here.) Use 51 rows in one call.
    const allRows = Array.from({ length: 51 }, (_, i) => makeRow(`SKU-${i}`))
    const getInventory = jest.fn().mockResolvedValue(allRows)
    const inventoryService = {
      listInventoryItems: jest.fn().mockResolvedValue([{ id: "inv_1", sku: "SKU-0" }]),
      listInventoryLevels: jest.fn().mockResolvedValue([makeLevel()]),
      listReservationItems: jest.fn().mockResolvedValue([]),
      updateInventoryLevels: jest.fn().mockResolvedValue(undefined),
    }
    const ongoingService = {
      getClient: jest.fn().mockReturnValue({ getInventory }),
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([]),
    }

    const container = createMedusaContainer()
    container.register("ongoing", asValue(ongoingService))
    container.register(Modules.INVENTORY, asValue(inventoryService))
    container.register(ContainerRegistrationKeys.QUERY, asValue({ graph: jest.fn().mockResolvedValue({ data: [] }) }))
    container.register(ContainerRegistrationKeys.LOGGER, asValue({ warn: jest.fn(), info: jest.fn(), debug: jest.fn() }))

    const { result } = await syncOngoingInventoryWorkflow(container).run({
      input: {
        integration_id: "int_1",
        credential_key: "wh1",
        stock_location_id: "loc_1",
        goods_owner_id: 42,
        stock_reconcile_mode: "sellable_plus_reserved",
      },
    })

    // All 51 rows write because listInventoryItems always returns a match.
    expect(result.written).toBe(51)
    expect(result.skipped).toBe(0)
    // Mode A: sellable=10, alloc=5, M_res=2 → 10 + min(2,5) = 12
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ stocked_quantity: 12, incoming_quantity: 3 }),
      ])
    )
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledTimes(51)
    expect(getInventory).toHaveBeenCalledTimes(1)
  })

  it("returns written=0, skipped=1 when no inventory item matches the SKU", async () => {
    const inventoryService = {
      listInventoryItems: jest.fn().mockResolvedValue([]),
      listInventoryLevels: jest.fn().mockResolvedValue([]),
      listReservationItems: jest.fn().mockResolvedValue([]),
      updateInventoryLevels: jest.fn().mockResolvedValue(undefined),
    }
    const ongoingService = {
      getClient: jest.fn().mockReturnValue({
        getInventory: jest.fn().mockResolvedValue([makeRow("GHOST")]),
      }),
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([]),
    }
    const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() }

    const container = createMedusaContainer()
    container.register("ongoing", asValue(ongoingService))
    container.register(Modules.INVENTORY, asValue(inventoryService))
    container.register(ContainerRegistrationKeys.QUERY, asValue({ graph: jest.fn().mockResolvedValue({ data: [] }) }))
    container.register(ContainerRegistrationKeys.LOGGER, asValue(logger))

    const { result } = await syncOngoingInventoryWorkflow(container).run({
      input: {
        integration_id: "int_1",
        credential_key: "wh1",
        stock_location_id: "loc_1",
        goods_owner_id: 42,
        stock_reconcile_mode: "sellable_plus_reserved",
      },
    })

    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("GHOST"))
  })
})
```

Run `yarn test -- --testPathPattern="sync-ongoing-inventory.test"` — must fail (file does not exist yet).

- [ ] **Step 2: Implement `sync-ongoing-inventory.ts`**

Create the workflow file as shown in the type and composition section above.

- [ ] **Step 3: Verify**

Run `yarn test -- --testPathPattern="sync-ongoing-inventory.test"`. Both tests must pass.

---

## Task 4: Barrel export + full verification

**Files:**
- Modify: `src/workflows/index.ts`

- [ ] **Step 1: Append exports to the barrel**

At the end of `src/workflows/index.ts` (currently 23 lines), append:

```ts
export { syncOngoingInventoryWorkflow } from "./sync-ongoing-inventory"
export type { SyncOngoingInventoryInput } from "./sync-ongoing-inventory"
```

- [ ] **Step 2: Run lint**

```bash
yarn lint
```

Fix any lint errors before proceeding.

- [ ] **Step 3: Run build**

```bash
yarn build
```

A passing build confirms no illegal constructs in the `createWorkflow` body and all TypeScript types resolve correctly. Fix any errors before proceeding.

- [ ] **Step 4: Run full test suite**

```bash
yarn test
```

All pre-existing tests must remain green; all new tests must pass.

- [ ] **Step 5: Verify the pagination fix in client.ts**

Confirm that `src/lib/ongoing/client.ts:100` now contains `pageSize=${ONGOING_PAGE_SIZE}` in the inventory URL, matching the `getOrdersByStatus` pattern at line 108 of the same file.

---

## Verification Commands

```bash
# Task 0:
yarn test -- --testPathPattern="client.test"

# Task 1:
yarn test -- --testPathPattern="fetch-ongoing-inventory.test"

# Task 2:
yarn test -- --testPathPattern="reconcile-inventory-levels.test"

# Task 3:
yarn test -- --testPathPattern="sync-ongoing-inventory.test"

# Final gate (all three must pass):
yarn test
yarn lint
yarn build
```

---

## Open Implementation Note

**`precise` mode — `items.id` field path on entity `order`:** The plan uses `fields: ['id', 'items.id']`. During implementation, verify this returns line-item ids in Medusa 2.16.0 by checking `node_modules/@medusajs/types` or running a live query. If the correct path is `line_items.id` (or another variant), update both `reconcile-inventory-levels.ts` and the `orderGraph` fixture shape in the tests. This is a code-verifiable detail; do not block implementation waiting for external confirmation.
