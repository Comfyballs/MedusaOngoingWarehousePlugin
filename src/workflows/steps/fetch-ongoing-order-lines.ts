import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { OngoingOrderLineDetail } from "../../lib/ongoing/types"

export type FetchOngoingOrderLinesInput = {
  ongoing_order_id: number
  credential_key: string
}

export type FetchOngoingOrderLinesOutput = {
  lines: OngoingOrderLineDetail[]
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper does
// not expose its invoke fn).
export async function fetchOngoingOrderLinesHandler(
  input: FetchOngoingOrderLinesInput,
  { container }: { container: MedusaContainer }
): Promise<FetchOngoingOrderLinesOutput> {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const client = service.getClient(input.credential_key)

  const detail = await client.getOrder(input.ongoing_order_id)

  return { lines: detail.lines }
}

export const fetchOngoingOrderLinesStep = createStep(
  "fetch-ongoing-order-lines",
  async (input: FetchOngoingOrderLinesInput, context) => {
    const output = await fetchOngoingOrderLinesHandler(input, context)
    return new StepResponse(output)
  }
)
