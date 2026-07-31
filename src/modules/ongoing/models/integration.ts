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
  // Ongoing status codes that mark a pickup order as collected/delivered (canonical:
  // 500 "Hentet"). Parallel to shipped_status_codes; null/empty falls back to the
  // canonical defaults in src/lib/ongoing/status-semantics.ts (bead 18m).
  delivered_status_codes: model.json().nullable(),
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
  // When the daily done-order safety sweep last completed for this integration (bead t36).
  // The sweep re-syncs orders ABOVE the done threshold that changed in the past day — the
  // catch-net for the late transitions the 15-minute poll no longer sees once a row is
  // stamped done_synced_at (451 Klar til henting -> 500 Hentet, a 475 Retur, an annulment).
  // Advanced only on a successful sweep, so a failed one is retried on the next poll tick.
  last_done_sweep_at: model.dateTime().nullable(),
  // Per-job advisory locks (bead mjy): status-poll and stock-sync used to share this
  // single column, so whichever job acquired first blocked the other for its TTL even
  // though they poll unrelated data. sync_lock_until now belongs to status-poll only;
  // stock_sync_lock_until is its independent counterpart for the stock-sync job. See
  // acquireSyncLock/releaseSyncLock in service.ts.
  sync_lock_until: model.dateTime().nullable(),
  stock_sync_lock_until: model.dateTime().nullable(),
  // pud slice (a): record which fulfillment set / service zone / shipping options
  // setupOngoingLocationWorkflow actually CREATED, so a future guarded cleanup
  // (pud slice b) can target exactly our artifacts on integration delete without
  // touching pre-existing/shared ones. created_fulfillment_set_id is null when the
  // set was reused (must be preserved on cleanup); the service zone and shipping
  // options are always created by setup. This slice only persists — it performs no
  // cleanup/deletion (that remains deferred pending product sign-off).
  created_fulfillment_set_id: model.text().nullable(),
  created_service_zone_id: model.text().nullable(),
  created_shipping_option_ids: model.json().nullable(),
})

export default OngoingIntegration
