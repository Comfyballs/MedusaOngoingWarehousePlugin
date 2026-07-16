import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../../modules/ongoing"
import type OngoingModuleService from "../../../modules/ongoing/service"

type Input = {
  integration_id: string
  stock_location_id: string
}

export const upsertIntegrationLocationStep = createStep(
  // eslint-disable-next-line @medusajs/step-id-kebab-case -- the rule wants the id to match the exported step's kebab-cased name; we keep the explicit `ongoing-` prefix so this plugin's steps stay greppable in the host app's combined workflow-execution logs. Renaming is safe (these steps use no async/compensation/persisted transaction state), but the prefix is kept intentionally.
  "ongoing-upsert-integration-location",
  async (input: Input, { container }) => {
    const ongoing = container.resolve<OngoingModuleService>(ONGOING_MODULE)

    const existing = await ongoing.retrieveOngoingIntegration(input.integration_id)
    const previousLocationId = existing.stock_location_id

    await ongoing.updateOngoingIntegrations({
      id: input.integration_id,
      stock_location_id: input.stock_location_id,
    })

    return new StepResponse(
      { integration_id: input.integration_id, stock_location_id: input.stock_location_id },
      { integration_id: input.integration_id, previousLocationId }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const ongoing = container.resolve<OngoingModuleService>(ONGOING_MODULE)
    await ongoing.updateOngoingIntegrations({
      id: compensation.integration_id,
      stock_location_id: compensation.previousLocationId,
    })
  }
)
