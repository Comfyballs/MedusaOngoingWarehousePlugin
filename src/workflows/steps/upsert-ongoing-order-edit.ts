import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import { classifyError } from "../../lib/ongoing/errors"
// Canonical #26 contract: the SHARED, EXPORTED re-query helper #26 owns.
import { reQueryFulfillmentOrder } from "../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"
import { mapOrderToPostOrderModel } from "../../lib/ongoing/order-mapper"
import type { PostOrderModel } from "../../lib/ongoing/types"
import type { GateDecision } from "./gate-order-edit"

export type UpsertResult = {
  ongoing_order_id: number
  ongoing_order_number: string
}

// Error capture lives INSIDE invoke (record-then-rethrow), NOT in a compensation
// function: when a step's invoke throws it returns no StepResponse, so Medusa runs
// its compensation with `undefined` — the classified error is unavailable there, and
// with no later step the compensation never runs at all. Recording in the catch block
// guarantees the OngoingOrderSync error row is written with error_class/last_error
// while still rejecting so the caller (#31/#54) sees failure. This mirrors #26's
// pushOrderRecordSyncStep, which documents the same reasoning.
export const upsertOngoingOrderEditStep = createStep(
  "ongoing-upsert-order-edit",
  async (decision: GateDecision, { container }) => {
    const service = container.resolve(ONGOING_MODULE) as {
      retrieveOngoingIntegration: (id: string) => Promise<{ credential_key: string }>
      getCredentials: (credentialKey: string) => { goodsOwnerId: number }
      getClient: (credentialKey: string) => {
        putOrder: (order: PostOrderModel) => Promise<{ ongoingOrderId: number }>
      }
      updateOngoingOrderSyncs: (data: Record<string, unknown>) => Promise<unknown>
    }
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    try {
      const integration = await service.retrieveOngoingIntegration(decision.integration_id as string)
      // goods_owner_id lives on the credentials (plugin options), not the integration
      // DB row — sourced the same way #26 does. getClient/getCredentials are inside the
      // try so a misconfigured credential_key is also recorded as an error row.
      const goodsOwnerId = service.getCredentials(integration.credential_key).goodsOwnerId
      const client = service.getClient(integration.credential_key)

      // Re-query the full fulfillment order via #26's SHARED exported helper, keyed by
      // the AUTHORITATIVE medusa_fulfillment_id carried from the targeted sync row (the
      // gate selects the row by fulfillment id when present, else by order id, then
      // carries the row's own fulfillment id forward). The result is #26's canonical
      // QueriedFulfillmentOrder: items TOP-LEVEL, order fields NESTED under .order, NO
      // delivery_date.
      const result = await reQueryFulfillmentOrder(query, decision.medusa_fulfillment_id as string)

      // Resolve each line's article_number upstream via #29 (same as #26 does),
      // then build a SINGLE flat MapOrderInput and call the PURE #24 mapper.
      // Keep the SAME order_number from the sync row so PUT /orders upserts.
      const lines = await Promise.all(
        result.items.map(async (item) => ({
          article_number: await resolveArticleNumber(query, item.sku as string),
          quantity: item.quantity,
        }))
      )
      const model = mapOrderToPostOrderModel({
        goods_owner_id: goodsOwnerId,
        order_number: decision.ongoing_order_number as string,
        // The re-query helper carries no delivery_date — source it the same way #26 does.
        delivery_date: new Date().toISOString(),
        currency_code: result.order.currency_code,
        email: result.order.email,
        shipping_address: result.order.shipping_address,
        lines,
      })

      const res = await client.putOrder(model)

      await service.updateOngoingOrderSyncs({
        id: decision.order_sync_id,
        ongoing_order_id: res.ongoingOrderId,
        // putOrder does NOT echo orderNumber — reuse the value carried on the gate
        // decision (the same idempotency key we upserted by).
        ongoing_order_number: decision.ongoing_order_number,
        sync_state: "sent",
        error_class: null,
        last_error: null,
        last_synced_at: new Date(),
      })

      const upsertResult: UpsertResult = {
        ongoing_order_id: res.ongoingOrderId,
        ongoing_order_number: decision.ongoing_order_number as string,
      }
      return new StepResponse(upsertResult)
    } catch (err) {
      // #67: classifyError defaults a non-OngoingApiError (network/unknown) failure to
      // "retryable" so a brief outage is retried, not dead-lettered as terminal.
      const errorClass = classifyError(err)
      await service.updateOngoingOrderSyncs({
        id: decision.order_sync_id,
        sync_state: "error",
        error_class: errorClass,
        last_error: (err as Error).message,
      })
      throw err
    }
  }
)
