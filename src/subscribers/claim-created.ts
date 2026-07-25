import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { pushReturnToOngoing, resolveReturnIdFor } from "../lib/push-return-to-ongoing"

type ClaimCreatedPayload = { order_id: string; claim_id: string }

/**
 * pyr: push the RETURN leg of a claim to Ongoing.
 *
 * A claim's return does not emit `order.return_requested` — core emits
 * `order.claim_created` ({ order_id, claim_id }) instead, so the plain
 * return-created subscriber never sees it. Resolve the claim's `return_id`, then
 * run the shared resolve/gate/push body. A claim with no return leg (e.g. a
 * refund-only claim) resolves to no return id and is a no-op. Never throws.
 */
export default async function claimCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<ClaimCreatedPayload>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const claimId = data?.claim_id

  if (!claimId) {
    logger.warn(
      `[ongoing] order.claim_created: event carried no claim_id, skipping`
    )
    return
  }

  const returnId = await resolveReturnIdFor(
    container,
    "order_claim",
    claimId,
    "order.claim_created"
  )

  if (!returnId) {
    // Refund-only / replace-only claim with no return leg — nothing to push.
    return
  }

  await pushReturnToOngoing(container, returnId, "order.claim_created")
}

export const config: SubscriberConfig = {
  event: "order.claim_created",
}
