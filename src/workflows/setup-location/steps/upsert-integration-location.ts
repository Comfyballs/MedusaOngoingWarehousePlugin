import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../../modules/ongoing"

type Input = {
  integration_id: string
  stock_location_id: string
}

export const upsertIntegrationLocationStep = createStep(
  "ongoing-upsert-integration-location",
  async (input: Input, { container }) => {
    const ongoing = container.resolve(ONGOING_MODULE)

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
    const ongoing = container.resolve(ONGOING_MODULE)
    await ongoing.updateOngoingIntegrations({
      id: compensation.integration_id,
      stock_location_id: compensation.previousLocationId,
    })
  }
)
