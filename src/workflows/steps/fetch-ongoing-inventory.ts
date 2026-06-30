import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { OngoingInventoryRow } from "../../lib/ongoing/types"

export type FetchOngoingInventoryInput = { credential_key: string }

export async function fetchOngoingInventoryHandler(
  input: FetchOngoingInventoryInput,
  { container }: { container: any }
): Promise<StepResponse<OngoingInventoryRow[]>> {
  const service: any = container.resolve(ONGOING_MODULE)
  const rows: OngoingInventoryRow[] = await service.getClient(input.credential_key).getInventory()
  return new StepResponse(rows)
}

export const fetchOngoingInventoryStep = createStep(
  "fetch-ongoing-inventory",
  fetchOngoingInventoryHandler
)
