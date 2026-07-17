import { OngoingApiError } from "./errors"
import type {
  MapReturnOrderInput,
  MapReturnOrderInputLine,
  OngoingOrderLineDetail,
  PostReturnOrderLine,
  PostReturnOrderModel,
} from "./types"

function terminal(message: string): never {
  throw new OngoingApiError(message, { kind: "terminal" })
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Match each return line to an original order line by articleNumber, consuming each
 * original line at most once. Two return lines for the same articleNumber are matched
 * to two DISTINCT original order lines (when the original order had duplicate article
 * numbers across rows) rather than both pointing at the same `orderLineId`.
 */
function matchOrderLineId(
  articleNumber: string,
  rowNumber: string,
  remaining: OngoingOrderLineDetail[]
): number {
  const index = remaining.findIndex((l) => l.articleNumber === articleNumber)
  if (index === -1) {
    terminal(
      `[ongoing] return order line ${rowNumber} (article ${articleNumber}) has no matching ` +
        `line on the original Ongoing order — cannot resolve customerOrderLine.orderLineId`
    )
  }
  const [matched] = remaining.splice(index, 1)
  return matched.orderLineId
}

function mapLine(
  line: MapReturnOrderInputLine,
  index: number,
  remainingOriginalLines: OngoingOrderLineDetail[]
): PostReturnOrderLine {
  const rowNumber = String(index + 1)
  const articleNumber = nonEmpty(line.article_number) ? line.article_number.trim() : undefined
  if (!articleNumber) {
    // Article number is resolved upstream by the CALLER via the SKU->articleNumber
    // resolver; this mapper only validates that it is present, mirroring order-mapper.ts.
    terminal(`[ongoing] return order line ${rowNumber} has no resolvable article number (SKU did not resolve)`)
  }

  const quantity = line.quantity
  if (typeof quantity !== "number" || Number.isNaN(quantity) || quantity <= 0) {
    terminal(`[ongoing] return order line ${rowNumber} (article ${articleNumber}) has a non-positive quantity`)
  }

  const orderLineId = matchOrderLineId(articleNumber, rowNumber, remainingOriginalLines)

  return {
    returnOrderRowNumber: rowNumber,
    customerOrderLine: { orderLineId },
    toBeReturnedNumberOfItems: quantity,
  }
}

export function mapReturnOrderToPostReturnOrderModel(input: MapReturnOrderInput): PostReturnOrderModel {
  const returnOrderNumber = nonEmpty(input.return_order_number) ? input.return_order_number.trim() : undefined
  if (!returnOrderNumber) {
    terminal("[ongoing] return order is missing a return order number")
  }

  if (!Number.isFinite(input.ongoing_order_id)) {
    terminal("[ongoing] return order is missing the original Ongoing order id (customerOrder.orderId)")
  }

  if (!nonEmpty(input.in_date)) {
    terminal("[ongoing] return order is missing an inDate")
  }

  const lines = input.lines ?? []
  if (lines.length === 0) {
    terminal("[ongoing] return order has no lines")
  }

  // Copy so splicing during matching never mutates the caller's array.
  const remainingOriginalLines = [...input.original_order_lines]

  const model: PostReturnOrderModel = {
    goodsOwnerId: input.goods_owner_id,
    returnOrderNumber,
    customerOrder: { orderId: input.ongoing_order_id },
    inDate: input.in_date,
    returnOrderLines: lines.map((line, index) => mapLine(line, index, remainingOriginalLines)),
  }

  if (nonEmpty(input.comment)) {
    model.comment = input.comment.trim()
  }

  return model
}
