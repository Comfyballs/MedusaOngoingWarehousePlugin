import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import {
  ALL_SYNC_STATES,
  computeSyncStateSummary,
  type OngoingSyncState,
  type OngoingSyncStateSummary,
} from "./summary"

const DEFAULT_LIMIT = 20
const DEFAULT_OFFSET = 0
// The default dashboard view surfaces the actionable states; `shipped`/`cancelled` are
// summarised but omitted here unless the caller asks for them via `?state=` (bead on2).
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

// bead on2: let the dashboard drill into ANY sync state the summary counts (previously the
// list hardcoded error/sent/pending, so shipped/cancelled counts had no drill-through). A
// `?state=` param (repeatable, or comma-separated) filters to the requested valid states;
// unknown values are dropped, and an empty/absent selection falls back to the default view.
function parseStatesParam(value: unknown): readonly string[] {
  const raw = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const valid = raw.filter((s): s is OngoingSyncState =>
    (ALL_SYNC_STATES as readonly string[]).includes(s)
  )
  return valid.length ? Array.from(new Set(valid)) : DASHBOARD_SYNC_STATES
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const take = parseIntParam(req.query.limit, DEFAULT_LIMIT)
  const skip = parseIntParam(req.query.offset, DEFAULT_OFFSET)
  const states = parseStatesParam(req.query.state)

  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  const [[syncs, count], summary]: [[OngoingSyncRow[], number], OngoingSyncStateSummary] =
    await Promise.all([
      ongoing.listAndCountOngoingOrderSyncs(
        { sync_state: states },
        { skip, take, order: { last_synced_at: "DESC" } }
      ),
      computeSyncStateSummary(ongoing),
    ])

  res.status(200).json({ syncs, count, limit: take, offset: skip, states, summary })
}
