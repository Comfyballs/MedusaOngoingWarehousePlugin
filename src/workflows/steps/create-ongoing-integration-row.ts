import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { StockReconcileMode } from "../../lib/ongoing/types"
import { isUniqueViolation } from "../../lib/ongoing/db-errors"

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

  // The generated create DTO types the two `model.json()` columns
  // (`shipped_status_codes`/`cancellable_status_codes`) as
  // `Record<string, unknown> | null`, while this step's input carries their
  // actual runtime shape, `number[] | null`. Cast ONLY those two fields — not
  // the whole `input`, which `as any` did previously, silencing typos on every
  // other column. `model.json()` has no typed-array variant in Medusa 2.16, so a
  // documented field-level cast is the pragmatic choice over reshaping the model.
  const createInput = {
    ...input,
    shipped_status_codes: input.shipped_status_codes as unknown as
      | Record<string, unknown>
      | null,
    cancellable_status_codes: input.cancellable_status_codes as unknown as
      | Record<string, unknown>
      | null,
  }

  let integration: OngoingIntegrationRow
  try {
    integration = (await ongoing.createOngoingIntegrations(
      createInput
    )) as OngoingIntegrationRow
  } catch (err) {
    // credential_key and stock_location_id are both UNIQUE (models/integration.ts).
    // A DB-level unique violation would otherwise bubble up as an opaque 500;
    // translate it to a typed MedusaError so the admin route returns 422 (I6).
    if (isUniqueViolation(err)) {
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `An Ongoing integration already exists with credential_key "${input.credential_key}" or stock_location_id "${input.stock_location_id}".`
      )
    }
    throw err
  }
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
