import { MedusaError } from "@medusajs/framework/utils"

// Mock the #36 seam so the in-band path is observable and side-effect-free.
// The mock fn is created inside the factory (jest.mock is hoisted above imports
// by the @swc/jest transform, so it cannot close over an outer const without a
// TDZ error); we then grab the mocked reference after the import.
jest.mock("../dispatch-shipment", () => ({
  __esModule: true,
  dispatchVerifiedShipment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../dispatch-status-refresh", () => ({
  __esModule: true,
  dispatchStatusRefresh: jest.fn().mockResolvedValue(undefined),
}))

import { POST } from "../route"
import { dispatchVerifiedShipment as dispatchVerifiedShipmentImport } from "../dispatch-shipment"
import { dispatchStatusRefresh as dispatchStatusRefreshImport } from "../dispatch-status-refresh"

const dispatchVerifiedShipment =
  dispatchVerifiedShipmentImport as jest.MockedFunction<
    typeof dispatchVerifiedShipmentImport
  >
const dispatchStatusRefresh =
  dispatchStatusRefreshImport as jest.MockedFunction<
    typeof dispatchStatusRefreshImport
  >

beforeEach(() => {
  dispatchVerifiedShipment.mockClear()
  dispatchStatusRefresh.mockClear()
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
  integrations?: Array<{ id: string; shipped_status_codes: number[] | null }>
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
