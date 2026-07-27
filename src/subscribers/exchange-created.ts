import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { pushReturnToOngoing, resolveReturnIdFor } from "../lib/push-return-to-ongoing"

type ExchangeCreatedPayload = { order_id: string; exchange_id: string }

/**
 * pyr: push the RETURN leg of an exchange to Ongoing.
 *
 * An exchange's return does not emit `order.return_requested` — core emits
 * `order.exchange_created` ({ order_id, exchange_id }) instead, so the plain
 * return-created subscriber never sees it. Resolve the exchange's `return_id`,
 * then run the shared resolve/gate/push body. An exchange with no return leg
 * (outbound-only) resolves to no return id and is a no-op. Never throws.
 */
export default async function exchangeCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<ExchangeCreatedPayload>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const exchangeId = data?.exchange_id

  if (!exchangeId) {
    logger.warn(
      `[ongoing] order.exchange_created: event carried no exchange_id, skipping`
    )
    return
  }

  const returnId = await resolveReturnIdFor(
    container,
    "order_exchange",
    exchangeId,
    "order.exchange_created"
  )

  if (!returnId) {
    // Outbound-only exchange, or the return leg is not yet linked — nothing to push.
    return
  }

  await pushReturnToOngoing(container, returnId, "order.exchange_created")
}

export const config: SubscriberConfig = {
  event: "order.exchange_created",
}
