import { MedusaError } from "@medusajs/framework/utils"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const run = jest.fn()
jest.mock("@medusajs/core-flows", () => ({
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { applyOrderShipmentHandler } from "../apply-order-shipment"

const makeService = () => ({ updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined) })
const invoke = (input: any, service: any) =>
  applyOrderShipmentHandler(input, { container: { resolve: (_: string) => service } })

const baseInput = {
  order_sync_id: "os_1",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  tracking_numbers: ["TRK1", "TRK2"],
}

beforeEach(() => {
  run.mockReset()
  ;(createOrderShipmentWorkflow as unknown as jest.Mock).mockClear()
})

describe("applyOrderShipmentStep", () => {
  it("invokes createOrderShipmentWorkflow with items:[] , no_notification:false and parcel labels", async () => {
    run.mockResolvedValue({ result: undefined })
    const service = makeService()
    const res = await invoke(baseInput, service)
    expect(run).toHaveBeenCalledTimes(1)
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
    expect(res.output).toEqual({ applied: true, reason: "shipped" })
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("swallows the already-created MedusaError as idempotent success without writing an error row", async () => {
    run.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Shipment has already been created")
    )
    const service = makeService()
    const res = await invoke(baseInput, service)
    expect(res.output).toEqual({ applied: false, reason: "already_shipped" })
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("is safe under an outer-workflow retry: a second call for the same fulfillment hits the already-shipped swallow, not a duplicate side effect (#113)", async () => {
    const service = makeService()

    run.mockResolvedValueOnce({ result: undefined })
    const first = await invoke(baseInput, service)
    expect(first.output).toEqual({ applied: true, reason: "shipped" })

    run.mockRejectedValueOnce(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Shipment has already been created")
    )
    const second = await invoke(baseInput, service)
    expect(second.output).toEqual({ applied: false, reason: "already_shipped" })

    expect(run).toHaveBeenCalledTimes(2)
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("records error_class terminal and rethrows for a non-already-shipped MedusaError", async () => {
    run.mockRejectedValue(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Cannot create shipment for a canceled fulfillment")
    )
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(MedusaError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "os_1",
        sync_state: "error",
        error_class: "terminal",
        last_error: "Cannot create shipment for a canceled fulfillment",
      })
    )
  })

  it("records the OngoingApiError kind and rethrows", async () => {
    run.mockRejectedValue(new OngoingApiError("down", { status: 503, kind: "retryable" }))
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(OngoingApiError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "os_1", sync_state: "error", error_class: "retryable", last_error: "down" })
    )
  })

  it("classifies a raw/unknown error as retryable and rethrows", async () => {
    run.mockRejectedValue(new TypeError("fetch failed"))
    const service = makeService()
    await expect(invoke(baseInput, service)).rejects.toBeInstanceOf(TypeError)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "os_1", sync_state: "error", error_class: "retryable", last_error: "fetch failed" })
    )
  })

  it("passes empty labels when there are no tracking numbers", async () => {
    run.mockResolvedValue({ result: undefined })
    await invoke({ ...baseInput, tracking_numbers: [] }, makeService())
    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_1", fulfillment_id: "ful_1", items: [], labels: [], no_notification: false },
    })
  })
})
