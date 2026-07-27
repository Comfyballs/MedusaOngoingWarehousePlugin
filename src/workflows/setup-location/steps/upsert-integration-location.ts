import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../../modules/ongoing"
import type OngoingModuleService from "../../../modules/ongoing/service"

type Input = {
  integration_id: string
  stock_location_id: string
  // pud slice (a): ids of the artifacts setup CREATED, recorded so a future
  // guarded cleanup can target exactly ours. created_fulfillment_set_id is null
  // when the set was reused. Optional so existing callers/tests keep working.
  created_fulfillment_set_id?: string | null
  created_service_zone_id?: string | null
  created_shipping_option_ids?: string[] | null
}

export const upsertIntegrationLocationStep = createStep(
  // eslint-disable-next-line @medusajs/step-id-kebab-case -- the rule wants the id to match the exported step's kebab-cased name; we keep the explicit `ongoing-` prefix so this plugin's steps stay greppable in the host app's combined workflow-execution logs. Renaming is safe (these steps use no async/compensation/persisted transaction state), but the prefix is kept intentionally.
  "ongoing-upsert-integration-location",
  async (input: Input, { container }) => {
    const ongoing = container.resolve<OngoingModuleService>(ONGOING_MODULE)

    const existing = await ongoing.retrieveOngoingIntegration(input.integration_id)
    const previous = {
      stock_location_id: existing.stock_location_id,
      created_fulfillment_set_id: existing.created_fulfillment_set_id,
      created_service_zone_id: existing.created_service_zone_id,
      // model.json() types this as Record<string, unknown>; it holds a string[].
      created_shipping_option_ids: existing.created_shipping_option_ids as unknown as
        | string[]
        | null,
    }

    await ongoing.updateOngoingIntegrations({
      id: input.integration_id,
      stock_location_id: input.stock_location_id,
      created_fulfillment_set_id: input.created_fulfillment_set_id ?? null,
      created_service_zone_id: input.created_service_zone_id ?? null,
      // json() column expects Record<string, unknown>; we persist a string[] (see
      // the same cast pattern in steps/update-ongoing-integration.ts).
      created_shipping_option_ids: (input.created_shipping_option_ids ??
        null) as unknown as Record<string, unknown> | null,
    })

    return new StepResponse(
      { integration_id: input.integration_id, stock_location_id: input.stock_location_id },
      { integration_id: input.integration_id, previous }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const ongoing = container.resolve<OngoingModuleService>(ONGOING_MODULE)
    await ongoing.updateOngoingIntegrations({
      id: compensation.integration_id,
      stock_location_id: compensation.previous.stock_location_id,
      created_fulfillment_set_id: compensation.previous.created_fulfillment_set_id,
      created_service_zone_id: compensation.previous.created_service_zone_id,
      created_shipping_option_ids: compensation.previous
        .created_shipping_option_ids as unknown as Record<string, unknown> | null,
    })
  }
)
