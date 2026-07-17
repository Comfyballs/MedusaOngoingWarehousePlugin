import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type RetryOngoingSyncsInput = { sync_ids: string[] }
export type RetryOngoingSyncsOutput = { retried: string[]; skipped: string[] }

type SyncRow = {
  id: string
  sync_state: string
  error_class: "retryable" | "terminal" | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: { id: string[] }) => Promise<SyncRow[]>
  updateOngoingOrderSyncs: (data: { id: string; last_synced_at: null }) => Promise<unknown>
}

// Exported handler so the step can be unit-tested directly (createStep's wrapper
// does not expose its invoke fn) -- same pattern as pushOrderRecordSyncHandler
// (src/workflows/steps/push-order-record-sync.ts). Business rule: only rows that
// exist AND are sync_state="error" AND error_class="retryable" are reset; this is
// the ONLY place that resets last_synced_at (do not duplicate elsewhere).
export async function retryOngoingSyncsHandler(
  input: RetryOngoingSyncsInput,
  { container }: { container: MedusaContainer }
): Promise<RetryOngoingSyncsOutput> {
  const service: OngoingServiceLike = container.resolve(ONGOING_MODULE)

  const rows = await service.listOngoingOrderSyncs({ id: input.sync_ids })
  const byId = new Map(rows.map((row) => [row.id, row]))

  const retried: string[] = []
  const skipped: string[] = []

  for (const id of input.sync_ids) {
    const row = byId.get(id)
    if (!row || row.sync_state !== "error" || row.error_class !== "retryable") {
      skipped.push(id)
      continue
    }
    await service.updateOngoingOrderSyncs({ id, last_synced_at: null })
    retried.push(id)
  }

  return { retried, skipped }
}

export const retryOngoingSyncsStep = createStep(
  "retry-ongoing-syncs",
  async (input: RetryOngoingSyncsInput, context) => {
    const output = await retryOngoingSyncsHandler(input, context)
    return new StepResponse(output)
  }
)
