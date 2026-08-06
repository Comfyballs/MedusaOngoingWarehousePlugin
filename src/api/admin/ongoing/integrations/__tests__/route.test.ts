import { MedusaError } from "@medusajs/framework/utils"

// Hoisted above imports by @swc/jest — the mock fn must be created inside the
// factory (see src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts
// for the same TDZ-avoidance pattern), then re-imported for assertions.
jest.mock("../../../../../workflows", () => ({
  __esModule: true,
  createOngoingIntegrationWorkflow: jest.fn(),
}))

import { GET, POST } from "../route"
import { createOngoingIntegrationWorkflow as createOngoingIntegrationWorkflowImport } from "../../../../../workflows"

const createOngoingIntegrationWorkflow =
  createOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof createOngoingIntegrationWorkflowImport
  >

const makeService = (opts: { listResult?: Record<string, unknown>[] }) => ({
  listOngoingIntegrations: jest.fn().mockResolvedValue(opts.listResult ?? []),
})

const makeReq = (body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

const validBody = () => ({
  credential_key: "wh-1",
  goods_owner_id: 42,
  stock_location_id: "sloc_1",
})

describe("GET /admin/ongoing/integrations", () => {
  it("lists all integrations", async () => {
    const rows = [{ id: "integ_1" }, { id: "integ_2" }]
    const service = makeService({ listResult: rows })
    const res = makeRes()

    await GET(makeReq(undefined, service), res)

    expect(res.json).toHaveBeenCalledWith({ integrations: rows })
  })
})

describe("POST /admin/ongoing/integrations", () => {
  it("throws MedusaError(INVALID_DATA) when credential_key is missing, without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ stock_location_id: "sloc_1" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when stock_location_id is missing", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ credential_key: "wh-1" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("rejects an invalid stock_reconcile_mode without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ ...validBody(), stock_reconcile_mode: "bogus" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("rejects an array value for edit_sync_rules without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ ...validBody(), edit_sync_rules: [1, 2, 3] }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  // bead on2: create now REJECTS wrong-typed enabled/interval fields instead of silently
  // coercing them to defaults, matching the update validator's strictness.
  it.each([
    ["stock_sync_interval", 60000],
    ["status_poll_interval", 60000],
    ["enabled", "yes"],
    ["stock_sync_enabled", 1],
  ])("rejects a wrong-typed %s instead of coercing it (on2)", async (field, badValue) => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ ...validBody(), [field]: badValue }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("still accepts an explicit null interval (on2 strictness only rejects wrong TYPES)", async () => {
    const run = jest.fn().mockResolvedValue({ result: { id: "integ_1" } })
    createOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await POST(makeReq({ ...validBody(), stock_sync_interval: null }, service), res)

    expect(run).toHaveBeenCalledWith({
      input: expect.objectContaining({ stock_sync_interval: null }),
    })
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it("runs the workflow with the validated input and returns 201", async () => {
    const created = { id: "integ_1", credential_key: "wh-1", stock_location_id: "sloc_1" }
    const run = jest.fn().mockResolvedValue({ result: created })
    createOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()
    const req = makeReq(validBody(), service)

    await POST(req, res)

    expect(createOngoingIntegrationWorkflow).toHaveBeenCalledWith(req.scope)
    expect(run).toHaveBeenCalledWith({
      input: expect.objectContaining({
        credential_key: "wh-1",
        goods_owner_id: 42,
        stock_location_id: "sloc_1",
        enabled: true,
        stock_sync_enabled: true,
        stock_reconcile_mode: "sellable_plus_reserved",
      }),
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ integration: created })
  })

  it("propagates a workflow rejection and never sends a response (no orphaned-row success path)", async () => {
    const run = jest.fn().mockRejectedValue(
      new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
    )
    createOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq(validBody(), service), res)).rejects.toThrow(MedusaError)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
