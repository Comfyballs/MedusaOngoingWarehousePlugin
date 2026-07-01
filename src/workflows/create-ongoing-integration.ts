import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createOngoingIntegrationRowStep,
  type CreateOngoingIntegrationRowInput,
} from "./steps/create-ongoing-integration-row"
import { setupOngoingLocationWorkflow } from "./setup-location/setup-location"

export type CreateOngoingIntegrationInput = CreateOngoingIntegrationRowInput

export const createOngoingIntegrationWorkflow = createWorkflow(
  "create-ongoing-integration",
  function (input: CreateOngoingIntegrationInput) {
    // Step 1: insert the row (compensable — deletes the row on any later failure).
    const integration = createOngoingIntegrationRowStep(input)

    // Step 2: bind the stock location. Composed via .runAsStep() — the same
    // mechanism setupOngoingLocationWorkflow itself uses internally for
    // createServiceZonesWorkflow/createShippingOptionsWorkflow — so if this
    // step (or anything inside it) fails, the outer saga runs Step 1's
    // compensation and the row is deleted. No orphaned integration.
    const setupInput = transform({ integration, input }, (data) => ({
      integration_id: data.integration.id,
      stock_location_id: data.input.stock_location_id,
    }))
    setupOngoingLocationWorkflow.runAsStep({ input: setupInput })

    return new WorkflowResponse(integration)
  }
)

export default createOngoingIntegrationWorkflow
