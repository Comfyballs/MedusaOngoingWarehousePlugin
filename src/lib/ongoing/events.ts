export const ONGOING_EVENTS = {
  ORDER_PUSHED: "ongoing.sync.order_pushed",
  PUSH_FAILED: "ongoing.sync.push_failed",
  SHIPMENT_APPLIED: "ongoing.sync.shipment_applied",
  ORDER_CANCELLED: "ongoing.sync.order_cancelled",
  ORDER_RETRIED: "ongoing.sync.order_retried",
  ORDER_DEAD_LETTERED: "ongoing.sync.order_dead_lettered",
  INVENTORY_SYNCED: "ongoing.sync.inventory_synced",
  EDIT_BLOCKED: "ongoing.sync.edit_blocked",
  RETURN_ORDER_PUSHED: "ongoing.sync.return_order_pushed",
  RETURN_ORDER_PUSH_FAILED: "ongoing.sync.return_order_push_failed",
  RETURN_STATUS_RECEIVED: "ongoing.sync.return_status_received",
} as const

export type OngoingEventName = (typeof ONGOING_EVENTS)[keyof typeof ONGOING_EVENTS]

export interface OrderPushedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  ongoing_order_id: number
  integration_id: string
}

export interface PushFailedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  integration_id: string
  error_class: "retryable" | "terminal"
  error_message: string
}

export interface ShipmentAppliedPayload {
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_sync_id: string
  ongoing_order_number: string
  tracking_numbers: string[]
}

export interface OrderCancelledPayload {
  medusa_order_id: string
  ongoing_order_number: string
  ongoing_order_sync_id: string
  reason: string
}

export interface OrderRetriedPayload {
  ongoing_order_sync_id: string
  medusa_fulfillment_id: string
  retry_count: number
}

export interface OrderDeadLetteredPayload {
  ongoing_order_sync_id: string
  // null when the row was dead-lettered because it had no fulfillment id to
  // retry (retry-failed-syncs.ts null-fulfillment branch).
  medusa_fulfillment_id: string | null
  retry_count: number
}

export interface InventorySyncedPayload {
  integration_id: string
  credential_key: string
  stock_location_id: string
  written: number
  skipped: number
}

export interface EditBlockedPayload {
  medusa_order_id: string
  ongoing_order_sync_id: string
  category: string
  latest_status_code: number | null
}

export interface ReturnOrderPushedPayload {
  medusa_order_id: string
  medusa_return_fulfillment_id: string
  return_order_number: string
  ongoing_return_order_id: number
  ongoing_order_id: number
  integration_id: string
}

export interface ReturnOrderPushFailedPayload {
  medusa_order_id: string
  medusa_return_fulfillment_id: string
  return_order_number: string
  integration_id: string
  error_class: "retryable" | "terminal"
  error_message: string
}

// Emitted when an inbound Ongoing order-status webhook carries return-flagged
// (isReturn / isReturnParcel) tracking/parcel entries. There is no return-order
// identifier on this payload (see map-payload-to-return-status-input.ts), so this
// event is scoped to the ORIGINAL order's OngoingOrderSync row, not a specific
// Medusa `return` record — see record-return-status.ts and Dev-Architecture.md for
// the full rationale.
export interface ReturnStatusReceivedPayload {
  medusa_order_id: string
  ongoing_order_number: string
  ongoing_order_sync_id: string
  integration_id: string
  status_code: number
  status_text: string
  return_tracking_numbers: string[]
  return_parcel_numbers: string[]
}
