import { OngoingApiError } from "../../../lib/ongoing/errors"
import { MedusaError } from "@medusajs/framework/utils"

// Mock the workflows barrel so the provider's `cancelOngoingOrderWorkflow` import is a jest fn.
const run = jest.fn()
const workflowFactory = jest.fn().mockReturnValue({ run })
jest.mock("../../../workflows", () => ({
  cancelOngoingOrderWorkflow: (container: unknown) => workflowFactory(container),
}))

// Import AFTER the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: OngoingFulfillmentProviderService } = require("../service")

const makeService = (serviceOverrides: any = {}) => {
  const ongoingService = {
    getIntegrationByLocation: jest.fn().mockResolvedValue({ id: "oint_1", credential_key: "wh-a" }),
    ...serviceOverrides,
  }
  const container = { resolve: (key: string) => (key === "ongoing" ? ongoingService : undefined) }
  // #20's constructor is (container, options). options can be a minimal valid object.
  const service = new OngoingFulfillmentProviderService(container, {})
  // Ensure the method can reach the injected container via #20's storage field.
  ;(service as any).container_ = container
  return { service, container, ongoingService }
}

describe("OngoingFulfillmentProviderService.cancelFulfillment", () => {
  beforeEach(() => {
    run.mockReset()
    workflowFactory.mockClear()
  })

  it("resolves identifiers from data and runs cancelOngoingOrderWorkflow", async () => {
    run.mockResolvedValue({ result: { shouldCancel: true, reason: "ok", ongoingOrderId: 999 } })
    const { service, container } = makeService()

    const data = {
      ongoing_order_number: "1001-abc",
      ongoing_order_id: 999,
      location_id: "sloc_1",
      credential_key: "wh-a",
    }

    const result = await service.cancelFulfillment(data)

    // Workflow built with the provider's container.
    expect(workflowFactory).toHaveBeenCalledWith(container)
    // Run called with the order-number key derived from data.
    expect(run).toHaveBeenCalledTimes(1)
    const runArg = run.mock.calls[0][0]
    expect(runArg.input.ongoing_order_number).toBe("1001-abc")
    // Returns a benign outcome carrying the cancel result.
    expect(result.canceled).toBe(true)
    expect(result.reason).toBe("ok")
  })

  it("is an idempotent no-op (does not call the workflow) when data has no identifier", async () => {
    const { service } = makeService()

    const result = await service.cancelFulfillment({ location_id: "sloc_1" })

    expect(run).not.toHaveBeenCalled()
    expect(result.canceled).toBe(false)
    expect(result.reason).toBe("no_identifier")
  })

  it("does not throw on a benign already-cancelled workflow result", async () => {
    run.mockResolvedValue({ result: { shouldCancel: false, reason: "already_cancelled" } })
    const { service } = makeService()

    const result = await service.cancelFulfillment({ ongoing_order_number: "1001-abc" })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result.canceled).toBe(false)
    expect(result.reason).toBe("already_cancelled")
  })

  it("throws a NOT_ALLOWED MedusaError when the workflow decides status_not_cancellable (#109)", async () => {
    run.mockResolvedValue({
      result: {
        shouldCancel: false,
        reason: "status_not_cancellable",
        orderSyncId: "osync_1",
      },
    })
    const { service } = makeService()

    const error = await service
      .cancelFulfillment({ ongoing_order_number: "1001-abc" })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MedusaError)
    expect((error as MedusaError).type).toBe(MedusaError.Types.NOT_ALLOWED)
  })

  it.each([
    "already_cancelled",
    "no_sync_row",
    "no_ongoing_order_id",
    "status_unknown_attempt",
  ] as const)(
    "resolves without throwing for the benign no-op reason %s (#109 boundary)",
    async (reason) => {
      run.mockResolvedValue({ result: { shouldCancel: false, reason } })
      const { service } = makeService()

      const result = await service.cancelFulfillment({
        ongoing_order_number: "1001-abc",
      })

      expect(result.canceled).toBe(false)
      expect(result.reason).toBe(reason)
    }
  )

  it("propagates a retryable error so Medusa can surface a retry", async () => {
    run.mockRejectedValue(new OngoingApiError("down", { status: 503, kind: "retryable" }))
    const { service } = makeService()

    await expect(
      service.cancelFulfillment({ ongoing_order_number: "1001-abc" })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
})
