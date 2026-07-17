import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  reQueryReturnFulfillment,
  type QueriedReturnFulfillment,
} from "../../lib/ongoing/re-query-return-fulfillment"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"

export type QueryReturnFulfillmentInput = { return_fulfillment_id: string }

export type ResolvedReturnLine = {
  article_number: string
  quantity: number
  line_item_id: string | null
}

export type QueriedReturnFulfillmentWithLines = QueriedReturnFulfillment & {
  resolvedLines: ResolvedReturnLine[]
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper does
// not expose its invoke fn). Mirrors query-fulfillment-order.ts's handler.
export async function queryReturnFulfillmentHandler(
  input: QueryReturnFulfillmentInput,
  { container }: { container: MedusaContainer }
): Promise<QueriedReturnFulfillmentWithLines> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const queried = await reQueryReturnFulfillment(query, input.return_fulfillment_id)

  const resolvedLines: ResolvedReturnLine[] = []
  for (const item of queried.items) {
    const article_number = await resolveArticleNumber(query, item.sku as string)
    resolvedLines.push({
      article_number,
      quantity: item.quantity,
      line_item_id: item.line_item_id,
    })
  }

  return { ...queried, resolvedLines }
}

export const queryReturnFulfillmentStep = createStep(
  "query-return-fulfillment",
  async (input: QueryReturnFulfillmentInput, context) => {
    const result = await queryReturnFulfillmentHandler(input, context)
    return new StepResponse(result)
  }
)
