import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"
import { syncOngoingShipmentWorkflow } from "../../../../workflows"
import { mapWebhookPayloadToShipmentInput } from "./map-payload-to-shipment-input"

export type VerifiedShipmentWebhook = {
  payload: WebhookOrderPayload
  integrationId: string
  credentialKey: string
}

// Extension seam owned by #36. A verified, in-band shipment webhook lands here.
// #35 ships it as an acknowledged no-op so the route can return 200; #36 replaces
// the body with the idempotent syncOngoingShipment workflow invocation (guarded by
// OngoingOrderSync.shipped_at). Keep this signature stable for #36.
export async function dispatchVerifiedShipment(
  scope: MedusaContainer,
  verified: VerifiedShipmentWebhook
): Promise<void> {
  // Fill #35's seam: hand the verified "shipped" payload to the idempotent
  // shipment-sync workflow (#33). Swallow workflow errors so the route still
  // returns 200 — Ongoing floods retries on non-2xx, and the workflow's
  // shipped_at guard makes a later retry safe.
  const input = mapWebhookPayloadToShipmentInput(verified.payload)
  try {
    await syncOngoingShipmentWorkflow(scope).run({ input })
  } catch (error) {
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[ongoing] webhook: syncOngoingShipmentWorkflow failed for ${input.ongoing_order_number}: ${
          (error as Error).message
        }`
      )
  }
}
