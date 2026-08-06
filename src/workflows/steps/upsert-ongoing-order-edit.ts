import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import { classifyError } from "../../lib/ongoing/errors"
// Canonical #26 contract: the SHARED, EXPORTED re-query helper #26 owns.
import { reQueryFulfillmentOrder } from "../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"
import { mapOrderToPostOrderModel } from "../../lib/ongoing/order-mapper"
import { ensureArticlesExist } from "../../lib/ongoing/ensure-articles"
import type { PostArticleModel, PostOrderModel } from "../../lib/ongoing/types"
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
//
// Exported separately from createStep so unit tests can invoke the handler
// directly — the createStep wrapper does not expose its invoke fn. Like
// pushOrderRecordSyncStep/Handler, the invoke logic lives in a named export; here
// the handler itself constructs the StepResponse (rather than returning raw
// output for a thin createStep closure to wrap) since it already builds one.
export const upsertOngoingOrderEditHandler = async (
  decision: GateDecision,
  { container }: { container: MedusaContainer }
) => {
    const service = container.resolve(ONGOING_MODULE) as {
      retrieveOngoingIntegration: (
        id: string
      ) => Promise<{ credential_key: string; goods_owner_id: number }>
      getClient: (credentialKey: string, goodsOwnerId: number) => {
        putOrder: (order: PostOrderModel) => Promise<{ ongoingOrderId: number }>
        putArticle: (article: PostArticleModel) => Promise<{ articleSystemId?: number }>
      }
      updateOngoingOrderSyncs: (data: Record<string, unknown>) => Promise<unknown>
    }
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    try {
      const integration = await service.retrieveOngoingIntegration(decision.integration_id as string)
      // goods_owner_id lives on the integration DB row (bead 9y2.9), set per warehouse
      // in the admin. getClient stays inside the try so a misconfigured credential_key
      // is also recorded as an error row.
      const goodsOwnerId = integration.goods_owner_id
      const client = service.getClient(integration.credential_key, goodsOwnerId)

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

      // A line-item edit can introduce a new SKU; ensure the (possibly new) order
      // SKUs exist as Ongoing articles before the re-PUT (R7), same as the initial
      // push. Runs inside the try so a failure is recorded/retried by the ledger.
      await ensureArticlesExist(
        client,
        goodsOwnerId,
        lines.map((l, i) => ({
          articleNumber: l.article_number,
          articleName: result.items[i]?.title ?? l.article_number,
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
        // Re-PUT is a full upsert — carry the carrier (R6) so an edit doesn't drop
        // wayOfDelivery/transporter from the Ongoing order.
        way_of_delivery: result.way_of_delivery ?? null,
        transporter: result.transporter ?? null,
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

export const upsertOngoingOrderEditStep = createStep(
  // eslint-disable-next-line @medusajs/step-id-kebab-case -- the rule wants the id to match the exported step's kebab-cased name; we keep the explicit `ongoing-` prefix so this plugin's steps stay greppable in the host app's combined workflow-execution logs. Renaming is safe (these steps use no async/compensation/persisted transaction state), but the prefix is kept intentionally.
  "ongoing-upsert-order-edit",
  upsertOngoingOrderEditHandler
)
