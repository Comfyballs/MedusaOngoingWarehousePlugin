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

  it("batches: one listInventoryItems + one listInventoryLevels + one bulk update for many rows", async () => {
    const { container, inventoryService } = makeContainer({
      items: [
        { id: "inv_1", sku: "SKU-A" },
        { id: "inv_2", sku: "SKU-B" },
      ],
      levels: [
        makeLevel({ id: "lvl_1", inventory_item_id: "inv_1" }),
        makeLevel({ id: "lvl_2", inventory_item_id: "inv_2" }),
      ],
    })
    const res = await reconcileInventoryLevelsHandler(
      {
        rows: [makeRow({ articleNumber: "SKU-A" }), makeRow({ articleNumber: "SKU-B" })],
        ...BASE_A,
      },
      { container } as any
    )
    expect(inventoryService.listInventoryItems).toHaveBeenCalledTimes(1)
    expect(inventoryService.listInventoryItems).toHaveBeenCalledWith({ sku: ["SKU-A", "SKU-B"] })
    expect(inventoryService.listInventoryLevels).toHaveBeenCalledTimes(1)
    expect(inventoryService.listInventoryLevels).toHaveBeenCalledWith({
      inventory_item_id: ["inv_1", "inv_2"],
      location_id: "loc_1",
    })
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledTimes(1)
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
      expect.objectContaining({ id: "lvl_1", inventory_item_id: "inv_1" }),
      expect.objectContaining({ id: "lvl_2", inventory_item_id: "inv_2" }),
    ])
    expect(res.output).toEqual({ written: 2, skipped: 0 })
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
        { inventory_item_id: "inv_1", line_item_id: "li_synced", quantity: 3 },
        { inventory_item_id: "inv_1", line_item_id: "li_unsynced", quantity: 5 },
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

  it("prefetches reservations for the matched items in one call", async () => {
    const { container, inventoryService } = makeContainer({
      syncs: [{ medusa_order_id: "order_1" }],
      orderGraph: [{ id: "order_1", items: [{ id: "li_synced" }] }],
      reservations: [{ inventory_item_id: "inv_1", line_item_id: "li_synced", quantity: 3 }],
    })
    await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_B },
      { container } as any
    )
    expect(inventoryService.listReservationItems).toHaveBeenCalledTimes(1)
    expect(inventoryService.listReservationItems).toHaveBeenCalledWith({
      inventory_item_id: ["inv_1"],
      location_id: "loc_1",
    })
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
      reservations: [{ inventory_item_id: "inv_1", line_item_id: "li_1", quantity: 10 }],
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

  // bead MedusaOngoingWarehousePlugin-bkh: renaming a variant SKU leaves the inventory
  // item on the old SKU forever (Medusa copies SKU onto the inventory item only once,
  // at variant-creation time — no propagation on rename). An unmatched Ongoing SKU that
  // DOES match a product_variant is diagnostic proof of that orphan, and must get a
  // specific, actionable warning instead of the generic "matched 0" message.
  it("reports a rename-orphan warning when an unmatched SKU matches a product variant", async () => {
    const { container, inventoryService, logger, query } = makeContainer({ items: [] })
    query.graph.mockResolvedValueOnce({ data: [{ id: "variant_1", sku: "SKU-A" }] })

    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )

    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(query.graph).toHaveBeenCalledWith({
      entity: "product_variant",
      fields: ["id", "sku"],
      filters: { sku: ["SKU-A"] },
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SKU "SKU-A" matches a Medusa product variant')
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not propagate a variant SKU rename")
    )
    expect(res.output).toEqual({ written: 0, skipped: 1 })
  })

  it("keeps the generic warning when an unmatched SKU matches no variant either", async () => {
    const { container, inventoryService, logger, query } = makeContainer({ items: [] })
    query.graph.mockResolvedValueOnce({ data: [] })

    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )

    expect(inventoryService.updateInventoryLevels).not.toHaveBeenCalled()
    expect(query.graph).toHaveBeenCalledWith({
      entity: "product_variant",
      fields: ["id", "sku"],
      filters: { sku: ["SKU-A"] },
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("matched 0 Medusa inventory items")
    )
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("matches a Medusa product variant")
    )
    expect(res.output).toEqual({ written: 0, skipped: 1 })
  })

  it("does not query variants when every SKU already matched an inventory item", async () => {
    const { container, query } = makeContainer({})
    const res = await reconcileInventoryLevelsHandler(
      { rows: [makeRow()], ...BASE_A },
      { container } as any
    )
    expect(query.graph).not.toHaveBeenCalled()
    expect(res.output).toEqual({ written: 1, skipped: 0 })
  })

  it("correctly mixes written and skipped across multiple rows", async () => {
    const { container, inventoryService } = makeContainer({
      items: [
        { id: "inv_1", sku: "SKU-A" },
        { id: "inv_2", sku: "SKU-C" },
      ],
      levels: [
        makeLevel({ id: "lvl_1", inventory_item_id: "inv_1" }),
        makeLevel({ id: "lvl_2", inventory_item_id: "inv_2" }),
      ],
    })

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
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledTimes(1)
    expect(res.output).toEqual({ written: 2, skipped: 1 })
  })
})
