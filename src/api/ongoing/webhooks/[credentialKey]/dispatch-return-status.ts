import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"
import { syncOngoingReturnStatusWorkflow } from "../../../../workflows"
import { mapWebhookPayloadToReturnStatusInput } from "./map-payload-to-return-status-input"

export type ReturnStatusWebhook = {
  payload: WebhookOrderPayload
  integrationId: string
  credentialKey: string
}

/**
 * Detects return-flagged (isReturn / isReturnParcel) tracking/parcel entries on a
 * verified Ongoing order-status webhook and, when present, records the activity via
 * syncOngoingReturnStatusWorkflow — replacing the previous behavior of the shipment
 * mapper silently filtering these entries out with no other trail.
 *
 * Runs independently of route.ts's shipped/out-of-band status-code branch: a return
 * parcel can appear on a webhook delivered for any order status, not just the ones
 * configured as "shipped". Swallows workflow errors so the route still returns 200
 * (Ongoing floods retries on non-2xx — same always-200 contract as
 * dispatch-shipment.ts / dispatch-status-refresh.ts).
 */
export async function dispatchReturnStatus(
  scope: MedusaContainer,
  verified: ReturnStatusWebhook
): Promise<void> {
  const mapped = mapWebhookPayloadToReturnStatusInput(verified.payload)
  if (!mapped.hasReturnActivity) {
    return
  }

  const input = {
    ongoing_order_number: mapped.input.ongoing_order_number,
    status_code: mapped.input.status_code,
    status_text: mapped.input.status_text,
    return_tracking_numbers: mapped.input.return_tracking_numbers,
    return_parcel_numbers: mapped.input.return_parcel_numbers,
    integration_id: verified.integrationId,
  }

  try {
    await syncOngoingReturnStatusWorkflow(scope).run({ input })
  } catch (error) {
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[ongoing] webhook: syncOngoingReturnStatusWorkflow failed for ${input.ongoing_order_number}: ${
          (error as Error).message
        }`
      )
  }
}
