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
  last_status_poll_at: model.dateTime().nullable(),
  sync_lock_until: model.dateTime().nullable(),
})

export default OngoingIntegration
