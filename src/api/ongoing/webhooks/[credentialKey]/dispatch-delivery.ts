import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"
import { syncOngoingDeliveryWorkflow } from "../../../../workflows"
import { mapWebhookPayloadToShipmentInput } from "./map-payload-to-shipment-input"

export type VerifiedDeliveryWebhook = {
  payload: WebhookOrderPayload
  integrationId: string
  credentialKey: string
}

// A verified webhook whose status resolves to the "delivered" stage (Ongoing 500 /
// pickup collection). Hands off to the idempotent delivery workflow, which records
// the pickup (and backfills the shipment if 450 was never observed). The delivery
// input shape is identical to the shipment input, so the same payload mapper feeds
// both seams. Errors are swallowed so the route still acks 200 — Ongoing floods
// retries on non-2xx and the poll job is the reconciliation backstop (same
// always-200 contract as dispatch-shipment.ts).
export async function dispatchVerifiedDelivery(
  scope: MedusaContainer,
  verified: VerifiedDeliveryWebhook
): Promise<void> {
  const input = mapWebhookPayloadToShipmentInput(verified.payload)
  try {
    await syncOngoingDeliveryWorkflow(scope).run({ input })
  } catch (error) {
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[ongoing] webhook: syncOngoingDeliveryWorkflow failed for ${input.ongoing_order_number}: ${
          (error as Error).message
        }`
      )
  }
}
