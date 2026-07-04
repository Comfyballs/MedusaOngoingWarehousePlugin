// Mock the workflows barrel BEFORE importing the route (hoisted by @swc/jest,
// same pattern as src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts).
const runMock = jest.fn()
jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  flagOrphanedOrderSyncsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { POST } from "../route"
import { flagOrphanedOrderSyncsWorkflow as flagOrphanedOrderSyncsWorkflowImport } from "../../../../../../workflows"

const flagOrphanedOrderSyncsWorkflow =
  flagOrphanedOrderSyncsWorkflowImport as jest.MockedFunction<
    typeof flagOrphanedOrderSyncsWorkflowImport
  >

const makeReq = () => ({ scope: {} }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  runMock.mockReset()
  flagOrphanedOrderSyncsWorkflow.mockClear()
})

describe("POST /admin/ongoing/syncs/repair-orphaned", () => {
  it("runs flagOrphanedOrderSyncsWorkflow with no input and returns its result", async () => {
    runMock.mockResolvedValue({ result: { repaired: ["oos_1"] } })
    const res = makeRes()

    await POST(makeReq(), res)

    expect(runMock).toHaveBeenCalledWith({ input: {} })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ repaired: ["oos_1"] })
  })

  it("returns an empty repaired list when there is nothing to flag", async () => {
    runMock.mockResolvedValue({ result: { repaired: [] } })
    const res = makeRes()

    await POST(makeReq(), res)

    expect(res.json).toHaveBeenCalledWith({ repaired: [] })
  })
})
