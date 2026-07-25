import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { cancelOngoingOrderWorkflow } from "../workflows/cancel-ongoing-order"

type FulfillmentCanceledPayload = { order_id: string; fulfillment_id: string }

/**
 * ei4: cancel the Ongoing order behind a single canceled fulfillment.
 *
 * Core's cancel-order-fulfillment workflow emits `order.fulfillment_canceled` in
 * app scope, and calls `provider.cancelFulfillment` — but that provider method
 * runs in the fulfillment module's ISOLATED container and cannot run the
 * status-gated `cancelOngoingOrderWorkflow` (it needs `ongoing` + the workflow
 * engine). So the real cancel runs here.
 *
 * This complements the `order.canceled` subscriber (whole-order cancel): a single
 * fulfillment can be canceled without canceling its order, and that path only
 * emits `order.fulfillment_canceled`. The workflow is idempotent and status-gated
 * (a `no_sync_row` result means the fulfillment was never pushed to Ongoing, i.e.
 * not ours), so running it unconditionally here is safe — including the overlap
 * where a whole-order cancel fires both events (the second run no-ops as
 * `already_cancelled`).
 */
export default async function fulfillmentCanceledHandler({
  event: { data },
  container,
}: SubscriberArgs<FulfillmentCanceledPayload>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const fulfillmentId = data?.fulfillment_id
  const orderId = data?.order_id

  if (!fulfillmentId) {
    logger.warn(
      `[ongoing] order.fulfillment_canceled: event carried no fulfillment_id, skipping`
    )
    return
  }

  try {
    const { result } = await cancelOngoingOrderWorkflow(container).run({
      input: {
        medusa_fulfillment_id: fulfillmentId,
        medusa_order_id: orderId,
      },
    })
    logger.info(
      `[ongoing] order.fulfillment_canceled: fulfillment ${fulfillmentId} (order ${orderId}) -> ${
        result?.reason ?? "done"
      }`
    )
  } catch (error) {
    // The workflow surfaces genuine retryable failures; the retry job / next
    // cancel converge. Never throw from a subscriber.
    logger.error(
      `[ongoing] order.fulfillment_canceled: cancelOngoingOrderWorkflow failed for fulfillment ${fulfillmentId} (order ${orderId}): ${
        (error as Error).message
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.fulfillment_canceled",
}
