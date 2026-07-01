import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { StockReconcileMode } from "../../lib/ongoing/types"

export type CreateOngoingIntegrationRowInput = {
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

export type OngoingIntegrationRow = CreateOngoingIntegrationRowInput & { id: string }

export type CreateOngoingIntegrationRowCompensation = { integrationId: string }

export const createOngoingIntegrationRowHandler = async (
  input: CreateOngoingIntegrationRowInput,
  { container }: { container: any }
): Promise<StepResponse<OngoingIntegrationRow, CreateOngoingIntegrationRowCompensation>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any

  // Business validation (does this credential_key exist in plugin options?)
  // lives here, not in the route — throws MedusaError(INVALID_DATA) before any
  // row is written, so there is nothing to compensate on this failure path.
  ongoing.getCredentials(input.credential_key)

  const integration = await ongoing.createOngoingIntegrations(input)
  return new StepResponse(integration, { integrationId: integration.id })
}

export const compensateOngoingIntegrationRowHandler = async (
  compensation: CreateOngoingIntegrationRowCompensation | undefined,
  { container }: { container: any }
): Promise<void> => {
  if (!compensation) {
    return
  }
  const ongoing = container.resolve(ONGOING_MODULE) as any
  await ongoing.deleteOngoingIntegrations(compensation.integrationId)
}

export const createOngoingIntegrationRowStep = createStep(
  "create-ongoing-integration-row",
  createOngoingIntegrationRowHandler,
  compensateOngoingIntegrationRowHandler
)
