import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, RemoteQueryFunction, Logger } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { OngoingInventoryRow } from "../../lib/ongoing/types"

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

type InventoryItem = { id: string; sku: string }
type InventoryLevel = {
  id: string
  inventory_item_id: string
  location_id: string
  stocked_quantity: number
  reserved_quantity: number
  incoming_quantity: number
  available_quantity: number
}
type ReservationItem = { line_item_id?: string | null; quantity: number; inventory_item_id?: string }
type LevelUpdate = {
  id: string
  inventory_item_id: string
  location_id: string
  stocked_quantity: number
  incoming_quantity: number
}

// Narrow local interface for only the inventory-module methods this step calls.
// The real IInventoryService DTOs type `sku`/quantity fields more loosely
// (nullable/BigNumberInput) than what this step actually relies on at runtime
// (Ongoing-sourced SKUs always populate `sku`; quantities are plain numbers in
// this schema) -- mirrors the `OngoingServiceLike` pattern used for the same
// reason in retry-ongoing-syncs.ts / flag-orphaned-order-syncs.ts. Resolving
// `Modules.INVENTORY` still yields the real `IInventoryService`, whose DTOs
// don't structurally satisfy this narrower shape (nullable `sku`,
// `BigNumberInput` quantities) -- see the `as unknown as InventoryServiceLike`
// cast below, the same narrowing pattern already used for `model.json()`
// columns in update-ongoing-integration.ts/create-ongoing-integration-row.ts.
type InventoryServiceLike = {
  listInventoryItems: (selector: { sku: string[] }) => Promise<InventoryItem[]>
  listInventoryLevels: (selector: {
    inventory_item_id: string[]
    location_id: string
  }) => Promise<InventoryLevel[]>
  listReservationItems: (selector: {
    inventory_item_id: string[]
    location_id: string
  }) => Promise<ReservationItem[]>
  updateInventoryLevels: (updates: LevelUpdate[]) => Promise<unknown>
}

// updateInventoryLevels accepts an array; chunk the bulk write so a very large
// catalogue doesn't build one unbounded payload (third-party-sync best practice).
const LEVEL_WRITE_CHUNK = 100

export async function reconcileInventoryLevelsHandler(
  input: ReconcileInventoryInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<ReconcileInventoryOutput>> {
  const { rows, integration_id, stock_location_id, stock_reconcile_mode } = input
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const inventoryService = container.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  if (rows.length === 0) {
    return new StepResponse({ written: 0, skipped: 0 })
  }

  // --- Batch 1: resolve every Ongoing SKU to a Medusa inventory item in ONE
  // query, grouped by sku so a collision (SKU → >1 item) is still detectable. ---
  const skus = Array.from(new Set(rows.map((r) => r.articleNumber)))
  const items: InventoryItem[] = await inventoryService.listInventoryItems({ sku: skus })
  const itemsBySku = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const bucket = itemsBySku.get(item.sku)
    if (bucket) {
      bucket.push(item)
    } else {
      itemsBySku.set(item.sku, [item])
    }
  }

  // --- Batch 2: prefetch every level at this location for the matched items in
  // ONE query → O(1) lookup by inventory_item_id (no per-row listInventoryLevels). ---
  const itemIds = items.map((i) => i.id)
  const levels: InventoryLevel[] =
    itemIds.length > 0
      ? await inventoryService.listInventoryLevels({
          inventory_item_id: itemIds,
          location_id: stock_location_id,
        })
      : []
  const levelByItemId = new Map<string, InventoryLevel>()
  for (const level of levels) {
    levelByItemId.set(level.inventory_item_id, level)
  }

  // --- Batch 3 (precise mode only): prefetch synced line-item ids once, and all
  // reservations at this location for the matched items in ONE query. ---
  const syncedLineItemIds = new Set<string>()
  const reservationsByItemId = new Map<string, ReservationItem[]>()
  if (stock_reconcile_mode === "precise") {
    const query = container.resolve<RemoteQueryFunction>(ContainerRegistrationKeys.QUERY)
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
      for (const order of orders) {
        for (const item of order.items ?? []) {
          syncedLineItemIds.add(item.id)
        }
      }
    }

    const reservations: ReservationItem[] =
      itemIds.length > 0
        ? await inventoryService.listReservationItems({
            inventory_item_id: itemIds,
            location_id: stock_location_id,
          })
        : []
    for (const reservation of reservations) {
      const key = reservation.inventory_item_id
      if (!key) {
        continue
      }
      const bucket = reservationsByItemId.get(key)
      if (bucket) {
        bucket.push(reservation)
      } else {
        reservationsByItemId.set(key, [reservation])
      }
    }
  }

  // --- In-memory reconcile: accumulate all writes, no per-row DB round-trips. ---
  const updates: LevelUpdate[] = []
  let written = 0
  let skipped = 0

  for (const row of rows) {
    const matched = itemsBySku.get(row.articleNumber) ?? []
    if (matched.length === 0) {
      logger.warn(
        `[ongoing] inventory-sync: SKU "${row.articleNumber}" matched 0 Medusa inventory items — skipping`
      )
      skipped++
      continue
    }
    if (matched.length > 1) {
      logger.warn(
        `[ongoing] inventory-sync: SKU "${row.articleNumber}" matched ${matched.length} Medusa inventory items (collision) — skipping`
      )
      skipped++
      continue
    }
    const item = matched[0]

    const level = levelByItemId.get(item.id)
    if (!level) {
      logger.warn(
        `[ongoing] inventory-sync: no inventory level for item "${item.id}" at location "${stock_location_id}" — skipping`
      )
      skipped++
      continue
    }
    const M_res: number = level.reserved_quantity ?? 0

    // --- Compute stocked_quantity per mode ---
    let stocked_quantity: number
    if (stock_reconcile_mode === "sellable_plus_reserved") {
      stocked_quantity = Math.max(
        0,
        row.sellableNumberOfItems + Math.min(M_res, row.allocatedNumberOfItems)
      )
    } else if (stock_reconcile_mode === "precise") {
      const reservations = reservationsByItemId.get(item.id) ?? []
      const M_res_synced = reservations
        .filter((r) => r.line_item_id != null && syncedLineItemIds.has(r.line_item_id as string))
        .reduce((sum, r) => sum + (r.quantity ?? 0), 0)
      stocked_quantity = Math.max(0, row.sellableNumberOfItems + M_res_synced)
    } else {
      // onhand
      stocked_quantity = Math.max(0, row.numberOfItems)
    }

    updates.push({
      id: level.id,
      inventory_item_id: item.id,
      location_id: stock_location_id,
      stocked_quantity,
      incoming_quantity: row.toReceiveNumberOfItems,
    })
    written++
  }

  // --- One bulk updateInventoryLevels per chunk (API accepts an array). ---
  for (let i = 0; i < updates.length; i += LEVEL_WRITE_CHUNK) {
    await inventoryService.updateInventoryLevels(updates.slice(i, i + LEVEL_WRITE_CHUNK))
  }

  return new StepResponse({ written, skipped })
}

export const reconcileInventoryLevelsStep = createStep(
  "reconcile-inventory-levels",
  reconcileInventoryLevelsHandler
)
