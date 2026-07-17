import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type FlagOrphanedOrderSyncsInput = Record<string, never>
export type FlagOrphanedOrderSyncsOutput = { repaired: string[] }

type OrphanedSyncRow = { id: string }

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: "sent"
    ongoing_order_id: null
  }) => Promise<OrphanedSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    sync_state: "error"
    error_class: "retryable"
    last_error: string
    last_synced_at: null
  }) => Promise<unknown>
}

const ORPHANED_SYNC_ERROR_MESSAGE =
  "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push"

// #108: putOrder used to return { ongoingOrderId: undefined } when Ongoing's 2xx body
// omitted orderId, and push-order-record-sync.ts/upsert-ongoing-order-edit.ts persisted
// that undefined (stored as null, OngoingOrderSync.ongoing_order_id is nullable) as
// sync_state="sent". putOrder now throws instead (client.ts), so no NEW rows can reach
// this state -- this step is a one-time repair for rows already stuck in it before the
// fix shipped. Flips each row to sync_state="error"/error_class="retryable" with
// last_synced_at reset to null so it is picked up by the existing retry pipeline: the
// ongoing-retry-failed-syncs job (src/jobs/retry-failed-syncs.ts) queries exactly
// sync_state="error" AND error_class="retryable", and isRetryDue treats a null
// last_synced_at as always due. Idempotent: once flipped, sync_state is no longer
// "sent" so a re-run finds nothing.
export async function flagOrphanedOrderSyncsHandler(
  _input: FlagOrphanedOrderSyncsInput,
  { container }: { container: MedusaContainer }
): Promise<FlagOrphanedOrderSyncsOutput> {
  const service: OngoingServiceLike = container.resolve(ONGOING_MODULE)

  const rows = await service.listOngoingOrderSyncs({
    sync_state: "sent",
    ongoing_order_id: null,
  })

  const repaired: string[] = []
  for (const row of rows) {
    await service.updateOngoingOrderSyncs({
      id: row.id,
      sync_state: "error",
      error_class: "retryable",
      last_error: ORPHANED_SYNC_ERROR_MESSAGE,
      last_synced_at: null,
    })
    repaired.push(row.id)
  }

  return { repaired }
}

export const flagOrphanedOrderSyncsStep = createStep(
  "flag-orphaned-order-syncs",
  async (input: FlagOrphanedOrderSyncsInput, context) => {
    const output = await flagOrphanedOrderSyncsHandler(input, context)
    return new StepResponse(output)
  }
)
