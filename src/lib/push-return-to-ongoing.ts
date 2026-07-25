import type { MedusaContainer, RemoteQueryFunction } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { pushReturnOrderToOngoing } from "../workflows/push-return-order-to-ongoing"
import { ONGOING_PROVIDER_ID } from "../providers/ongoing-fulfillment/constants"

const ONGOING_PROVIDER_PREFIX = `${ONGOING_PROVIDER_ID}_`

/**
 * ei4: shared "push a Medusa return to Ongoing (PUT /returnOrders)" body used by
 * every event that produces a return leg — `order.return_requested` (plain
 * return), plus `order.exchange_created` / `order.claim_created` (bead `pyr`).
 *
 * Given a return id, resolve its live return fulfillment, gate on the Ongoing
 * provider, and run `pushReturnOrderToOngoing`. Never throws — like every
 * subscriber, it persists/logs and lets the caller return cleanly.
 *
 * The graph field is `fulfillments` (PLURAL, a list) — the only alias the
 * `return_fulfillment` link extends `Return` with (@medusajs/link-modules
 * definitions/order-return-fulfillment.js, `fieldAlias.fulfillments`, `isList: true`).
 * There is NO singular `fulfillment` alias, and `query.graph` does not error on an
 * unknown field — it silently omits it, which would make every return look
 * fulfillment-less and skip the push without a trace. Guarded by the L2 spec
 * `return.fulfillments is the graph field ...` in integration-tests/full-app.spec.ts,
 * which asserts the real shape against a booted app (a unit-test mock cannot).
 */
export async function pushReturnToOngoing(
  container: MedusaContainer,
  returnId: string,
  eventLabel: string
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  let returnFulfillmentId: string | undefined
  let providerId: string | undefined
  try {
    const query = container.resolve<Omit<RemoteQueryFunction, symbol>>(
      ContainerRegistrationKeys.QUERY
    )
    const { data: rows } = await query.graph({
      entity: "return",
      fields: [
        "id",
        "fulfillments.id",
        "fulfillments.provider_id",
        "fulfillments.canceled_at",
      ],
      filters: { id: returnId },
    })

    if (!rows?.length) {
      // Distinct from "no fulfillment yet": the return itself did not resolve.
      logger.warn(
        `[ongoing] ${eventLabel}: return ${returnId} not found via query.graph, skipping`
      )
      return
    }

    const fulfillments = (rows[0].fulfillments ?? []) as Array<{
      id?: string
      provider_id?: string
      canceled_at?: string | Date | null
    }>
    // A return can carry more than one linked fulfillment over its life (a canceled
    // return shipment followed by a new one). Push the live one.
    const fulfillment = fulfillments.find((f) => f?.id && !f.canceled_at)
    returnFulfillmentId = fulfillment?.id
    providerId = fulfillment?.provider_id
  } catch (error) {
    logger.error(
      `[ongoing] ${eventLabel}: failed to resolve the return fulfillment for return ${returnId}: ${
        (error as Error).message
      }`
    )
    return
  }

  if (!returnFulfillmentId) {
    // A return without a fulfillment (e.g. a request not yet confirmed into a
    // fulfillment) — nothing to push.
    return
  }

  if (!providerId || !providerId.startsWith(ONGOING_PROVIDER_PREFIX)) {
    // The return fulfillment belongs to another provider — not ours.
    return
  }

  try {
    const { result } = await pushReturnOrderToOngoing(container).run({
      input: { return_fulfillment_id: returnFulfillmentId },
    })
    logger.info(
      `[ongoing] ${eventLabel}: pushed return fulfillment ${returnFulfillmentId} (return ${returnId}) -> Ongoing return order ${result.returnOrderNumber} (${result.ongoingReturnOrderId})`
    )
  } catch (error) {
    // The return push records an OngoingOrderSync row (sync_kind="return", 8p8), so
    // a failure here has already left an error/retryable ledger row that
    // retry-failed-syncs sweeps with the same backoff/dead-letter semantics as an
    // order push. Log and never throw from a subscriber.
    logger.error(
      `[ongoing] ${eventLabel}: return push failed for return fulfillment ${returnFulfillmentId} (return ${returnId}): ${
        (error as Error).message
      } (recorded error sync row; retry-failed-syncs will re-attempt)`
    )
  }
}

/**
 * Resolve the return id hanging off an exchange or claim (bead `pyr`). Both
 * `order_exchange` and `order_claim` carry a nullable `return_id` FK for their
 * return leg; we read the FK column directly and fall back to the `return.id`
 * relation traversal in case only the relation is populated in a given graph.
 * Returns undefined when there is no return leg (e.g. an exchange with only
 * outbound items), which the caller treats as nothing-to-push.
 */
export async function resolveReturnIdFor(
  container: MedusaContainer,
  entity: "order_exchange" | "order_claim",
  id: string,
  eventLabel: string
): Promise<string | undefined> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const query = container.resolve<Omit<RemoteQueryFunction, symbol>>(
      ContainerRegistrationKeys.QUERY
    )
    const { data: rows } = await query.graph({
      entity,
      fields: ["id", "return_id", "return.id"],
      filters: { id },
    })

    if (!rows?.length) {
      logger.warn(
        `[ongoing] ${eventLabel}: ${entity} ${id} not found via query.graph, skipping`
      )
      return undefined
    }

    const row = rows[0] as { return_id?: string | null; return?: { id?: string } | null }
    return row.return_id ?? row.return?.id ?? undefined
  } catch (error) {
    logger.error(
      `[ongoing] ${eventLabel}: failed to resolve the return for ${entity} ${id}: ${
        (error as Error).message
      }`
    )
    return undefined
  }
}
