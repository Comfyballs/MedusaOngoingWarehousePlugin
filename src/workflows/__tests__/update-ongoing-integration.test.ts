import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { updateOngoingIntegrationWorkflow } from "../update-ongoing-integration"

const previousRow = {
  id: "integ_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: null,
  status_poll_interval: null,
  stock_reconcile_mode: "sellable_plus_reserved" as const,
  edit_sync_rules: null,
  shipped_status_codes: null,
  cancellable_status_codes: null,
}

function buildContainer(service: Record<string, jest.Mock>) {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  return container
}

describe("updateOngoingIntegrationWorkflow", () => {
  it("runs the update step through the real orchestrator and resolves the updated row", async () => {
    const updated = { ...previousRow, enabled: false }
    const retrieveOngoingIntegration = jest.fn().mockResolvedValue(previousRow)
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(updated)
    const container = buildContainer({ retrieveOngoingIntegration, updateOngoingIntegrations })

    const { result } = await updateOngoingIntegrationWorkflow(container).run({
      input: { id: "integ_1", enabled: false },
    })

    expect(result).toEqual(updated)
    expect(updateOngoingIntegrations).toHaveBeenCalledWith({ id: "integ_1", enabled: false })
  })
})
