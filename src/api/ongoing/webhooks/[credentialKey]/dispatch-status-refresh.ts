import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"
import { refreshOngoingOrderStatusWorkflow } from "../../../../workflows/refresh-ongoing-order-status"

export type OutOfBandStatusWebhook = {
  payload: WebhookOrderPayload
  integrationId: string
  credentialKey: string
}

// Out-of-band (non-shipped) Ongoing order webhooks used to ack as pure no-ops,
// leaving edit/cancel gating to rely on a latest_status_code that could be a full
// poll interval stale. Ongoing fires a webhook on every *selected* status change,
// and the authenticated payload already carries orderStatus.number/text, so we
// refresh the sync row's latest_status_code/latest_status_text here for
// near-real-time gating (R9). Errors are swallowed so the route still returns 200
// — Ongoing floods retries on non-2xx and the poll job is the reconciliation
// backstop (same always-200 contract as dispatch-shipment.ts).
export async function dispatchStatusRefresh(
  scope: MedusaContainer,
  verified: OutOfBandStatusWebhook
): Promise<void> {
  const { payload, integrationId } = verified
  try {
    await refreshOngoingOrderStatusWorkflow(scope).run({
      input: {
        ongoing_order_number: payload.goodsOwnerOrderId ?? "",
        integration_id: integrationId,
        status_code: payload.orderStatus.number,
        status_text: payload.orderStatus.text ?? "",
      },
    })
  } catch (error) {
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[ongoing] webhook: refreshOngoingOrderStatusWorkflow failed for ` +
          `${payload.goodsOwnerOrderId ?? "(no order number)"}: ${(error as Error).message}`
      )
  }
}
