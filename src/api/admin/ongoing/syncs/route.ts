import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import { computeSyncStateSummary, type OngoingSyncStateSummary } from "./summary"

const DEFAULT_LIMIT = 20
const DEFAULT_OFFSET = 0
const DASHBOARD_SYNC_STATES = ["error", "sent", "pending"] as const

type OngoingSyncRow = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  sync_state: string
  error_class: string | null
  retry_count: number
  last_error: string | null
  last_synced_at: Date | string | null
}

type OngoingServiceLike = {
  listAndCountOngoingOrderSyncs: (
    filter: { sync_state: readonly string[] | string },
    config: { skip: number; take: number; order?: Record<string, "ASC" | "DESC"> }
  ) => Promise<[OngoingSyncRow[], number]>
}

// No Zod middleware here on purpose (see Global Constraints) -- parse directly
// with defaults, mirroring the resolved research's exact contract.
function parseIntParam(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = typeof raw === "string" ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const take = parseIntParam(req.query.limit, DEFAULT_LIMIT)
  const skip = parseIntParam(req.query.offset, DEFAULT_OFFSET)

  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  const [[syncs, count], summary]: [[OngoingSyncRow[], number], OngoingSyncStateSummary] =
    await Promise.all([
      ongoing.listAndCountOngoingOrderSyncs(
        { sync_state: DASHBOARD_SYNC_STATES },
        { skip, take, order: { last_synced_at: "DESC" } }
      ),
      computeSyncStateSummary(ongoing),
    ])

  res.status(200).json({ syncs, count, limit: take, offset: skip, summary })
}
