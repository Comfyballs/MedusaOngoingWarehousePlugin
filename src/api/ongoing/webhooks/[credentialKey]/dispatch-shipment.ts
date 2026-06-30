import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"

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
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.debug(
    `[ongoing] webhook: verified in-band shipment for order ` +
      `${verified.payload.orderNumber ?? verified.payload.orderId} ` +
      `(integration ${verified.integrationId}); shipment dispatch is wired in #36`
  )
}
