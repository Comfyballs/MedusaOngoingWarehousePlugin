import { MedusaError } from "@medusajs/framework/utils"
import { POST } from "../route"

const makeService = (opts: {
  getClient?: (key: string) => { getOrderStatuses: () => Promise<unknown> }
}) => ({
  getClient: jest.fn(
    opts.getClient ??
      (() => {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
      })
  ),
})

const makeReq = (body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("POST /admin/ongoing/test-connection", () => {
  it("throws MedusaError(INVALID_DATA) when credential_key is missing", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq({}, service), res)).rejects.toThrow(MedusaError)
    expect(service.getClient).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it("propagates MedusaError(INVALID_DATA) for an unknown credential_key", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq({ credential_key: "wh-nope" }, service), res)).rejects.toMatchObject(
      { type: MedusaError.Types.INVALID_DATA }
    )
  })

  it("returns success + statuses when the Ongoing API is reachable", async () => {
    const statuses = [{ number: 100, text: "Registered" }, { number: 320, text: "Shipped" }]
    const service = makeService({
      getClient: () => ({ getOrderStatuses: () => Promise.resolve(statuses) }),
    })
    const res = makeRes()

    await POST(makeReq({ credential_key: "wh-1" }, service), res)

    expect(service.getClient).toHaveBeenCalledWith("wh-1")
    expect(res.json).toHaveBeenCalledWith({ success: true, statuses })
  })

  it("returns success:false + error when the Ongoing API call fails", async () => {
    const service = makeService({
      getClient: () => ({ getOrderStatuses: () => Promise.reject(new Error("ECONNREFUSED")) }),
    })
    const res = makeRes()

    await POST(makeReq({ credential_key: "wh-1" }, service), res)

    expect(res.json).toHaveBeenCalledWith({ success: false, error: "ECONNREFUSED" })
  })
})
