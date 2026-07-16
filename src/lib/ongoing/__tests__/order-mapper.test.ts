import { mapOrderToPostOrderModel } from "../order-mapper"
import { OngoingApiError } from "../errors"
import type { MapOrderInput } from "../types"

const baseInput = (): MapOrderInput => ({
  goods_owner_id: 42,
  order_number: "1001-abc123",
  delivery_date: "2026-07-01T10:00:00.000Z",
  currency_code: "nok",
  email: "buyer@example.test",
  shipping_address: {
    first_name: "Ada",
    last_name: "Lovelace",
    address_1: "Storgata 1",
    address_2: "Leil 4",
    city: "Oslo",
    postal_code: "0155",
    country_code: "no",
    phone: "+4798765432",
  },
  lines: [
    { article_number: "SKU-1", quantity: 2, weight: 0.5, unit_price: 199.5, currency_code: "nok" },
    { article_number: "SKU-2", quantity: 1, unit_price: 49.0 },
  ],
})

describe("mapOrderToPostOrderModel — happy path", () => {
  it("produces a valid PostOrderModel with required top-level fields", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.goodsOwnerId).toBe(42)
    expect(out.orderNumber).toBe("1001-abc123")
    expect(out.deliveryDate).toBe("2026-07-01T10:00:00.000Z")
    expect(out.consignee).toBeDefined()
  })

  it("maps the shipping address onto the consignee (name joined, country unchanged)", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.consignee).toEqual({
      name: "Ada Lovelace",
      address1: "Storgata 1",
      address2: "Leil 4",
      city: "Oslo",
      postCode: "0155",
      countryCode: "no", // ISO-2 lowercase, passed through unchanged
    })
  })

  it("maps lines: 1-based rowNumber, article number, quantity, weight, as-is prices", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.orderLines).toEqual([
      {
        rowNumber: "1",
        articleNumber: "SKU-1",
        numberOfItems: 2,
        weight: 0.5,
        prices: { linePrice: 199.5, currencyCode: "NOK" },
      },
      {
        rowNumber: "2",
        articleNumber: "SKU-2",
        numberOfItems: 1,
        prices: { linePrice: 49.0, currencyCode: "NOK" },
      },
    ])
  })

  it("puts email/phone on notification objects (value + toBeNotified), not the consignee", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    // OpenAPI v57: PostOrderNotification = { toBeNotified?, value? }
    expect(out.emailNotification).toEqual({ value: "buyer@example.test", toBeNotified: true })
    expect(out.telephoneNotification).toEqual({ value: "+4798765432", toBeNotified: true })
    expect(out.consignee).not.toHaveProperty("phone")
    expect(out.consignee).not.toHaveProperty("email")
  })

  it("omits wayOfDelivery and transporter when the input carries none", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.wayOfDelivery).toBeUndefined()
    expect(out.transporter).toBeUndefined()
  })

  it("maps wayOfDelivery (code + name) and transporter when the input provides them", () => {
    const input = baseInput()
    input.way_of_delivery = { code: "dhl-express", name: "DHL Express" }
    input.transporter = { transporterCode: "DHL", transporterServiceCode: "EXP", paymentAdvanced: false }
    const out = mapOrderToPostOrderModel(input)
    expect(out.wayOfDelivery).toEqual({ code: "dhl-express", name: "DHL Express" })
    expect(out.transporter).toEqual({
      transporterCode: "DHL",
      transporterServiceCode: "EXP",
      paymentAdvanced: false,
    })
  })

  it("maps wayOfDelivery with only a code (no name) and omits an empty transporter", () => {
    const input = baseInput()
    input.way_of_delivery = { code: "postnord" }
    input.transporter = {}
    const out = mapOrderToPostOrderModel(input)
    expect(out.wayOfDelivery).toEqual({ code: "postnord" })
    expect(out.transporter).toBeUndefined()
  })

  it("omits wayOfDelivery when the code is blank", () => {
    const input = baseInput()
    input.way_of_delivery = { code: "   " }
    const out = mapOrderToPostOrderModel(input)
    expect(out.wayOfDelivery).toBeUndefined()
  })

  it("uses the order currency (uppercased) when a line has no currency", () => {
    const input = baseInput()
    input.lines[0].currency_code = null
    const out = mapOrderToPostOrderModel(input)
    expect(out.orderLines![0].prices!.currencyCode).toBe("NOK")
  })

  it("converts a Date delivery_date to an ISO string", () => {
    const input = baseInput()
    input.delivery_date = new Date("2026-08-15T08:30:00.000Z")
    const out = mapOrderToPostOrderModel(input)
    expect(out.deliveryDate).toBe("2026-08-15T08:30:00.000Z")
  })

  it("passes prices through with no unit conversion (no x100)", () => {
    const input = baseInput()
    input.lines[0].unit_price = 12.34
    const out = mapOrderToPostOrderModel(input)
    expect(out.orderLines![0].prices!.linePrice).toBe(12.34)
  })

  it("emits no keys outside the typed PostOrderModel shape", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    const allowed = new Set([
      "goodsOwnerId", "orderNumber", "deliveryDate", "consignee", "orderLines",
      "freightPrice", "customerPrice", "wayOfDelivery", "transporter",
      "emailNotification", "smsNotification", "telephoneNotification",
    ])
    // JSON round-trip drops undefined keys, mirroring the wire payload.
    for (const key of Object.keys(JSON.parse(JSON.stringify(out)))) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})

describe("mapOrderToPostOrderModel — terminal validation", () => {
  const expectTerminal = (mutate: (i: MapOrderInput) => void, messagePattern: RegExp) => {
    const input = baseInput()
    mutate(input)
    let thrown: unknown
    try {
      mapOrderToPostOrderModel(input)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OngoingApiError)
    expect((thrown as OngoingApiError).kind).toBe("terminal")
    expect((thrown as OngoingApiError).message).toMatch(messagePattern)
  }

  it("throws when shipping_address is missing", () => {
    expectTerminal((i) => { i.shipping_address = null }, /shipping address/i)
  })

  it("throws when country_code is missing", () => {
    expectTerminal((i) => { i.shipping_address!.country_code = "" }, /country/i)
  })

  it("throws when postal_code is missing", () => {
    expectTerminal((i) => { i.shipping_address!.postal_code = "  " }, /post(al)? ?code/i)
  })

  it("throws when consignee name is empty", () => {
    expectTerminal((i) => {
      i.shipping_address!.first_name = ""
      i.shipping_address!.last_name = "  "
    }, /name/i)
  })

  it("throws when a line has no resolvable article number", () => {
    expectTerminal((i) => { i.lines[1].article_number = "" }, /article number/i)
  })

  it("throws when a line quantity is <= 0", () => {
    expectTerminal((i) => { i.lines[0].quantity = 0 }, /quantity|numberOfItems/i)
  })

  it("throws when delivery_date is not formable", () => {
    expectTerminal((i) => { i.delivery_date = "not-a-date" }, /delivery date/i)
  })

  it("throws when delivery_date is missing", () => {
    expectTerminal((i) => { i.delivery_date = null }, /delivery date/i)
  })
})
