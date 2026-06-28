import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { OngoingApiError } from "../../lib/ongoing/errors"
import type { PostOrderModel } from "../../lib/ongoing/types"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type PushOrderInput = {
  model: PostOrderModel
  ongoing_order_number: string
  credential_key: string
  integration_id: string
  goods_owner_id: number
  medusa_order_id: string
  medusa_fulfillment_id: string
}

export type PushOrderOutput = { ongoingOrderId: number; orderNumber: string }

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
  { container }: { container: any }
): Promise<PushOrderOutput> {
  const service: any = container.resolve(ONGOING_MODULE)

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
    // getClient() is inside the try so a misconfigured credential_key is also
    // recorded as an error row (it never leaves the sync stuck in "pending").
    const client = service.getClient(input.credential_key)
    const res = await client.putOrder(input.model)
    ongoingOrderId = res.ongoingOrderId
  } catch (err) {
    const kind = err instanceof OngoingApiError ? err.kind : undefined
    const errorClass = kind === "retryable" ? "retryable" : "terminal"
    await service.recordSync({
      ongoing_order_number: input.ongoing_order_number,
      integration_id: input.integration_id,
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      sync_state: "error",
      error_class: errorClass,
      last_error: (err as Error).message,
    })
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

  return { ongoingOrderId, orderNumber: input.ongoing_order_number }
}

export const pushOrderRecordSyncStep = createStep(
  "push-order-record-sync",
  async (input: PushOrderInput, context) => {
    const output = await pushOrderRecordSyncHandler(input, context as any)
    return new StepResponse(output)
  }
)
