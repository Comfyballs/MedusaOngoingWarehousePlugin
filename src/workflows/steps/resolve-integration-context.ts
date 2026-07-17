import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type ResolveIntegrationContextInput = { location_id: string }
export type ResolveIntegrationContextOutput = {
  integration_id: string
  credential_key: string
  goods_owner_id: number
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper
// does not expose its invoke fn).
export async function resolveIntegrationContextHandler(
  input: ResolveIntegrationContextInput,
  { container }: { container: MedusaContainer }
): Promise<ResolveIntegrationContextOutput> {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService

  const integration = await service.getIntegrationByLocation(input.location_id)
  if (!integration) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] no enabled integration for stock location "${input.location_id}"`
    )
  }

  const creds = service.getCredentials(integration.credential_key)

  return {
    integration_id: integration.id,
    credential_key: integration.credential_key,
    goods_owner_id: creds.goodsOwnerId,
  }
}

export const resolveIntegrationContextStep = createStep(
  "resolve-integration-context",
  async (input: ResolveIntegrationContextInput, context) => {
    const output = await resolveIntegrationContextHandler(input, context)
    return new StepResponse(output)
  }
)
