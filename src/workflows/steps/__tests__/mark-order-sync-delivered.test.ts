import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncDeliveredHandler } from "../mark-order-sync-delivered"

const baseInput = {
  order_sync_id: "os_1",
  status_code: 500,
  status_text: "Hentet",
  medusa_order_id: "order_1",
  ongoing_order_number: "1001-ful1",
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

describe("markOrderSyncDeliveredStep", () => {
  it("sets sync_state delivered, delivered_at, status fields and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container } = makeContainer({ updateOngoingOrderSyncs })
    const res = await markOrderSyncDeliveredHandler(baseInput, { container })
    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("os_1")
    expect(arg.sync_state).toBe("delivered")
    expect(arg.latest_status_code).toBe(500)
    expect(arg.latest_status_text).toBe("Hentet")
    expect(arg.error_class).toBeNull()
    expect(arg.last_error).toBeNull()
    expect(arg.delivered_at).toBeInstanceOf(Date)
    expect(arg.last_synced_at).toBeInstanceOf(Date)
    expect(res.output).toEqual({ order_sync_id: "os_1" })
  })

  it("emits ongoing.sync.order_delivered with the sync row correlation ids and status", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container, emit } = makeContainer({ updateOngoingOrderSyncs })

    await markOrderSyncDeliveredHandler(baseInput, { container })

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_delivered",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "os_1",
        ongoing_order_number: "1001-ful1",
        status_code: 500,
        status_text: "Hentet",
      },
    })
  })

  it("logs and rethrows without emitting when updateOngoingOrderSyncs fails", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockRejectedValue(new Error("db down"))
    const { container, logger, emit } = makeContainer({ updateOngoingOrderSyncs })

    await expect(markOrderSyncDeliveredHandler(baseInput, { container })).rejects.toThrow(
      "db down"
    )

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("mark-order-sync-delivered: failed")
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it("still completes when the order_delivered emit rejects (event-bus outage must not negate a committed write)", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const { container, logger, emit } = makeContainer({ updateOngoingOrderSyncs })
    emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    const res = await markOrderSyncDeliveredHandler(baseInput, { container })

    expect(res.output).toEqual({ order_sync_id: "os_1" })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable")
    )
  })
})
