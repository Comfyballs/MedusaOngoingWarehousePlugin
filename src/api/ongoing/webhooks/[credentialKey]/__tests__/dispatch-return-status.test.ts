// Mock the workflows barrel. The mock factory must not reference any outer-scope
// variable (jest.mock is hoisted above all declarations and @swc/jest does not
// honor the babel `mock`-prefix exception, so such a reference hits the temporal
// dead zone). We define jest.fn() inline here and grab the mocked export below to
// drive its behavior per-test (mirrors dispatch-shipment.test.ts).
jest.mock("../../../../../workflows", () => ({
  __esModule: true,
  syncOngoingReturnStatusWorkflow: jest.fn(),
}))

import { dispatchReturnStatus } from "../dispatch-return-status"
import { syncOngoingReturnStatusWorkflow } from "../../../../../workflows"

const mockFactory = syncOngoingReturnStatusWorkflow as unknown as jest.Mock
const mockRun = jest.fn()

type Payload = {
  goodsOwnerOrderId?: string
  goodsOwnerId: number
  orderStatus: { number: number; text?: string }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
  parcels?: Array<{ parcelNumber?: string; isReturnParcel?: boolean }>
}

const CREDENTIAL_KEY = "wh-a"
const INTEGRATION_ID = "oint_123"
const GOODS_OWNER_ID = 7

const payloadWithReturn = (): Payload => ({
  goodsOwnerOrderId: "1001-abc",
  goodsOwnerId: GOODS_OWNER_ID,
  orderStatus: { number: 400, text: "Return received" },
  tracking: [
    { waybill: "WB-1", isReturn: false },
    { waybill: "WB-RET", isReturn: true },
  ],
})

const payloadWithoutReturn = (): Payload => ({
  goodsOwnerOrderId: "1001-abc",
  goodsOwnerId: GOODS_OWNER_ID,
  orderStatus: { number: 200 },
  tracking: [{ waybill: "WB-1", isReturn: false }],
})

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

// Minimal container scope: only LOGGER is resolved by dispatchReturnStatus on error.
const makeScope = () =>
  ({
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      return undefined
    }),
  } as unknown as Parameters<typeof dispatchReturnStatus>[0])

const makeVerified = (payload: Payload) => ({
  payload,
  integrationId: INTEGRATION_ID,
  credentialKey: CREDENTIAL_KEY,
})

beforeEach(() => {
  mockRun.mockResolvedValue({ result: { recorded: true } })
  mockFactory.mockReturnValue({ run: mockRun })
})

describe("dispatchReturnStatus -> syncOngoingReturnStatusWorkflow wiring", () => {
  it("invokes the workflow with the derived input when return activity is present", async () => {
    const scope = makeScope()

    await dispatchReturnStatus(scope, makeVerified(payloadWithReturn()))

    expect(mockFactory).toHaveBeenCalledWith(scope)
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-abc",
        status_code: 400,
        status_text: "Return received",
        return_tracking_numbers: ["WB-RET"],
        return_parcel_numbers: [],
        integration_id: INTEGRATION_ID,
      },
    })
  })

  it("does not invoke the workflow when no tracking/parcel entry is return-flagged", async () => {
    const scope = makeScope()

    await dispatchReturnStatus(scope, makeVerified(payloadWithoutReturn()))

    expect(mockFactory).not.toHaveBeenCalled()
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("swallows and logs a workflow error (Ongoing must not see non-2xx)", async () => {
    mockRun.mockRejectedValueOnce(new Error("ongoing 500"))
    const scope = makeScope()

    await expect(
      dispatchReturnStatus(scope, makeVerified(payloadWithReturn()))
    ).resolves.toBeUndefined()

    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
