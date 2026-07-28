import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"

const run = jest.fn().mockResolvedValue({ result: undefined })
jest.mock("@medusajs/core-flows", () => ({
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { syncOngoingDeliveryWorkflow } from "../sync-ongoing-delivery"

const makeService = (rows: any[]) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
})

const makeScope = (service: Record<string, unknown>) => {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  container.register("logger", asValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
  container.register(
    "event_bus",
    asValue({
      emit: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
    })
  )
  return container
}

const input = {
  ongoing_order_number: "1001-abc",
  status_code: 500,
  status_text: "Hentet",
  tracking_numbers: ["TRK1"],
}

beforeEach(() => {
  run.mockClear()
  ;(createOrderShipmentWorkflow as unknown as jest.Mock).mockClear()
})

describe("syncOngoingDeliveryWorkflow", () => {
  it("records delivery without re-creating the shipment on the normal 450 -> 500 path", async () => {
    // Already shipped: no shipment backfill, just mark delivered.
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date(), delivered_at: null },
    ])
    const container = makeScope(service)
    const { result } = await syncOngoingDeliveryWorkflow(container).run({ input })

    expect(run).not.toHaveBeenCalled()
    const deliveredWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "delivered")
    expect(deliveredWrite).toMatchObject({
      id: "os_1",
      sync_state: "delivered",
      latest_status_code: 500,
      latest_status_text: "Hentet",
    })
    expect(deliveredWrite.delivered_at).toBeInstanceOf(Date)
    expect(result).toMatchObject({ skip: false, reason: "ok", needs_shipment: false })
    expect(container.resolve("event_bus").emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_delivered",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "os_1",
        ongoing_order_number: "1001-abc",
        status_code: 500,
        status_text: "Hentet",
      },
    })
  })

  it("backfills the shipment then records delivery when 500 arrives without a prior shipment", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null, delivered_at: null },
    ])
    const container = makeScope(service)
    const { result } = await syncOngoingDeliveryWorkflow(container).run({ input })

    // Shipment backfilled via the core create-shipment workflow.
    expect(run).toHaveBeenCalledTimes(1)
    const writes = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls.map((c) => c[0])
    expect(writes.find((d) => d.sync_state === "shipped")).toBeTruthy()
    expect(writes.find((d) => d.sync_state === "delivered")).toBeTruthy()
    expect(result).toMatchObject({ skip: false, reason: "ok", needs_shipment: true })
  })

  it("is idempotent: no writes when the row is already delivered", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date(), delivered_at: new Date() },
    ])
    const { result } = await syncOngoingDeliveryWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "already_delivered" })
  })

  it("no-ops when there is no sync row", async () => {
    const service = makeService([])
    const { result } = await syncOngoingDeliveryWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "no_sync_row" })
  })

  it("records delivery but skips the shipment backfill when there is no fulfillment id", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null, delivered_at: null },
    ])
    const { result } = await syncOngoingDeliveryWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    const deliveredWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "delivered")
    expect(deliveredWrite).toMatchObject({ id: "os_1", sync_state: "delivered" })
    expect(result).toMatchObject({ skip: false, reason: "ok", needs_shipment: false })
  })
})
