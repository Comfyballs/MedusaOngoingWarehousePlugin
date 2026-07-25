import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import { pushReturnOrderToOngoing } from "../workflows/push-return-order-to-ongoing"
import { ONGOING_PROVIDER_ID } from "../providers/ongoing-fulfillment/constants"

const ONGOING_PROVIDER_PREFIX = `${ONGOING_PROVIDER_ID}_`

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
 * link created by confirm-return-request. So resolve the return fulfillment (and its
 * provider, to gate) via `query.graph` on the `return` entity.
 *
 * The graph field is `fulfillments` (PLURAL, a list) — that is the only alias the
 * `return_fulfillment` link extends `Return` with (@medusajs/link-modules
 * definitions/order-return-fulfillment.js, `fieldAlias.fulfillments`, `isList: true`).
 * There is NO singular `fulfillment` alias, and `query.graph` does not error on an
 * unknown field — it silently omits it, which would make every return look
 * fulfillment-less and skip the push without a trace. Guarded by the L2 spec
 * `return.fulfillments is the graph field ...` in integration-tests/full-app.spec.ts,
 * which asserts the real shape against a booted app (a unit-test mock cannot).
 *
 * KNOWN GAP (bead `pyr`): exchange/claim return legs emit `order.exchange_created` /
 * `order.claim_created` instead of `order.return_requested`, so their return push
 * is not yet wired here. Never-throw + persist-then-sync as elsewhere.
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
        `[ongoing] order.return_requested: return ${returnId} not found via query.graph, skipping`
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
      `[ongoing] order.return_requested: failed to resolve the return fulfillment for return ${returnId}: ${
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
      `[ongoing] order.return_requested: pushed return fulfillment ${returnFulfillmentId} (return ${returnId}) -> Ongoing return order ${result.returnOrderNumber} (${result.ongoingReturnOrderId})`
    )
  } catch (error) {
    // Unlike the outbound push, the return push keeps NO OngoingOrderSync ledger
    // row (pre-existing design — it only emits RETURN_ORDER_PUSH_FAILED), so there
    // is no automatic retry: a failure here is logged + emitted, not swept.
    // Losing the old synchronous abort-on-failure for returns without a retry
    // backstop is a known reduction, tracked as bead `8p8`. Never throw from a
    // subscriber.
    logger.error(
      `[ongoing] order.return_requested: return push failed for return fulfillment ${returnFulfillmentId} (return ${returnId}): ${
        (error as Error).message
      } (emitted return_order_push_failed; no ledger retry for returns)`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.return_requested",
}
