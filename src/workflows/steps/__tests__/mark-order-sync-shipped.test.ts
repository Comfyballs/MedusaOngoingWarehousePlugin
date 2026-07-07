import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncShippedHandler } from "../mark-order-sync-shipped"

const baseInput = {
  order_sync_id: "os_1",
  status_code: 200,
  status_text: "Shipped",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  ongoing_order_number: "1001-ful1",
  tracking_numbers: ["TRK1", "TRK2"],
}

function makeContainer({ updateOngoingOrderSyncs }: { updateOngoingOrderSyncs: jest.Mock }) {
  const service = { updateOngoingOrderSyncs }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const container = {
    resolve: jest.fn((key: string) => {
      switch (key) {
        case "logger":
          return logger
        case "event_bus":
          return { emit }
        default:
          return service
      }
    }),
  } as unknown as MedusaContainer
  return { container, logger, emit }
}

describe("markOrderSyncShippedStep", () => {
  it("sets sync_state shipped, shipped_at, status fields and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container } = makeContainer({ updateOngoingOrderSyncs })
    const res = await markOrderSyncShippedHandler(baseInput, { container })
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

  it("emits ongoing.sync.shipment_applied with correlation ids and tracking numbers", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container, emit } = makeContainer({ updateOngoingOrderSyncs })

    await markOrderSyncShippedHandler(baseInput, { container })

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.shipment_applied",
      data: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_sync_id: "os_1",
        ongoing_order_number: "1001-ful1",
        tracking_numbers: ["TRK1", "TRK2"],
      },
    })
  })

  it("logs and rethrows without emitting when updateOngoingOrderSyncs fails", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockRejectedValue(new Error("db down"))
    const { container, logger, emit } = makeContainer({ updateOngoingOrderSyncs })

    await expect(markOrderSyncShippedHandler(baseInput, { container })).rejects.toThrow(
      "db down"
    )

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("mark-order-sync-shipped: failed")
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it("still completes and returns output when the shipment_applied emit rejects (event-bus outage must not negate a committed write)", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container, logger, emit } = makeContainer({ updateOngoingOrderSyncs })
    emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    const res = await markOrderSyncShippedHandler(baseInput, { container })

    expect(res.output).toEqual({ order_sync_id: "os_1" })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable")
    )
  })
})
