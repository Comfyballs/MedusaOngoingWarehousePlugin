import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type RefreshOrderSyncStatusInput = {
  ongoing_order_number: string
  integration_id: string
  status_code: number
  status_text: string
}

export type RefreshOrderSyncStatusOutput = {
  refreshed: boolean
  reason?: "no_order_number" | "no_sync_row" | "terminal_state"
}

// Sync states past which a status refresh is meaningless: a shipped/cancelled
// order is no longer edit/cancel-gated. Mirrors status-poll's TERMINAL_SYNC_STATES
// so the webhook and poll paths keep the same "stop refreshing" boundary.
const TERMINAL_SYNC_STATES = new Set(["shipped", "cancelled"])

type OrderSyncRow = { id: string; sync_state: string }

export async function refreshOrderSyncStatusHandler(
  input: RefreshOrderSyncStatusInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<RefreshOrderSyncStatusOutput>> {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const orderNumber = input.ongoing_order_number?.trim()
  if (!orderNumber) {
    return new StepResponse({ refreshed: false, reason: "no_order_number" })
  }

  // ongoing_order_number is globally unique; scope by integration_id too as
  // defense-in-depth so one credential's webhook can never touch another's row.
  const [row] = (await ongoing.listOngoingOrderSyncs({
    ongoing_order_number: orderNumber,
    integration_id: input.integration_id,
  })) as OrderSyncRow[]

  if (!row) {
    return new StepResponse({ refreshed: false, reason: "no_sync_row" })
  }
  if (TERMINAL_SYNC_STATES.has(row.sync_state)) {
    return new StepResponse({ refreshed: false, reason: "terminal_state" })
  }

  await ongoing.updateOngoingOrderSyncs({
    id: row.id,
    latest_status_code: input.status_code,
    latest_status_text: input.status_text,
    last_synced_at: new Date(),
  })

  logger.debug?.(
    `[ongoing] webhook: refreshed latest_status_code=${input.status_code} for ` +
      `ongoing_order_number=${orderNumber} (sync ${row.id})`
  )
  return new StepResponse({ refreshed: true })
}

export const refreshOrderSyncStatusStep = createStep(
  "refresh-order-sync-status",
  refreshOrderSyncStatusHandler
)
