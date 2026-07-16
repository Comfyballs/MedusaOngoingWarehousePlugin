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
    // getInventory() is mocked at the client-object level, so it returns the
    // complete row set in a single call (pagination is internal to OngoingClient).
    const allRows = Array.from({ length: 51 }, (_, i) => makeRow(`SKU-${i}`))
    const getInventory = jest.fn().mockResolvedValue(allRows)
    // Batched reconcile prefetches ALL items in one listInventoryItems call and
    // ALL levels in one listInventoryLevels call, keyed by sku / inventory_item_id.
    const allItems = allRows.map((r, i) => ({ id: `inv_${i}`, sku: r.articleNumber }))
    const allLevels = allItems.map((it) =>
      makeLevel({ id: `lvl_${it.id}`, inventory_item_id: it.id })
    )
    const inventoryService = {
      listInventoryItems: jest.fn().mockResolvedValue(allItems),
      listInventoryLevels: jest.fn().mockResolvedValue(allLevels),
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

    // All 51 rows write because each SKU prefetches a matching item + level.
    expect(result.written).toBe(51)
    expect(result.skipped).toBe(0)
    // Mode A: sellable=10, alloc=5, M_res=2 → 10 + min(2,5) = 12
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ stocked_quantity: 12, incoming_quantity: 3 }),
      ])
    )
    // Batched: one prefetch each, and a single bulk write (51 < chunk size 100).
    expect(inventoryService.listInventoryItems).toHaveBeenCalledTimes(1)
    expect(inventoryService.listInventoryLevels).toHaveBeenCalledTimes(1)
    expect(inventoryService.updateInventoryLevels).toHaveBeenCalledTimes(1)
    expect(inventoryService.updateInventoryLevels.mock.calls[0][0]).toHaveLength(51)
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
