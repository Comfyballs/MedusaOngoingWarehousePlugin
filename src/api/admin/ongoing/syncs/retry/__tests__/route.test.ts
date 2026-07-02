// Mock the workflows barrel BEFORE importing the route (hoisted by @swc/jest,
// same pattern as src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts).
const runMock = jest.fn()
jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  retryOngoingSyncsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { POST } from "../route"
import { retryOngoingSyncsWorkflow as retryOngoingSyncsWorkflowImport } from "../../../../../../workflows"

const retryOngoingSyncsWorkflow =
  retryOngoingSyncsWorkflowImport as jest.MockedFunction<
    typeof retryOngoingSyncsWorkflowImport
  >

const makeReq = (body: unknown) => ({ body, scope: {} }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  runMock.mockReset()
  retryOngoingSyncsWorkflow.mockClear()
})

describe("POST /admin/ongoing/syncs/retry", () => {
  it("runs retryOngoingSyncsWorkflow with sync_ids from the body and returns its result", async () => {
    runMock.mockResolvedValue({ result: { retried: ["oos_1"], skipped: ["oos_2"] } })
    const res = makeRes()

    await POST(makeReq({ sync_ids: ["oos_1", "oos_2"] }), res)

    expect(runMock).toHaveBeenCalledWith({ input: { sync_ids: ["oos_1", "oos_2"] } })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ retried: ["oos_1"], skipped: ["oos_2"] })
  })

  it("throws MedusaError invalid_data when sync_ids is missing", async () => {
    const res = makeRes()

    await expect(POST(makeReq({}), res)).rejects.toMatchObject({ type: "invalid_data" })
    expect(runMock).not.toHaveBeenCalled()
  })

  it("throws MedusaError invalid_data when sync_ids is an empty array", async () => {
    const res = makeRes()

    await expect(POST(makeReq({ sync_ids: [] }), res)).rejects.toMatchObject({
      type: "invalid_data",
    })
    expect(runMock).not.toHaveBeenCalled()
  })

  it("throws MedusaError invalid_data when sync_ids contains a non-string element", async () => {
    const res = makeRes()

    await expect(
      POST(makeReq({ sync_ids: ["ok", 123] }), res)
    ).rejects.toMatchObject({ type: "invalid_data" })
    expect(runMock).not.toHaveBeenCalled()
  })
})
