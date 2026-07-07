import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
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
  { container }: { container: MedusaContainer }
): Promise<StepResponse<OngoingIntegrationRow, CreateOngoingIntegrationRowCompensation>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  // Business validation (does this credential_key exist in plugin options?)
  // lives here, not in the route — throws MedusaError(INVALID_DATA) before any
  // row is written, so there is nothing to compensate on this failure path.
  ongoing.getCredentials(input.credential_key)

  // The generated create DTO types `shipped_status_codes`/`cancellable_status_codes`
  // as `Record<string, unknown> | null` because they're `model.json()` columns —
  // narrower than this step's `number[] | null` (the actual runtime shape we
  // write/read). The `as any` here is scoped to this one call's argument and
  // return, not the whole `ongoing` service (which stays fully typed above), so
  // method-name typos and other calls on `ongoing` are still caught.
  const integration = (await ongoing.createOngoingIntegrations(input as any)) as OngoingIntegrationRow
  return new StepResponse(integration, { integrationId: integration.id })
}

export const compensateOngoingIntegrationRowHandler = async (
  compensation: CreateOngoingIntegrationRowCompensation | undefined,
  { container }: { container: MedusaContainer }
): Promise<void> => {
  if (!compensation) {
    return
  }
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  await ongoing.deleteOngoingIntegrations(compensation.integrationId)
}

export const createOngoingIntegrationRowStep = createStep(
  "create-ongoing-integration-row",
  createOngoingIntegrationRowHandler,
  compensateOngoingIntegrationRowHandler
)
