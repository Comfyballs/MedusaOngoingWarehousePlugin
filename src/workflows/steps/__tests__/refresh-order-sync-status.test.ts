import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refreshOrderSyncStatusHandler } from "../refresh-order-sync-status"
import { ONGOING_MODULE } from "../../../modules/ongoing"

const makeContainer = (opts: { rows?: any[] } = {}) => {
  const ongoing = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.rows ?? []),
    updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
  }
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const serviceMap: Record<string, unknown> = {
    [ONGOING_MODULE]: ongoing,
    [ContainerRegistrationKeys.LOGGER]: logger,
  }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key in serviceMap) return serviceMap[key]
      throw new Error(`Unknown container key: ${key}`)
    }),
  }
  return { container, ongoing, logger }
}

const BASE = {
  ongoing_order_number: "1001-aaa",
  integration_id: "int_1",
  status_code: 210,
  status_text: "Picking",
}

describe("refreshOrderSyncStatusStep", () => {
  it("updates latest_status_code/text on a matching non-terminal row", async () => {
    const { container, ongoing } = makeContainer({
      rows: [{ id: "sync_1", sync_state: "sent" }],
    })
    const res = await refreshOrderSyncStatusHandler(BASE, { container } as any)
    expect(ongoing.listOngoingOrderSyncs).toHaveBeenCalledWith({
      ongoing_order_number: "1001-aaa",
      integration_id: "int_1",
    })
    expect(ongoing.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sync_1",
        latest_status_code: 210,
        latest_status_text: "Picking",
      })
    )
    expect(res.output).toEqual({ refreshed: true })
  })

  it("no-ops when the order number is empty", async () => {
    const { container, ongoing } = makeContainer({})
    const res = await refreshOrderSyncStatusHandler(
      { ...BASE, ongoing_order_number: "" },
      { container } as any
    )
    expect(ongoing.listOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(ongoing.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(res.output).toEqual({ refreshed: false, reason: "no_order_number" })
  })

  it("no-ops when no sync row matches", async () => {
    const { container, ongoing } = makeContainer({ rows: [] })
    const res = await refreshOrderSyncStatusHandler(BASE, { container } as any)
    expect(ongoing.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(res.output).toEqual({ refreshed: false, reason: "no_sync_row" })
  })

  it.each(["delivered", "cancelled"])(
    "no-ops when the row is in terminal state %s",
    async (sync_state) => {
      const { container, ongoing } = makeContainer({
        rows: [{ id: "sync_1", sync_state }],
      })
      const res = await refreshOrderSyncStatusHandler(BASE, { container } as any)
      expect(ongoing.updateOngoingOrderSyncs).not.toHaveBeenCalled()
      expect(res.output).toEqual({ refreshed: false, reason: "terminal_state" })
    }
  )

  it("still refreshes a shipped row — shipped is no longer terminal (pickup 450 -> 500)", async () => {
    const { container, ongoing } = makeContainer({
      rows: [{ id: "sync_1", sync_state: "shipped" }],
    })
    const res = await refreshOrderSyncStatusHandler(BASE, { container } as any)
    expect(ongoing.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sync_1", latest_status_code: 210 })
    )
    expect(res.output).toEqual({ refreshed: true })
  })
})
