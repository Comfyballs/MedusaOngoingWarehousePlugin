import { model } from "@medusajs/framework/utils"

const OngoingIntegration = model.define("ongoing_integration", {
  id: model.id().primaryKey(),
  credential_key: model.text().unique(),
  enabled: model.boolean().default(true),
  stock_location_id: model.text().unique(),
  stock_sync_enabled: model.boolean().default(true),
  stock_sync_interval: model.text().nullable(),
  status_poll_interval: model.text().nullable(),
  stock_reconcile_mode: model
    .enum(["sellable_plus_reserved", "precise", "onhand"])
    .default("sellable_plus_reserved"),
  edit_sync_rules: model.json().nullable(),
  shipped_status_codes: model.json().nullable(),
  cancellable_status_codes: model.json().nullable(),
  last_stock_sync_at: model.dateTime().nullable(),
  // Delta-sync cursor: ISO timestamp passed as GET /articles?stockInfoChangedFrom on the
  // next tick so we pull only articles whose stock changed since the last successful sync
  // (bead sw8). Advanced only on a successful sync; null forces a full sweep.
  last_stock_delta_cursor: model.text().nullable(),
  // When the last FULL (non-delta) inventory sweep completed; drives the periodic
  // full-reconciliation fallback so any missed deltas self-heal (bead sw8).
  last_full_stock_sync_at: model.dateTime().nullable(),
  last_status_poll_at: model.dateTime().nullable(),
  // Per-job advisory locks (bead mjy): status-poll and stock-sync used to share this
  // single column, so whichever job acquired first blocked the other for its TTL even
  // though they poll unrelated data. sync_lock_until now belongs to status-poll only;
  // stock_sync_lock_until is its independent counterpart for the stock-sync job. See
  // acquireSyncLock/releaseSyncLock in service.ts.
  sync_lock_until: model.dateTime().nullable(),
  stock_sync_lock_until: model.dateTime().nullable(),
})

export default OngoingIntegration
