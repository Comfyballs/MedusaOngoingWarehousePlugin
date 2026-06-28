export type OngoingCredentials = {
  key: string
  baseUrl: string
  username: string
  password: string
  goodsOwnerId: number
  webhookSecret?: string
}

export type OngoingPluginOptions = {
  integrations: OngoingCredentials[]
  defaultStockSyncInterval?: string
  defaultStatusPollInterval?: string
  rateLimitConcurrency?: number
}

export interface OngoingInventoryRow {
  articleNumber: string
  articleSystemId?: number
  numberOfItems: number
  allocatedNumberOfItems: number
  sellableNumberOfItems: number
  toReceiveNumberOfItems: number
}

export interface OngoingOrderStatus {
  number: number
  text: string
}

export interface OngoingParcelTracking {
  code?: string
  carrier?: string
  url?: string
}

export interface OngoingTrackedOrder {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
}

// --- Ongoing PostOrderModel (ProcessOrder body, OpenAPI v57) ---
// `additionalProperties: false` on the server: only emit keys defined here.

export interface CodeNamePair {
  code: string
  name?: string
}

export interface PostOrderLinePrices {
  linePrice?: number
  customerLinePrice?: number
  currencyCode?: string
  discountPercentage?: number
  totalVat?: number
}

export interface PostOrderLine {
  rowNumber: string
  articleNumber: string
  numberOfItems?: number
  weight?: number
  prices?: PostOrderLinePrices
}

export interface PostOrderConsignee {
  customerNumber?: string
  name?: string
  address1?: string
  address2?: string
  address3?: string
  postCode?: string
  city?: string
  countryCode?: string
  countryStateCode?: string
  remark?: string
  doorCode?: string
  organisationNumber?: string
  vatNumber?: string
  deliveryInstruction?: string
}

export interface PostOrderTransporter {
  transporterCode?: string
  transporterServiceCode?: string
  paymentAdvanced?: boolean
}

// Notification objects in OpenAPI v57: the recipient address (email / phone
// number) goes in `value`, and `toBeNotified: true` enables the notification.
// (NOT `{ email }` / `{ telephone }` — those keys would violate the schema's
// `additionalProperties: false`.)
export interface PostOrderNotification {
  toBeNotified?: boolean
  value?: string
}

export interface PostOrderModel {
  // Required (exactly 4 top-level required fields).
  goodsOwnerId: number
  orderNumber: string
  deliveryDate: string
  consignee: PostOrderConsignee
  // Optional.
  orderLines?: PostOrderLine[]
  freightPrice?: number
  customerPrice?: number
  wayOfDelivery?: CodeNamePair
  transporter?: PostOrderTransporter
  emailNotification?: PostOrderNotification
  smsNotification?: PostOrderNotification
  telephoneNotification?: PostOrderNotification
}

// --- Mapper input (Medusa-shaped subset hydrated by the push/edit workflows) ---

export interface MapOrderInputAddress {
  first_name?: string | null
  last_name?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  postal_code?: string | null
  // ISO-2, lowercase as Medusa stores it.
  country_code?: string | null
  phone?: string | null
}

export interface MapOrderInputLine {
  // Pre-resolved by the CALLER (#26/#27) via the SKU->articleNumber resolver
  // (issue #29) BEFORE this mapper runs. The mapper never resolves SKUs; it
  // only treats a missing/empty value as a terminal error.
  article_number?: string | null
  quantity?: number | null
  weight?: number | null
  unit_price?: number | null
  currency_code?: string | null
}

export interface MapOrderInput {
  goods_owner_id: number
  order_number: string
  // ISO date-time string or Date; required to form deliveryDate.
  delivery_date?: string | Date | null
  // Order currency; uppercased onto each line's prices.currencyCode.
  currency_code?: string | null
  email?: string | null
  shipping_address?: MapOrderInputAddress | null
  lines: MapOrderInputLine[]
}
