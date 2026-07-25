import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { pushReturnToOngoing } from "../lib/push-return-to-ongoing"

type ReturnRequestedPayload = { order_id: string; return_id: string }

/**
 * ei4: push a Medusa return to Ongoing (PUT /returnOrders).
 *
 * Core's confirm-return-request / create-complete-return workflows create the
 * return fulfillment and emit `order.return_requested` in app scope. The provider
 * `createReturnFulfillment` hook cannot run `pushReturnOrderToOngoing` (module
 * isolation), so the push runs here.
 *
 * The event carries `{ order_id, return_id }`, not the return-fulfillment id — a
 * Return has no `fulfillment_id` column; the tie is the `return_fulfillment` remote
 * link created by confirm-return-request. The resolve/gate/push body is shared
 * across all return-producing events (see `lib/push-return-to-ongoing`); the
 * exchange/claim return legs are wired in exchange-created.ts / claim-created.ts
 * (bead `pyr`).
 */
export default async function returnCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<ReturnRequestedPayload>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const returnId = data?.return_id

  if (!returnId) {
    logger.warn(
      `[ongoing] order.return_requested: event carried no return_id, skipping`
    )
    return
  }

  await pushReturnToOngoing(container, returnId, "order.return_requested")
}

export const config: SubscriberConfig = {
  event: "order.return_requested",
}
