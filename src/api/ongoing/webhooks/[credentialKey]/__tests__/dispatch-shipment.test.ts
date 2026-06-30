// Mock #33's workflow factory. The mock factory must not reference any
// outer-scope variable (jest.mock is hoisted above all declarations and
// @swc/jest does not honor the babel `mock`-prefix exception, so such a
// reference hits the temporal dead zone). We define jest.fn() inline here
// and grab the mocked export below to drive its behavior per-test.
jest.mock("../../../../../workflows", () => ({
  __esModule: true,
  syncOngoingShipmentWorkflow: jest.fn(),
}))

import { dispatchVerifiedShipment } from "../dispatch-shipment"
import { syncOngoingShipmentWorkflow } from "../../../../../workflows"

const mockFactory = syncOngoingShipmentWorkflow as unknown as jest.Mock
const mockRun = jest.fn()

type Payload = {
  goodsOwnerOrderId?: string
  goodsOwnerId: number
  orderStatus: { number: number; text?: string }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
}

const CREDENTIAL_KEY = "wh-a"
const INTEGRATION_ID = "oint_123"
const GOODS_OWNER_ID = 7

const inBandPayload = (): Payload => ({
  goodsOwnerOrderId: "1001-abc",
  goodsOwnerId: GOODS_OWNER_ID,
  orderStatus: { number: 200, text: "Sent" },
  tracking: [
    { waybill: "WB-1", isReturn: false },
    { waybill: "WB-RET", isReturn: true },
    { waybill: "WB-2", isReturn: false },
  ],
})

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

// Minimal container scope: only LOGGER is resolved by dispatchVerifiedShipment.
const makeScope = () =>
  ({
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      return undefined
    }),
  } as unknown as Parameters<typeof dispatchVerifiedShipment>[0])

const makeVerified = (payload: Payload = inBandPayload()) => ({
  payload,
  integrationId: INTEGRATION_ID,
  credentialKey: CREDENTIAL_KEY,
})

// jest.config.js has clearMocks: true (clears call data, keeps implementations);
// wire implementations per-test so each `it` starts from a known state.
beforeEach(() => {
  mockRun.mockResolvedValue({ result: { applied: true } })
  mockFactory.mockReturnValue({ run: mockRun })
})

describe("dispatchVerifiedShipment -> syncOngoingShipmentWorkflow wiring", () => {
  it("invokes the workflow once with the derived input", async () => {
    const scope = makeScope()

    await dispatchVerifiedShipment(scope, makeVerified())

    expect(mockFactory).toHaveBeenCalledWith(scope)
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-abc",
        status_code: 200,
        status_text: "",
        tracking_numbers: ["WB-1", "WB-2"],
      },
    })
  })

  it("swallows and logs a workflow error (Ongoing must not see non-2xx)", async () => {
    mockRun.mockRejectedValueOnce(new Error("ongoing 500"))
    const scope = makeScope()

    await expect(
      dispatchVerifiedShipment(scope, makeVerified())
    ).resolves.toBeUndefined()

    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
