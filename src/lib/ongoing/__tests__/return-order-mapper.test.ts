import { mapReturnOrderToPostReturnOrderModel } from "../return-order-mapper"
import { OngoingApiError } from "../errors"
import type { MapReturnOrderInput } from "../types"

const baseInput = (): MapReturnOrderInput => ({
  goods_owner_id: 42,
  return_order_number: "RET-1001-ret_1",
  ongoing_order_id: 999,
  in_date: "2026-07-17",
  lines: [
    { article_number: "SKU-1", quantity: 2 },
    { article_number: "SKU-2", quantity: 1 },
  ],
  original_order_lines: [
    { orderLineId: 111, articleNumber: "SKU-1" },
    { orderLineId: 222, articleNumber: "SKU-2" },
  ],
})

describe("mapReturnOrderToPostReturnOrderModel — happy path", () => {
  it("produces a valid PostReturnOrderModel with required top-level fields", () => {
    const out = mapReturnOrderToPostReturnOrderModel(baseInput())
    expect(out.goodsOwnerId).toBe(42)
    expect(out.returnOrderNumber).toBe("RET-1001-ret_1")
    expect(out.customerOrder).toEqual({ orderId: 999 })
    expect(out.inDate).toBe("2026-07-17")
  })

  it("maps lines: 1-based rowNumber, matched orderLineId, quantity", () => {
    const out = mapReturnOrderToPostReturnOrderModel(baseInput())
    expect(out.returnOrderLines).toEqual([
      {
        returnOrderRowNumber: "1",
        customerOrderLine: { orderLineId: 111 },
        toBeReturnedNumberOfItems: 2,
      },
      {
        returnOrderRowNumber: "2",
        customerOrderLine: { orderLineId: 222 },
        toBeReturnedNumberOfItems: 1,
      },
    ])
  })

  it("consumes each original line at most once when article numbers repeat", () => {
    const input = baseInput()
    input.lines = [
      { article_number: "SKU-1", quantity: 1 },
      { article_number: "SKU-1", quantity: 1 },
    ]
    input.original_order_lines = [
      { orderLineId: 111, articleNumber: "SKU-1" },
      { orderLineId: 333, articleNumber: "SKU-1" },
    ]
    const out = mapReturnOrderToPostReturnOrderModel(input)
    const orderLineIds = out.returnOrderLines!.map((l) => l.customerOrderLine.orderLineId)
    expect(orderLineIds).toEqual([111, 333])
  })

  it("includes comment only when non-blank", () => {
    const withComment = mapReturnOrderToPostReturnOrderModel({ ...baseInput(), comment: "Wrong size" })
    expect(withComment.comment).toBe("Wrong size")

    const withoutComment = mapReturnOrderToPostReturnOrderModel(baseInput())
    expect(withoutComment.comment).toBeUndefined()
  })

  it("emits no keys outside the typed PostReturnOrderModel shape", () => {
    const out = mapReturnOrderToPostReturnOrderModel({ ...baseInput(), comment: "note" })
    const allowed = new Set([
      "goodsOwnerId", "returnOrderNumber", "customerOrder", "inDate", "comment", "returnOrderLines",
    ])
    for (const key of Object.keys(JSON.parse(JSON.stringify(out)))) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})

describe("mapReturnOrderToPostReturnOrderModel — terminal validation", () => {
  const expectTerminal = (mutate: (i: MapReturnOrderInput) => void, messagePattern: RegExp) => {
    const input = baseInput()
    mutate(input)
    let thrown: unknown
    try {
      mapReturnOrderToPostReturnOrderModel(input)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OngoingApiError)
    expect((thrown as OngoingApiError).kind).toBe("terminal")
    expect((thrown as OngoingApiError).message).toMatch(messagePattern)
  }

  it("throws when return_order_number is missing", () => {
    expectTerminal((i) => { i.return_order_number = "" }, /return order number/i)
  })

  it("throws when ongoing_order_id is not a finite number", () => {
    expectTerminal((i) => { i.ongoing_order_id = Number.NaN }, /original Ongoing order id/i)
  })

  it("throws when in_date is missing", () => {
    expectTerminal((i) => { i.in_date = "" }, /inDate/i)
  })

  it("throws when there are no lines", () => {
    expectTerminal((i) => { i.lines = [] }, /no lines/i)
  })

  it("throws when a line has no resolvable article number", () => {
    expectTerminal((i) => { i.lines[0].article_number = "" }, /article number/i)
  })

  it("throws when a line quantity is <= 0", () => {
    expectTerminal((i) => { i.lines[0].quantity = 0 }, /quantity/i)
  })

  it("throws when a return line's article number has no match on the original order", () => {
    expectTerminal((i) => { i.lines[0].article_number = "SKU-UNKNOWN" }, /no matching line/i)
  })
})
