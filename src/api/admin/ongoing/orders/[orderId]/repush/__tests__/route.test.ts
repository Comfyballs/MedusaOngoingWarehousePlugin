import { MedusaError } from "@medusajs/framework/utils"

const workflowRun = jest.fn()
const pushOrderToOngoing = jest.fn((..._args: unknown[]) => ({ run: workflowRun }))

jest.mock("../../../../../../../workflows", () => ({
  __esModule: true,
  pushOrderToOngoing: (...args: unknown[]) => pushOrderToOngoing(...args),
}))

import { POST } from "../route"

const MODULE_KEY = "ongoing"

const makeOngoingService = (syncs: Array<Record<string, unknown>>) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(syncs),
})

const makeReq = (
  body: unknown,
  opts: {
    orderId?: string
    ongoingService?: ReturnType<typeof makeOngoingService>
  } = {}
) =>
  ({
    params: { orderId: opts.orderId ?? "order_1" },
    body,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === MODULE_KEY) {
          return opts.ongoingService ?? makeOngoingService([{ id: "osync_1" }])
        }
        throw new Error(`unexpected resolve key: ${key}`)
      }),
    },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("POST /admin/ongoing/orders/:orderId/repush", () => {
  it("throws MedusaError(INVALID_DATA) when fulfillment_id is missing", async () => {
    const res = makeRes()
    await expect(POST(makeReq({}), res)).rejects.toThrow(MedusaError)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when fulfillment_id is an empty string", async () => {
    const res = makeRes()
    await expect(POST(makeReq({ fulfillment_id: "   " }), res)).rejects.toThrow(
      MedusaError
    )
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when fulfillment_id is not a string", async () => {
    const res = makeRes()
    await expect(POST(makeReq({ fulfillment_id: 123 }), res)).rejects.toThrow(
      MedusaError
    )
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("throws MedusaError(NOT_FOUND) when fulfillment_id does not belong to a sync row for this order, and never invokes the workflow", async () => {
    const ongoingService = makeOngoingService([])
    const req = makeReq(
      { fulfillment_id: "ful_from_other_order" },
      { orderId: "order_1", ongoingService }
    )
    const res = makeRes()

    await expect(POST(req, res)).rejects.toThrow(MedusaError)
    expect(ongoingService.listOngoingOrderSyncs).toHaveBeenCalledWith({
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_from_other_order",
      sync_kind: "order",
    })
    expect(pushOrderToOngoing).not.toHaveBeenCalled()
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("invokes pushOrderToOngoing(req.scope).run with the fulfillment_id and returns the result when the fulfillment belongs to the order", async () => {
    workflowRun.mockResolvedValueOnce({
      result: { ongoingOrderId: 555, orderNumber: "1001-ful_1" },
    })
    const ongoingService = makeOngoingService([{ id: "osync_1" }])
    const req = makeReq(
      { fulfillment_id: "ful_1" },
      { orderId: "order_1", ongoingService }
    )
    const res = makeRes()

    await POST(req, res)

    expect(ongoingService.listOngoingOrderSyncs).toHaveBeenCalledWith({
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
      sync_kind: "order",
    })
    expect(pushOrderToOngoing).toHaveBeenCalledWith(req.scope)
    expect(workflowRun).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_1" } })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      ongoing_order_id: 555,
      ongoing_order_number: "1001-ful_1",
    })
  })

  it("propagates a workflow failure instead of swallowing it", async () => {
    const failure = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] SKU resolves to more than one variant"
    )
    workflowRun.mockRejectedValueOnce(failure)
    const ongoingService = makeOngoingService([{ id: "osync_1" }])
    const req = makeReq({ fulfillment_id: "ful_1" }, { ongoingService })
    const res = makeRes()

    await expect(POST(req, res)).rejects.toBe(failure)
  })
})
