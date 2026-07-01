import { MedusaError } from "@medusajs/framework/utils"

jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  updateOngoingIntegrationWorkflow: jest.fn(),
  deleteOngoingIntegrationWorkflow: jest.fn(),
}))

import { GET, POST, DELETE } from "../route"
import {
  updateOngoingIntegrationWorkflow as updateOngoingIntegrationWorkflowImport,
  deleteOngoingIntegrationWorkflow as deleteOngoingIntegrationWorkflowImport,
} from "../../../../../../workflows"

const updateOngoingIntegrationWorkflow =
  updateOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof updateOngoingIntegrationWorkflowImport
  >
const deleteOngoingIntegrationWorkflow =
  deleteOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof deleteOngoingIntegrationWorkflowImport
  >

const makeService = (opts: { retrieveResult?: Record<string, unknown> | Error }) => ({
  retrieveOngoingIntegration: jest.fn(() => {
    if (opts.retrieveResult instanceof Error) {
      return Promise.reject(opts.retrieveResult)
    }
    return Promise.resolve(opts.retrieveResult ?? {})
  }),
})

const makeReq = (id: string, body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    params: { id },
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("GET /admin/ongoing/integrations/:id", () => {
  it("returns the integration", async () => {
    const integration = { id: "integ_1", credential_key: "wh-1" }
    const service = makeService({ retrieveResult: integration })
    const res = makeRes()

    await GET(makeReq("integ_1", undefined, service), res)

    expect(service.retrieveOngoingIntegration).toHaveBeenCalledWith("integ_1")
    expect(res.json).toHaveBeenCalledWith({ integration })
  })

  it("propagates MedusaError(NOT_FOUND) for a missing id", async () => {
    const notFound = new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
    const service = makeService({ retrieveResult: notFound })
    const res = makeRes()

    await expect(GET(makeReq("integ_missing", undefined, service), res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    })
  })
})

describe("POST /admin/ongoing/integrations/:id", () => {
  it("throws MedusaError(INVALID_DATA) for a malformed body, without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq("integ_1", { enabled: "yes" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(updateOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("runs the workflow with only the allowed fields", async () => {
    const updated = { id: "integ_1", enabled: false }
    const run = jest.fn().mockResolvedValue({ result: updated })
    updateOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await POST(makeReq("integ_1", { enabled: false, stock_sync_interval: "300000" }, service), res)

    expect(run).toHaveBeenCalledWith({
      input: { id: "integ_1", enabled: false, stock_sync_interval: "300000" },
    })
    expect(res.json).toHaveBeenCalledWith({ integration: updated })
  })

  it("never forwards credential_key or stock_location_id even if present in the body", async () => {
    const run = jest.fn().mockResolvedValue({ result: { id: "integ_1" } })
    updateOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await POST(
      makeReq(
        "integ_1",
        { enabled: true, credential_key: "wh-changed", stock_location_id: "sloc-changed" },
        service
      ),
      res
    )

    const call = run.mock.calls[0][0].input
    expect(call).toEqual({ id: "integ_1", enabled: true })
    expect(call).not.toHaveProperty("credential_key")
    expect(call).not.toHaveProperty("stock_location_id")
  })
})

describe("DELETE /admin/ongoing/integrations/:id", () => {
  it("runs the delete workflow and returns its result", async () => {
    const result = { id: "integ_1", object: "integration", deleted: true }
    const run = jest.fn().mockResolvedValue({ result })
    deleteOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await DELETE(makeReq("integ_1", undefined, service), res)

    expect(run).toHaveBeenCalledWith({ input: { id: "integ_1" } })
    expect(res.json).toHaveBeenCalledWith(result)
  })
})
