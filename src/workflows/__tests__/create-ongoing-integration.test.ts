import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"

// Replace the real setup-location sub-workflow with a stub whose .runAsStep
// delegates to a REAL createStep (built with the real workflows-sdk) whose
// invoke handler always throws. This still runs through the real Medusa
// workflow orchestrator (createMedusaContainer() + .run(), same pattern as
// update-ongoing-integration.test.ts and delete-ongoing-integration.test.ts)
// — the orchestrator's real saga/compensation machinery is genuinely
// exercised — without requiring any real query/remote-link/fulfillment
// module, because the stub step replaces the entire sub-workflow.
jest.mock("../setup-location/setup-location", () => {
  const { createStep } = require("@medusajs/framework/workflows-sdk")
  const failingStep = createStep("setup-location-stub", async () => {
    throw new Error("setup failed")
  })
  return {
    __esModule: true,
    setupOngoingLocationWorkflow: {
      runAsStep: (args: any) => failingStep(args.input),
    },
  }
})

import { createOngoingIntegrationWorkflow } from "../create-ongoing-integration"

function buildContainer(service: Record<string, jest.Mock>) {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  return container
}

describe("createOngoingIntegrationWorkflow", () => {
  it("rolls back the row-insert step when the composed location-setup step fails", async () => {
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    const createOngoingIntegrations = jest.fn().mockResolvedValue({
      id: "integ_1",
      credential_key: "wh-1",
      stock_location_id: "sloc_1",
    })
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const container = buildContainer({
      getCredentials,
      createOngoingIntegrations,
      deleteOngoingIntegrations,
    })

    const runPromise = createOngoingIntegrationWorkflow(container).run({
      input: {
        credential_key: "wh-1",
        stock_location_id: "sloc_1",
        enabled: true,
        stock_sync_enabled: true,
        stock_sync_interval: null,
        status_poll_interval: null,
        stock_reconcile_mode: "sellable_plus_reserved",
        edit_sync_rules: null,
        shipped_status_codes: null,
        cancellable_status_codes: null,
      },
    })

    // The orchestrator reconstructs the rejection as a plain object (not a
    // real Error instance — see push-order-to-ongoing.test.ts for the same
    // precedent), so assert on shape via toMatchObject rather than toThrow.
    await expect(runPromise).rejects.toMatchObject({ message: "setup failed" })

    expect(createOngoingIntegrations).toHaveBeenCalled()
    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
  })
})
