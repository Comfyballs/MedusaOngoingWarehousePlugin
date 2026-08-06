import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules, MedusaError } from "@medusajs/framework/utils"
import type {
  MedusaContainer,
  IEventBusModuleService,
  Logger,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import { classifyError } from "../../lib/ongoing/errors"
import type { PostOrderModel } from "../../lib/ongoing/types"
import { ensureArticlesExist, type EnsureArticleInput } from "../../lib/ongoing/ensure-articles"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { OrderPushedPayload, PushFailedPayload } from "../../lib/ongoing/events"

export type PushOrderInput = {
  model: PostOrderModel
  ongoing_order_number: string
  credential_key: string
  integration_id: string
  goods_owner_id: number
  medusa_order_id: string
  medusa_fulfillment_id: string
  // Order SKUs to ensure exist in Ongoing (ProcessArticle) before the order PUT
  // (R7). Optional/defaulted so existing callers and tests stay valid.
  articles?: EnsureArticleInput[]
}

export type PushOrderOutput = { ongoingOrderId: number; orderNumber: string }

// x5n: thrown when the order or its fulfillment is found canceled in the window
// between the push starting and putOrder — see the re-check below. Distinct from a
// real push failure so the catch block records the ledger row as "cancelled"
// (not error/retryable) and does NOT create a live Ongoing order.
class OrderCanceledDuringPushError extends Error {}

// x5n: read canceled_at on both the order and the fulfillment. Push
// (order.fulfillment_created) and cancel (order.canceled / fulfillment.canceled)
// are independent async paths; a cancel that lands after this push started but
// before putOrder would otherwise create a live Ongoing order for something
// Medusa believes is cancelled (decide-ongoing-cancel sees the pending row with
// no ongoing_order_id and declines, and nothing retries). Returns the first
// canceled_at seen, or null when neither side is canceled.
async function readCanceledAt(
  query: RemoteQueryFunction,
  medusaOrderId: string,
  medusaFulfillmentId: string
): Promise<Date | null> {
  const [{ data: orders }, { data: fulfillments }] = await Promise.all([
    query.graph({
      entity: "order",
      fields: ["canceled_at"],
      filters: { id: medusaOrderId },
    }),
    query.graph({
      entity: "fulfillment",
      fields: ["canceled_at"],
      filters: { id: medusaFulfillmentId },
    }),
  ])
  return orders?.[0]?.canceled_at ?? fulfillments?.[0]?.canceled_at ?? null
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper
// does not expose its invoke fn).
//
// Error capture lives INSIDE invoke (record-then-rethrow), not in a compensation
// function: when a step's invoke throws it returns no StepResponse, so Medusa runs
// its compensation with `undefined` — the classified error is unavailable there.
// Recording in the catch block guarantees the OngoingOrderSync error row is written
// with error_class/last_error while still rejecting so the caller (#21) sees failure.
export async function pushOrderRecordSyncHandler(
  input: PushOrderInput,
  { container }: { container: MedusaContainer }
): Promise<PushOrderOutput> {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
  const query = container.resolve<RemoteQueryFunction>(ContainerRegistrationKeys.QUERY)

  // Persist the order number BEFORE the PUT so a retry upserts the same Ongoing order.
  // Clear any error columns from a prior failed attempt so a retry starts clean.
  await service.recordSync({
    ongoing_order_number: input.ongoing_order_number,
    integration_id: input.integration_id,
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    sync_state: "pending",
    error_class: null,
    last_error: null,
  })

  let ongoingOrderId: number
  try {
    // x5n: re-check canceled_at immediately before creating the Ongoing order. If a
    // cancel raced this push, abort WITHOUT a putOrder so no live order is created for
    // an order Medusa believes is cancelled. Thrown as a distinct error so the catch
    // records "cancelled" (not error/retryable). Runs before getClient/ensureArticles
    // so neither touches Ongoing for a canceled order.
    const canceledAt = await readCanceledAt(
      query,
      input.medusa_order_id,
      input.medusa_fulfillment_id
    )
    if (canceledAt) {
      throw new OrderCanceledDuringPushError(
        `order ${input.medusa_order_id} / fulfillment ${input.medusa_fulfillment_id} canceled during push window (canceled_at=${new Date(canceledAt).toISOString()})`
      )
    }
    // getClient() is inside the try so a misconfigured credential_key is also
    // recorded as an error row (it never leaves the sync stuck in "pending").
    const client = service.getClient(input.credential_key, input.goods_owner_id)
    // Step 1 of Ongoing's webshop flow: ensure the order's SKUs exist as articles
    // BEFORE the order PUT (R7). Runs inside the try so an article-sync failure is
    // classified/recorded/retried by the same ledger as a putOrder failure.
    await ensureArticlesExist(client, input.goods_owner_id, input.articles ?? [], logger)
    const res = await client.putOrder(input.model)
    ongoingOrderId = res.ongoingOrderId
  } catch (err) {
    // x5n: a cancel raced this push (found via readCanceledAt). No Ongoing order was
    // created, so mark the ledger row "cancelled" (not error/retryable — there is
    // nothing to retry) and rethrow to abort. decide-ongoing-cancel then sees an
    // already-cancelled row, and Medusa/Ongoing agree. Rethrowing aborts the
    // fulfillment push, which is correct: the order is being cancelled.
    if (err instanceof OrderCanceledDuringPushError) {
      await service.recordSync({
        ongoing_order_number: input.ongoing_order_number,
        integration_id: input.integration_id,
        medusa_order_id: input.medusa_order_id,
        medusa_fulfillment_id: input.medusa_fulfillment_id,
        sync_state: "cancelled",
        error_class: null,
        last_error: null,
      })
      logger.info(
        `[ongoing] push-order-record-sync: aborted push, order/fulfillment canceled during push window medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number}`
      )
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, err.message)
    }
    // #67: classifyError defaults a non-OngoingApiError (network/unknown) failure to
    // "retryable" so a brief outage is retried by #21, not dead-lettered as terminal.
    const errorClass = classifyError(err)
    await service.recordSync({
      ongoing_order_number: input.ongoing_order_number,
      integration_id: input.integration_id,
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      sync_state: "error",
      error_class: errorClass,
      last_error: (err as Error).message,
    })
    logger.error(
      `[ongoing] push-order-record-sync: failed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} integration_id=${input.integration_id} error_class=${errorClass} error=${(err as Error).message}`
    )
    // Best-effort emit: a failing event bus must not mask the real error (which
    // is what the caller and the recorded error row are for).
    try {
      await eventBus.emit({
        name: ONGOING_EVENTS.PUSH_FAILED,
        data: {
          medusa_order_id: input.medusa_order_id,
          medusa_fulfillment_id: input.medusa_fulfillment_id,
          ongoing_order_number: input.ongoing_order_number,
          integration_id: input.integration_id,
          error_class: errorClass,
          error_message: (err as Error).message,
        } satisfies PushFailedPayload,
      })
    } catch (emitErr) {
      logger.error(
        `[ongoing] push-order-record-sync: failed to emit ${ONGOING_EVENTS.PUSH_FAILED} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(emitErr as Error).message}`
      )
    }
    throw err
  }

  await service.recordSync({
    ongoing_order_number: input.ongoing_order_number,
    integration_id: input.integration_id,
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    sync_state: "sent",
    ongoing_order_id: ongoingOrderId,
    error_class: null,
    last_error: null,
  })

  logger.info(
    `[ongoing] push-order-record-sync: pushed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} ongoing_order_id=${ongoingOrderId} integration_id=${input.integration_id}`
  )
  // Best-effort emit: the order has already been recorded as "sent" above — an
  // event-bus outage here must not turn a real successful push into a thrown
  // error (pushOrderToOngoing runs synchronously inside createFulfillment, so a
  // thrown emit would otherwise make Medusa treat a successful fulfillment as
  // failed).
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.ORDER_PUSHED,
      data: {
        medusa_order_id: input.medusa_order_id,
        medusa_fulfillment_id: input.medusa_fulfillment_id,
        ongoing_order_number: input.ongoing_order_number,
        ongoing_order_id: ongoingOrderId,
        integration_id: input.integration_id,
      } satisfies OrderPushedPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] push-order-record-sync: failed to emit ${ONGOING_EVENTS.ORDER_PUSHED} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(emitErr as Error).message}`
    )
  }

  return { ongoingOrderId, orderNumber: input.ongoing_order_number }
}

export const pushOrderRecordSyncStep = createStep(
  "push-order-record-sync",
  async (input: PushOrderInput, context) => {
    const output = await pushOrderRecordSyncHandler(input, context)
    return new StepResponse(output)
  }
)
