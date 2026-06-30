import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
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
      id: string
      inventory_item_id: string
      location_id: string
      stocked_quantity: number
      reserved_quantity: number
      incoming_quantity: number
      available_quantity: number
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
