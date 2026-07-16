import { OngoingApiError } from "./errors"
import type {
  MapOrderInput,
  MapOrderInputAddress,
  MapOrderInputLine,
  PostOrderConsignee,
  PostOrderLine,
  PostOrderLinePrices,
  PostOrderModel,
} from "./types"

function terminal(message: string): never {
  throw new OngoingApiError(message, { kind: "terminal" })
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function trimOrUndefined(value: unknown): string | undefined {
  return nonEmpty(value) ? value.trim() : undefined
}

function toIsoDeliveryDate(value: MapOrderInput["delivery_date"]): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      terminal("[ongoing] order has an invalid delivery date")
    }
    return value.toISOString()
  }
  if (nonEmpty(value)) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      terminal(`[ongoing] order has an unparseable delivery date "${value}"`)
    }
    return parsed.toISOString()
  }
  return terminal("[ongoing] order is missing a delivery date")
}

function mapConsignee(address: MapOrderInputAddress | null | undefined): PostOrderConsignee {
  if (!address) {
    terminal("[ongoing] order is missing a shipping address (consignee cannot be built)")
  }
  const name = [trimOrUndefined(address.first_name), trimOrUndefined(address.last_name)]
    .filter(Boolean)
    .join(" ")
  if (!nonEmpty(name)) {
    terminal("[ongoing] shipping address is missing a recipient name")
  }
  if (!nonEmpty(address.country_code)) {
    terminal("[ongoing] shipping address is missing a country code")
  }
  if (!nonEmpty(address.postal_code)) {
    terminal("[ongoing] shipping address is missing a postal code")
  }

  const consignee: PostOrderConsignee = {
    name,
    // ISO-2 lowercase, passed through unchanged.
    countryCode: address.country_code!.trim(),
    postCode: address.postal_code!.trim(),
  }
  const address1 = trimOrUndefined(address.address_1)
  if (address1) {
    consignee.address1 = address1
  }
  const address2 = trimOrUndefined(address.address_2)
  if (address2) {
    consignee.address2 = address2
  }
  const city = trimOrUndefined(address.city)
  if (city) {
    consignee.city = city
  }
  return consignee
}

function mapLine(
  line: MapOrderInputLine,
  index: number,
  orderCurrency: string | undefined
): PostOrderLine {
  const rowNumber = String(index + 1)
  const articleNumber = trimOrUndefined(line.article_number)
  if (!articleNumber) {
    // Article number is resolved upstream by the CALLER (#26/#27) via the #29
    // resolver; this mapper only validates that it is present.
    terminal(`[ongoing] order line ${rowNumber} has no resolvable article number (SKU did not resolve)`)
  }
  const quantity = line.quantity
  if (typeof quantity !== "number" || Number.isNaN(quantity) || quantity <= 0) {
    terminal(`[ongoing] order line ${rowNumber} (article ${articleNumber}) has a non-positive quantity`)
  }

  const mapped: PostOrderLine = {
    rowNumber,
    articleNumber,
    numberOfItems: quantity, // as-is, no conversion
  }
  if (typeof line.weight === "number" && !Number.isNaN(line.weight)) {
    mapped.weight = line.weight
  }

  const currencyCode = (nonEmpty(line.currency_code) ? line.currency_code : orderCurrency)
    ?.trim()
    .toUpperCase()
  const prices: PostOrderLinePrices = {}
  if (typeof line.unit_price === "number" && !Number.isNaN(line.unit_price)) {
    prices.linePrice = line.unit_price // as-is, no x100
  }
  if (currencyCode) {
    prices.currencyCode = currencyCode
  }
  if (Object.keys(prices).length > 0) {
    mapped.prices = prices
  }
  return mapped
}

export function mapOrderToPostOrderModel(input: MapOrderInput): PostOrderModel {
  const orderNumber = trimOrUndefined(input.order_number)
  if (!orderNumber) {
    terminal("[ongoing] order is missing an order number")
  }

  const orderCurrency = nonEmpty(input.currency_code) ? input.currency_code.trim() : undefined

  const model: PostOrderModel = {
    goodsOwnerId: input.goods_owner_id,
    orderNumber,
    deliveryDate: toIsoDeliveryDate(input.delivery_date),
    consignee: mapConsignee(input.shipping_address),
  }

  const lines = input.lines ?? []
  if (lines.length > 0) {
    model.orderLines = lines.map((line, index) => mapLine(line, index, orderCurrency))
  }

  // Notifications (OpenAPI v57): the recipient address goes in `value`, and
  // `toBeNotified: true` opts the order into that channel.
  if (nonEmpty(input.email)) {
    model.emailNotification = { value: input.email.trim(), toBeNotified: true }
  }
  const phone = trimOrUndefined(input.shipping_address?.phone)
  if (phone) {
    model.telephoneNotification = { value: phone, toBeNotified: true }
  }

  // wayOfDelivery / transporter: assigned upstream so Ongoing's transport-system
  // integration can key transport bookings/webhook filters off them (R6). The
  // caller resolves these from the shipping option's data; the mapper only emits
  // a wayOfDelivery when a non-empty code is present.
  const wayCode = trimOrUndefined(input.way_of_delivery?.code)
  if (wayCode) {
    const wayName = trimOrUndefined(input.way_of_delivery?.name)
    model.wayOfDelivery = wayName ? { code: wayCode, name: wayName } : { code: wayCode }
  }
  if (input.transporter && Object.keys(input.transporter).length > 0) {
    model.transporter = input.transporter
  }

  return model
}
