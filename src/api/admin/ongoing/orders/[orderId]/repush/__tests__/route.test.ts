import { MedusaError } from "@medusajs/framework/utils"

const workflowRun = jest.fn()
const pushOrderToOngoing = jest.fn(() => ({ run: workflowRun }))

jest.mock("../../../../../../../workflows", () => ({
  __esModule: true,
  pushOrderToOngoing: (...args: unknown[]) => pushOrderToOngoing(...args),
}))

import { POST } from "../route"

const makeReq = (body: unknown, orderId = "order_1") =>
  ({
    params: { orderId },
    body,
    scope: { resolve: jest.fn() },
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

  it("invokes pushOrderToOngoing(req.scope).run with the fulfillment_id and returns the result", async () => {
    workflowRun.mockResolvedValueOnce({
      result: { ongoingOrderId: 555, orderNumber: "1001-ful_1" },
    })
    const req = makeReq({ fulfillment_id: "ful_1" })
    const res = makeRes()

    await POST(req, res)

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
    const res = makeRes()

    await expect(POST(makeReq({ fulfillment_id: "ful_1" }), res)).rejects.toBe(failure)
  })
})
