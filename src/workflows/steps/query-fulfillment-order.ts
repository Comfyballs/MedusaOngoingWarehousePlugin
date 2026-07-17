import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  reQueryFulfillmentOrder,
  type QueriedFulfillmentOrder,
} from "../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"

export type QueryFulfillmentOrderInput = { fulfillment_id: string }

export type ResolvedLine = {
  article_number: string
  quantity: number
  line_item_id: string | null
}

export type QueriedFulfillmentOrderWithLines = QueriedFulfillmentOrder & {
  resolvedLines: ResolvedLine[]
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper
// does not expose its invoke fn). Also exercised end-to-end by the workflow test.
export async function queryFulfillmentOrderHandler(
  input: QueryFulfillmentOrderInput,
  { container }: { container: MedusaContainer }
): Promise<QueriedFulfillmentOrderWithLines> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // Shared helper OWNED by #26 (also imported by #27).
  const queried = await reQueryFulfillmentOrder(query, input.fulfillment_id)

  // This step has `query`, so resolve each line's article_number per SKU here (#29).
  // resolveArticleNumber throws a terminal OngoingApiError on collision/missing SKU.
  const resolvedLines: ResolvedLine[] = []
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

export const queryFulfillmentOrderStep = createStep(
  "query-fulfillment-order",
  async (input: QueryFulfillmentOrderInput, context) => {
    const result = await queryFulfillmentOrderHandler(input, context)
    return new StepResponse(result)
  }
)
