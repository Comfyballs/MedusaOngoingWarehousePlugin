import { MedusaError } from "@medusajs/framework/utils"
import { STOCK_RECONCILE_MODES, StockReconcileMode } from "../../../../../lib/ongoing/types"
import { validateIntervalString } from "../interval-validation"

// credential_key, goods_owner_id and stock_location_id are deliberately NOT modeled
// here even if present in the request body — they are immutable after creation (see
// "Design decisions" #3 in the #40 plan). Re-pointing a live integration at a
// different goods owner would orphan every sync row already written against the old
// one, so changing warehouse means creating a new integration (bead 9y2.9). Any such keys in the body are never
// read into the returned object, so they can never reach the update workflow.
export type UpdateIntegrationInput = {
  enabled?: boolean
  stock_sync_enabled?: boolean
  stock_sync_interval?: string | null
  status_poll_interval?: string | null
  stock_reconcile_mode?: StockReconcileMode
  edit_sync_rules?: Record<string, unknown> | null
  shipped_status_codes?: number[] | null
  delivered_status_codes?: number[] | null
  cancellable_status_codes?: number[] | null
}

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `[ongoing] ${message}`)
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
}

export function validateUpdateIntegrationInput(body: unknown): UpdateIntegrationInput {
  const b = (body ?? {}) as Record<string, unknown>
  const result: UpdateIntegrationInput = {}

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") invalid("enabled must be a boolean")
    result.enabled = b.enabled as boolean
  }
  if (b.stock_sync_enabled !== undefined) {
    if (typeof b.stock_sync_enabled !== "boolean") invalid("stock_sync_enabled must be a boolean")
    result.stock_sync_enabled = b.stock_sync_enabled as boolean
  }
  if (b.stock_sync_interval !== undefined) {
    if (b.stock_sync_interval !== null && typeof b.stock_sync_interval !== "string") {
      invalid("stock_sync_interval must be a string or null")
    }
    // bead atq: a non-numeric value used to be accepted, stored, and then silently
    // ignored at read time (resolveIntervalMs falls back to the default) — reject it
    // here so a saved value that does nothing can no longer happen.
    if (b.stock_sync_interval !== null) {
      validateIntervalString(b.stock_sync_interval as string, "stock_sync_interval")
    }
    result.stock_sync_interval = b.stock_sync_interval as string | null
  }
  if (b.status_poll_interval !== undefined) {
    if (b.status_poll_interval !== null && typeof b.status_poll_interval !== "string") {
      invalid("status_poll_interval must be a string or null")
    }
    if (b.status_poll_interval !== null) {
      validateIntervalString(b.status_poll_interval as string, "status_poll_interval")
    }
    result.status_poll_interval = b.status_poll_interval as string | null
  }
  if (b.stock_reconcile_mode !== undefined) {
    if (!STOCK_RECONCILE_MODES.includes(b.stock_reconcile_mode as StockReconcileMode)) {
      invalid(`stock_reconcile_mode must be one of ${STOCK_RECONCILE_MODES.join(", ")}`)
    }
    result.stock_reconcile_mode = b.stock_reconcile_mode as StockReconcileMode
  }
  if (b.edit_sync_rules !== undefined) {
    if (
      b.edit_sync_rules !== null &&
      (typeof b.edit_sync_rules !== "object" || Array.isArray(b.edit_sync_rules))
    ) {
      invalid("edit_sync_rules must be an object or null")
    }
    result.edit_sync_rules = b.edit_sync_rules as Record<string, unknown> | null
  }
  if (b.shipped_status_codes !== undefined) {
    if (b.shipped_status_codes !== null && !isNumberArray(b.shipped_status_codes)) {
      invalid("shipped_status_codes must be an array of numbers or null")
    }
    result.shipped_status_codes = b.shipped_status_codes as number[] | null
  }
  if (b.delivered_status_codes !== undefined) {
    if (b.delivered_status_codes !== null && !isNumberArray(b.delivered_status_codes)) {
      invalid("delivered_status_codes must be an array of numbers or null")
    }
    result.delivered_status_codes = b.delivered_status_codes as number[] | null
  }
  if (b.cancellable_status_codes !== undefined) {
    if (b.cancellable_status_codes !== null && !isNumberArray(b.cancellable_status_codes)) {
      invalid("cancellable_status_codes must be an array of numbers or null")
    }
    result.cancellable_status_codes = b.cancellable_status_codes as number[] | null
  }

  return result
}
