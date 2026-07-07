import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { OngoingInventoryRow } from "../../lib/ongoing/types"

export type FetchOngoingInventoryInput = { credential_key: string }

export async function fetchOngoingInventoryHandler(
  input: FetchOngoingInventoryInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<OngoingInventoryRow[]>> {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const rows: OngoingInventoryRow[] = await service.getClient(input.credential_key).getInventory()
  return new StepResponse(rows)
}

export const fetchOngoingInventoryStep = createStep(
  "fetch-ongoing-inventory",
  fetchOngoingInventoryHandler
)
