import { MedusaError } from "@medusajs/framework/utils"
import { STOCK_RECONCILE_MODES, StockReconcileMode } from "../../../../lib/ongoing/types"

export type CreateIntegrationInput = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `[ongoing] ${message}`)
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
}

// Request-SHAPE validation only (required fields, correct types/enums) — this
// never touches plugin options or the DB. Whether the credential_key actually
// exists is business validation and lives in the workflow step
// (createOngoingIntegrationRowHandler, src/workflows/steps/create-ongoing-integration-row.ts).
export function validateCreateIntegrationInput(body: unknown): CreateIntegrationInput {
  const b = (body ?? {}) as Record<string, unknown>

  if (typeof b.credential_key !== "string" || b.credential_key.length === 0) {
    invalid("credential_key is required")
  }
  if (typeof b.stock_location_id !== "string" || b.stock_location_id.length === 0) {
    invalid("stock_location_id is required")
  }
  if (
    b.stock_reconcile_mode !== undefined &&
    !STOCK_RECONCILE_MODES.includes(b.stock_reconcile_mode as StockReconcileMode)
  ) {
    invalid(`stock_reconcile_mode must be one of ${STOCK_RECONCILE_MODES.join(", ")}`)
  }
  if (
    b.shipped_status_codes !== undefined &&
    b.shipped_status_codes !== null &&
    !isNumberArray(b.shipped_status_codes)
  ) {
    invalid("shipped_status_codes must be an array of numbers")
  }
  if (
    b.cancellable_status_codes !== undefined &&
    b.cancellable_status_codes !== null &&
    !isNumberArray(b.cancellable_status_codes)
  ) {
    invalid("cancellable_status_codes must be an array of numbers")
  }
  if (
    b.edit_sync_rules !== undefined &&
    b.edit_sync_rules !== null &&
    (typeof b.edit_sync_rules !== "object" || Array.isArray(b.edit_sync_rules))
  ) {
    invalid("edit_sync_rules must be an object")
  }

  return {
    credential_key: b.credential_key as string,
    stock_location_id: b.stock_location_id as string,
    enabled: typeof b.enabled === "boolean" ? b.enabled : true,
    stock_sync_enabled: typeof b.stock_sync_enabled === "boolean" ? b.stock_sync_enabled : true,
    stock_sync_interval: typeof b.stock_sync_interval === "string" ? b.stock_sync_interval : null,
    status_poll_interval: typeof b.status_poll_interval === "string" ? b.status_poll_interval : null,
    stock_reconcile_mode: (b.stock_reconcile_mode as StockReconcileMode) ?? "sellable_plus_reserved",
    edit_sync_rules: (b.edit_sync_rules as Record<string, unknown> | null) ?? null,
    shipped_status_codes: (b.shipped_status_codes as number[] | null) ?? null,
    cancellable_status_codes: (b.cancellable_status_codes as number[] | null) ?? null,
  }
}
