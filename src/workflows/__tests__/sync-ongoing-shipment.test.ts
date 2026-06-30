import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"

const run = jest.fn().mockResolvedValue({ result: undefined })
jest.mock("@medusajs/core-flows", () => ({
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { syncOngoingShipmentWorkflow } from "../sync-ongoing-shipment"

const makeService = (rows: any[]) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
})

const makeScope = (service: Record<string, unknown>) => {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  return container
}

const input = {
  ongoing_order_number: "1001-abc",
  status_code: 200,
  status_text: "Shipped",
  tracking_numbers: ["TRK1", "TRK2"],
}

beforeEach(() => {
  run.mockClear()
  ;(createOrderShipmentWorkflow as unknown as jest.Mock).mockClear()
})

describe("syncOngoingShipmentWorkflow", () => {
  it("applies the shipment and marks the row shipped on the happy path", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })

    expect(run).toHaveBeenCalledWith({
      input: {
        order_id: "order_1",
        fulfillment_id: "ful_1",
        items: [],
        labels: [
          { tracking_number: "TRK1", tracking_url: "", label_url: "" },
          { tracking_number: "TRK2", tracking_url: "", label_url: "" },
        ],
        no_notification: false,
      },
    })
    const shippedWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "shipped")
    expect(shippedWrite).toMatchObject({ id: "os_1", sync_state: "shipped", latest_status_code: 200, latest_status_text: "Shipped" })
    expect(result).toMatchObject({ skip: false, reason: "ok" })
  })

  it("no-ops when the row is already shipped", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date() },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "already_shipped" })
  })

  it("no-ops when there is no sync row", async () => {
    const service = makeService([])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "no_sync_row" })
  })

  it("no-ops when the row has no medusa_fulfillment_id", async () => {
    const service = makeService([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null },
    ])
    const { result } = await syncOngoingShipmentWorkflow(makeScope(service)).run({ input })
    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ skip: true, reason: "no_fulfillment_id" })
  })
})
