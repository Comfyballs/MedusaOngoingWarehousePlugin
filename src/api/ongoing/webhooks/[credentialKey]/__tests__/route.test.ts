import { MedusaError } from "@medusajs/framework/utils"

// Mock the #36 seam so the in-band path is observable and side-effect-free.
// The mock fn is created inside the factory (jest.mock is hoisted above imports
// by the @swc/jest transform, so it cannot close over an outer const without a
// TDZ error); we then grab the mocked reference after the import.
jest.mock("../dispatch-shipment", () => ({
  __esModule: true,
  dispatchVerifiedShipment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../dispatch-delivery", () => ({
  __esModule: true,
  dispatchVerifiedDelivery: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../dispatch-status-refresh", () => ({
  __esModule: true,
  dispatchStatusRefresh: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../dispatch-return-status", () => ({
  __esModule: true,
  dispatchReturnStatus: jest.fn().mockResolvedValue(undefined),
}))

import { POST } from "../route"
import { dispatchVerifiedShipment as dispatchVerifiedShipmentImport } from "../dispatch-shipment"
import { dispatchVerifiedDelivery as dispatchVerifiedDeliveryImport } from "../dispatch-delivery"
import { dispatchStatusRefresh as dispatchStatusRefreshImport } from "../dispatch-status-refresh"
import { dispatchReturnStatus as dispatchReturnStatusImport } from "../dispatch-return-status"

const dispatchVerifiedShipment =
  dispatchVerifiedShipmentImport as jest.MockedFunction<
    typeof dispatchVerifiedShipmentImport
  >
const dispatchVerifiedDelivery =
  dispatchVerifiedDeliveryImport as jest.MockedFunction<
    typeof dispatchVerifiedDeliveryImport
  >
const dispatchStatusRefresh =
  dispatchStatusRefreshImport as jest.MockedFunction<
    typeof dispatchStatusRefreshImport
  >
const dispatchReturnStatus =
  dispatchReturnStatusImport as jest.MockedFunction<
    typeof dispatchReturnStatusImport
  >

beforeEach(() => {
  dispatchVerifiedShipment.mockClear()
  dispatchVerifiedDelivery.mockClear()
  dispatchStatusRefresh.mockClear()
  dispatchReturnStatus.mockClear()
  logger.info.mockClear()
  logger.warn.mockClear()
  logger.error.mockClear()
  logger.debug.mockClear()
})

const SECRET = "s3cret-token"
const GOODS_OWNER = 42

const validBody = () => ({
  webhookOrdersId: 1,
  webhookEventId: 2,
  orderId: 1001,
  orderNumber: "SO-1001",
  goodsOwnerOrderId: "1001-aaa",
  goodsOwnerId: GOODS_OWNER,
  orderStatus: { number: 320, text: "Shipped" },
  tracking: [{ trackingUrl: "https://t/1", waybill: "WB1", isReturn: false }],
  parcels: [
    {
      id: 5,
      parcelNumber: "P1",
      isReturnParcel: false,
      tracking: { trackingUrl: "https://t/1" },
    },
  ],
  timestamp: "2026-06-30T12:00:00.0000000Z",
})

const makeCreds = (overrides: Record<string, unknown> = {}) => ({
  key: "wh-1",
  baseUrl: "https://api.ongoing",
  username: "u",
  password: "p",
  goodsOwnerId: GOODS_OWNER,
  webhookSecret: SECRET,
  ...overrides,
})

const makeService = (opts: {
  credentials?: ReturnType<typeof makeCreds> | null
  integrations?: Array<{
    id: string
    shipped_status_codes: number[] | null
    delivered_status_codes?: number[] | null
  }>
}) => ({
  getCredentials: jest.fn(() => {
    if (opts.credentials === null || opts.credentials === undefined) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] no credentials configured for credential_key "wh-1"`
      )
    }
    return opts.credentials
  }),
  listOngoingIntegrations: jest
    .fn()
    .mockResolvedValue(opts.integrations ?? []),
})

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

const makeReq = (opts: {
  credentialKey?: string
  token?: string
  body?: unknown
  service: ReturnType<typeof makeService>
}) =>
  ({
    params: { credentialKey: opts.credentialKey ?? "wh-1" },
    headers:
      opts.token === undefined ? {} : { "x-auth-token": opts.token },
    body: opts.body ?? validBody(),
    scope: {
      resolve: jest.fn((key: string) =>
        key === "ongoing" ? opts.service : logger
      ),
    },
  }) as any

const makeRes = () => ({ sendStatus: jest.fn() }) as any

describe("POST /ongoing/webhooks/:credentialKey", () => {
  it("returns 401 for an unknown credentialKey (uniform, no enumeration)", async () => {
    const service = makeService({ credentials: null })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 when no webhookSecret is configured for the integration", async () => {
    const service = makeService({
      credentials: makeCreds({ webhookSecret: undefined }),
    })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 on X-Auth-Token mismatch", async () => {
    const service = makeService({ credentials: makeCreds() })
    const res = makeRes()
    await POST(makeReq({ token: "wrong-token", service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 on goodsOwnerId mismatch (defense in depth)", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = { ...validBody(), goodsOwnerId: 999 }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 400 on an unparseable/malformed body (after auth passes)", async () => {
    const service = makeService({ credentials: makeCreds() })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, body: { foo: "bar" }, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 200 and refreshes latest_status_code when the status is out of band", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = { ...validBody(), orderStatus: { number: 210, text: "Picking" } }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
    expect(dispatchStatusRefresh).toHaveBeenCalledTimes(1)
    expect(dispatchStatusRefresh).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({
        goodsOwnerId: GOODS_OWNER,
        orderStatus: { number: 210, text: "Picking" },
      }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
    // Return-status detection runs regardless of the shipped/out-of-band branch.
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
    expect(dispatchReturnStatus).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({ goodsOwnerId: GOODS_OWNER }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
  })

  it("returns 200 no-op (no refresh) when no integration exists for the credential", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [],
    })
    const res = makeRes()
    const body = { ...validBody(), orderStatus: { number: 210, text: "Picking" } }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
    expect(dispatchStatusRefresh).not.toHaveBeenCalled()
    // No integration bound => the route returns before reaching any dispatcher.
    expect(dispatchReturnStatus).not.toHaveBeenCalled()
  })

  it("returns 200 and reaches the #36 seam for a valid, in-band webhook", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).toHaveBeenCalledTimes(1)
    expect(dispatchStatusRefresh).not.toHaveBeenCalled()
    expect(dispatchVerifiedShipment).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({
        goodsOwnerId: GOODS_OWNER,
        orderStatus: { number: 320, text: "Shipped" },
      }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
    // Return-status detection runs regardless of the shipped/out-of-band branch.
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
  })

  it("acks 200 (not 500) and logs when listOngoingIntegrations throws (bead e1a4c811)", async () => {
    const service = makeService({ credentials: makeCreds() })
    service.listOngoingIntegrations.mockRejectedValueOnce(new Error("db down"))
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    // Retry-friendly ack per the always-200, poll-backstopped contract.
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(res.sendStatus).not.toHaveBeenCalledWith(500)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("post-auth handling failed"))
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
    expect(dispatchReturnStatus).not.toHaveBeenCalled()
  })

  it("warns (not debug) when no integration is bound to the credential (bead tfk)", async () => {
    const service = makeService({ credentials: makeCreds(), integrations: [] })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no integration bound"))
  })

  it("falls back to canonical shipped codes when none are configured (bead 18m)", async () => {
    // Null shipped_status_codes now derives sensible defaults (425/450/451) rather
    // than treating every status as out-of-band. A canonical shipped code ships.
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: null }],
    })
    const res = makeRes()
    const body = { ...validBody(), orderStatus: { number: 450, text: "Sendt" } }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).toHaveBeenCalledTimes(1)
    expect(dispatchVerifiedDelivery).not.toHaveBeenCalled()
    expect(dispatchStatusRefresh).not.toHaveBeenCalled()
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
  })

  it("routes a canonical delivered code (500) to the delivery dispatcher (bead 18m)", async () => {
    // Even with only shipped codes configured, a delivered code (500) resolves to
    // the delivery seam — this is the 450 -> 500 pickup transition that used to be
    // swallowed by the shipped short-circuit.
    const service = makeService({
      credentials: makeCreds(),
      integrations: [
        { id: "int_1", shipped_status_codes: [450], delivered_status_codes: null },
      ],
    })
    const res = makeRes()
    const body = { ...validBody(), orderStatus: { number: 500, text: "Hentet" } }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedDelivery).toHaveBeenCalledTimes(1)
    expect(dispatchVerifiedDelivery).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({
        goodsOwnerId: GOODS_OWNER,
        orderStatus: { number: 500, text: "Hentet" },
      }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
    expect(dispatchStatusRefresh).not.toHaveBeenCalled()
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
  })

  it("reaches the return-status dispatcher for a return-flagged webhook (bead mkg)", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = {
      ...validBody(),
      tracking: [
        { trackingUrl: "https://t/1", waybill: "WB1", isReturn: false },
        { trackingUrl: "https://t/ret", waybill: "WB-RET", isReturn: true },
      ],
    }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
    expect(dispatchReturnStatus).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({
        goodsOwnerId: GOODS_OWNER,
        tracking: expect.arrayContaining([
          expect.objectContaining({ waybill: "WB-RET", isReturn: true }),
        ]),
      }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
    // The outbound shipment dispatch still runs independently (in-band status).
    expect(dispatchVerifiedShipment).toHaveBeenCalledTimes(1)
  })

  it("normalizes a malformed (non-array) tracking field instead of throwing (bead tfk)", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = { ...validBody(), tracking: "oops-not-an-array" }
    await POST(makeReq({ token: SECRET, body, service }), res)
    // Parses (still in-band) and reaches the seam with tracking dropped — no throw.
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).toHaveBeenCalledTimes(1)
    const forwarded = dispatchVerifiedShipment.mock.calls[0][1].payload as unknown as Record<string, unknown>
    expect(forwarded.tracking).toBeUndefined()
    // dispatchReturnStatus is mocked here, so it can't throw on the normalized
    // payload either — asserting it still runs guards against a future regression
    // where it's wired only into one branch.
    expect(dispatchReturnStatus).toHaveBeenCalledTimes(1)
  })

  it("does not reveal which auth check failed (uniform 401 across causes)", async () => {
    const res1 = makeRes()
    await POST(
      makeReq({ token: SECRET, service: makeService({ credentials: null }) }),
      res1
    )
    const res2 = makeRes()
    await POST(
      makeReq({ token: "wrong", service: makeService({ credentials: makeCreds() }) }),
      res2
    )
    expect(res1.sendStatus).toHaveBeenCalledWith(401)
    expect(res2.sendStatus).toHaveBeenCalledWith(401)
  })
})
