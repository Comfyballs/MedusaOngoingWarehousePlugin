import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { recordReturnStatusHandler } from "../record-return-status"
import { ONGOING_MODULE } from "../../../modules/ongoing"
import { ONGOING_EVENTS } from "../../../lib/ongoing/events"

const makeContainer = (opts: { rows?: any[] } = {}) => {
  const ongoing = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.rows ?? []),
  }
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const eventBus = { emit: jest.fn().mockResolvedValue(undefined) }
  const serviceMap: Record<string, unknown> = {
    [ONGOING_MODULE]: ongoing,
    [ContainerRegistrationKeys.LOGGER]: logger,
    [Modules.EVENT_BUS]: eventBus,
  }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key in serviceMap) return serviceMap[key]
      throw new Error(`Unknown container key: ${key}`)
    }),
  }
  return { container, ongoing, logger, eventBus }
}

const BASE = {
  ongoing_order_number: "1001-aaa",
  integration_id: "oint_1",
  status_code: 400,
  status_text: "Return received",
  return_tracking_numbers: ["WB-RET-1"],
  return_parcel_numbers: [],
}

describe("recordReturnStatusStep", () => {
  it("emits RETURN_STATUS_RECEIVED and logs when a sync row matches", async () => {
    const { container, ongoing, eventBus } = makeContainer({
      rows: [{ id: "sync_1", medusa_order_id: "order_1" }],
    })

    const res = await recordReturnStatusHandler(BASE, { container } as any)

    expect(ongoing.listOngoingOrderSyncs).toHaveBeenCalledWith({
      ongoing_order_number: "1001-aaa",
      integration_id: "oint_1",
    })
    expect(eventBus.emit).toHaveBeenCalledWith({
      name: ONGOING_EVENTS.RETURN_STATUS_RECEIVED,
      data: {
        medusa_order_id: "order_1",
        ongoing_order_number: "1001-aaa",
        ongoing_order_sync_id: "sync_1",
        integration_id: "oint_1",
        status_code: 400,
        status_text: "Return received",
        return_tracking_numbers: ["WB-RET-1"],
        return_parcel_numbers: [],
      },
    })
    expect(res.output).toEqual({ recorded: true })
  })

  it("no-ops without emitting when the order number is empty", async () => {
    const { container, ongoing, eventBus } = makeContainer({})

    const res = await recordReturnStatusHandler(
      { ...BASE, ongoing_order_number: "" },
      { container } as any
    )

    expect(ongoing.listOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(res.output).toEqual({ recorded: false, reason: "no_order_number" })
  })

  it("no-ops without emitting when no sync row matches", async () => {
    const { container, eventBus } = makeContainer({ rows: [] })

    const res = await recordReturnStatusHandler(BASE, { container } as any)

    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(res.output).toEqual({ recorded: false, reason: "no_sync_row" })
  })

  it("does not throw when the event-bus emit fails (best-effort emit)", async () => {
    const { container, eventBus } = makeContainer({
      rows: [{ id: "sync_1", medusa_order_id: "order_1" }],
    })
    eventBus.emit.mockRejectedValueOnce(new Error("bus down"))

    const res = await recordReturnStatusHandler(BASE, { container } as any)

    expect(res.output).toEqual({ recorded: true })
  })
})
