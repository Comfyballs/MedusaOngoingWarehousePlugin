import { model } from "@medusajs/framework/utils"

const OngoingOrderSync = model.define("ongoing_order_sync", {
  id: model.id().primaryKey(),
  // Discriminates an outbound order push from a return push (8p8). Return rows
  // reuse this ledger so the retry-failed-syncs job gives them the same
  // backoff/dead-letter machinery; the job branches its re-push on this field.
  // For a return row, medusa_fulfillment_id holds the RETURN fulfillment id and
  // ongoing_order_number holds the returnOrderNumber.
  sync_kind: model.enum(["order", "return"]).default("order"),
  // w0a: status-poll.ts runs listOngoingOrderSyncs({ integration_id }) every
  // minute per integration; without this index that tick full-scans a table
  // that only grows with order volume.
  integration_id: model.text().index(),
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
  // ei4 fallout (eer): Ongoing declined a cancel because its status was not in
  // cancellable_status_codes, but Medusa already committed the fulfillment
  // cancel — the two sides now disagree. Flag it so an operator sees it in the
  // order widget and reconciles in Ongoing. Cleared on the next successful cancel.
  cancel_refused_at: model.dateTime().nullable(),
  cancel_refused_reason: model.text().nullable(),
}).indexes([
  // w0a: retry-failed-syncs.ts runs listOngoingOrderSyncs({ sync_state: "error",
  // error_class: "retryable" }) every minute. A composite index on both columns
  // keeps that every-tick sweep off a full table scan as the ledger grows.
  {
    on: ["sync_state", "error_class"],
  },
])

export default OngoingOrderSync
