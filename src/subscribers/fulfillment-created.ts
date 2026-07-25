import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import { pushOrderToOngoing } from "../workflows/push-order-to-ongoing"
import { ONGOING_PROVIDER_ID } from "../providers/ongoing-fulfillment/constants"

// The Ongoing provider's resolvable id is `${identifier}_${config-id}` (see
// @medusajs/fulfillment's provider loader) and the identifier is fixed to
// ONGOING_PROVIDER_ID ("ongoing"), so every Ongoing fulfillment's provider_id
// starts with "ongoing_". This is the gate that keeps the push from firing for
// fulfillments created by other providers (e.g. the core "manual" provider) in a
// consuming app that mixes providers.
const ONGOING_PROVIDER_PREFIX = `${ONGOING_PROVIDER_ID}_`

type FulfillmentCreatedPayload = { order_id: string; fulfillment_id: string }

/**
 * ei4: the Ongoing order push MUST run here, in the APP container, not in the
 * fulfillment provider's `createFulfillment`. A fulfillment provider runs in the
 * fulfillment module's ISOLATED container and cannot resolve the sibling `ongoing`
 * module, `query`, or the workflow engine that `pushOrderToOngoing` needs. Core's
 * create-fulfillment workflow emits `order.fulfillment_created` in app scope, so
 * this subscriber can do what the provider cannot.
 *
 * Persist-then-sync + never-throw: a push failure is recorded as an error
 * `OngoingOrderSync` row by `push-order-record-sync` and swept by the
 * `retry-failed-syncs` job — so we log and return rather than throwing out of the
 * subscriber (a thrown subscriber would be retried by the event bus with no ledger
 * gain and could double-log). This is the async-with-retry replacement for the old
 * synchronous abort-on-failure behavior.
 */
export default async function fulfillmentCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<FulfillmentCreatedPayload>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const fulfillmentId = data?.fulfillment_id

  if (!fulfillmentId) {
    logger.warn(
      `[ongoing] order.fulfillment_created: event carried no fulfillment_id, skipping`
    )
    return
  }

  // Gate on the provider so we never push fulfillments created by other providers.
  // A fulfillment created for a location that has no Ongoing integration would
  // otherwise make `resolveIntegrationContextStep` throw NOT_FOUND on every
  // non-Ongoing fulfillment in the app.
  let providerId: string | undefined
  try {
    const query = container.resolve<Omit<RemoteQueryFunction, symbol>>(
      ContainerRegistrationKeys.QUERY
    )
    const { data: rows } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "provider_id"],
      filters: { id: fulfillmentId },
    })

    if (!rows?.length) {
      // Distinct from "another provider's fulfillment" below — log it, or an
      // unresolvable fulfillment is indistinguishable from a deliberate skip.
      logger.warn(
        `[ongoing] order.fulfillment_created: fulfillment ${fulfillmentId} not found via query.graph, skipping`
      )
      return
    }

    providerId = rows[0].provider_id as string | undefined
  } catch (error) {
    logger.error(
      `[ongoing] order.fulfillment_created: failed to load fulfillment ${fulfillmentId} to check its provider: ${
        (error as Error).message
      }`
    )
    return
  }

  if (!providerId || !providerId.startsWith(ONGOING_PROVIDER_PREFIX)) {
    // Not an Ongoing fulfillment — nothing to push.
    return
  }

  try {
    const { result } = await pushOrderToOngoing(container).run({
      input: { fulfillment_id: fulfillmentId },
    })
    logger.info(
      `[ongoing] order.fulfillment_created: pushed fulfillment ${fulfillmentId} -> Ongoing order ${result.orderNumber} (${result.ongoingOrderId})`
    )
  } catch (error) {
    // The error `OngoingOrderSync` row is already written by push-order-record-sync;
    // retry-failed-syncs will sweep it. Never throw from a subscriber.
    logger.error(
      `[ongoing] order.fulfillment_created: push failed for fulfillment ${fulfillmentId}: ${
        (error as Error).message
      } (recorded as an error sync row; retry job will retry)`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.fulfillment_created",
}
