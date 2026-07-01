import { model } from "@medusajs/framework/utils"

const OngoingOrderSync = model.define("ongoing_order_sync", {
  id: model.id().primaryKey(),
  integration_id: model.text(),
  medusa_order_id: model.text().index(),
  medusa_fulfillment_id: model.text().index().nullable(),
  ongoing_order_number: model.text().unique(),
  ongoing_order_id: model.number().nullable(),
  latest_status_code: model.number().nullable(),
  latest_status_text: model.text().nullable(),
  sync_state: model
    .enum(["pending", "sent", "shipped", "cancelled", "error"])
    .default("pending"),
  error_class: model.enum(["retryable", "terminal"]).nullable(),
  last_synced_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  retry_count: model.number().default(0),
  shipped_at: model.dateTime().nullable(),
  edit_blocked_at: model.dateTime().nullable(),
  edit_blocked_category: model.enum(["address_contact", "line_items"]).nullable(),
  edit_blocked_reason: model.text().nullable(),
})

export default OngoingOrderSync
