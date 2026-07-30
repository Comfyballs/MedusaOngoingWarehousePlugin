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
  // Ongoing status code above which an order counts as done: the status poll syncs it
  // once at that code and then skips it (default 450 — see status-semantics.ts).
  defaultDoneStatusThreshold?: number
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

// A single shipment tracking reference (waybill + optional carrier tracking URL),
// as extracted from an Ongoing order's parcels[].tracking and top-level tracking[]
// (OpenAPI v57: GetOrderParcelTracking / GetOrderTracking { waybill, trackingUrl }).
export interface OngoingTrackingRef {
  number: string
  url?: string
}

export interface OngoingTrackedOrder {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  // Waybills only, kept for existing consumers (logging / SHIPMENT_APPLIED event).
  trackingNumbers: string[]
  // Waybill + trackingUrl pairs, so shipment labels can carry the real carrier URL.
  tracking: OngoingTrackingRef[]
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

// --- Ongoing PostArticleModel (ProcessArticle body, PUT /api/v1/articles) ---
// Step 1 of Ongoing's webshop flow. Upsert by articleNumber. Minimal shape;
// extend against the ProcessArticle schema (verify live per ym3) if richer
// article data (dimensions, extra codes) is synced later.
export interface PostArticleModel {
  goodsOwnerId: number
  articleNumber: string
  articleName: string
  barCode?: string
  productCode?: string
  weight?: number
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
  // Optional Ongoing carrier assignment, resolved by the CALLER from the
  // fulfillment's shipping_option.data (see lib/ongoing/way-of-delivery.ts). A
  // missing value maps to no wayOfDelivery/transporter — warehouse staff pick the
  // carrier manually.
  way_of_delivery?: CodeNamePair | null
  transporter?: PostOrderTransporter | null
}

// --- Inbound webhook payload (Ongoing -> POST /ongoing/webhooks/:credentialKey) ---
// Auth is a static X-Auth-Token header compared against webhookSecret (NOT HMAC;
// see plan 2026-06-30-webhook-route-35.md). These fields are the subset the route
// parses/validates and that #36's syncOngoingShipment consumes.

export interface WebhookOrderStatus {
  number: number
  text?: string
}

export interface WebhookOrderTracking {
  trackingUrl?: string
  waybill?: string
  isReturn?: boolean
}

export interface WebhookOrderParcelTracking {
  trackingUrl?: string
}

export interface WebhookOrderParcel {
  id?: number
  parcelNumber?: string
  isReturnParcel?: boolean
  tracking?: WebhookOrderParcelTracking
}

export interface WebhookOrderPayload {
  webhookOrdersId?: number
  webhookEventId?: number
  orderId?: number
  orderNumber?: string
  // Our client reference (= ongoing_order_number / goodsOwnerOrderId).
  goodsOwnerOrderId?: string
  goodsOwnerId: number
  orderStatus: WebhookOrderStatus
  tracking?: WebhookOrderTracking[]
  parcels?: WebhookOrderParcel[]
  // ISO-8601 with 7 fractional digits, e.g. "2026-06-30T12:00:00.0000000Z".
  timestamp?: string
}

// --- Ongoing PostReturnOrderModel (ProcessReturnOrder body, PUT /api/v1/returnOrders) ---
// Confirmed against the official Ongoing "REST API Example Requests" Postman collection
// (github.com/OngoingWarehouse/Ongoing-Warehouse-REST-API-Example-Requests, "Return
// orders" > "Create or update a return order") — the live openapi.json was unreachable
// (site in maintenance) while this was built, so field OPTIONALITY beyond the example's
// shape is unverified; only the fields shown in that example are treated as certain.

export interface PostReturnOrderCustomerOrderRef {
  // Ongoing's own internal numeric order id (orderInfo.orderId from GET /orders/{id}),
  // NOT the goodsOwnerOrderId/orderNumber string.
  orderId: number
}

export interface PostReturnOrderCustomerOrderLineRef {
  // Ongoing's own internal numeric order LINE id (orderLines[].id from GET
  // /orders/{id}), NOT our client-assigned PostOrderLine.rowNumber.
  orderLineId: number
}

export interface PostReturnOrderReturnCause {
  code: string
  name?: string
}

export interface PostReturnOrderLine {
  returnOrderRowNumber: string
  customerOrderLine: PostReturnOrderCustomerOrderLineRef
  toBeReturnedNumberOfItems: number
  returnCause?: PostReturnOrderReturnCause
}

export interface PostReturnOrderModel {
  goodsOwnerId: number
  returnOrderNumber: string
  customerOrder: PostReturnOrderCustomerOrderRef
  // Date-only string, e.g. "2026-07-17" (per the confirmed example — NOT a full
  // ISO datetime like PostOrderModel.deliveryDate).
  inDate: string
  comment?: string
  returnOrderLines?: PostReturnOrderLine[]
}

// --- Ongoing GetOrderModel subset (GET /api/v1/orders/{orderId}) ---
// Confirmed against the official example repo's
// "Order/Get an order (GET request)/GET response - order with many fields.js" fixture.
// Used to resolve the original order's internal Ongoing orderLineId per articleNumber
// so a return order line can reference `customerOrderLine.orderLineId`.

export interface OngoingOrderLineDetail {
  // orderLines[].id in the raw response — Ongoing's internal order-line id.
  orderLineId: number
  articleNumber: string
}

export interface OngoingOrderDetail {
  ongoingOrderId: number
  lines: OngoingOrderLineDetail[]
}

// --- Mapper input (Medusa-shaped subset hydrated by the return-push workflow) ---

export interface MapReturnOrderInputLine {
  // Pre-resolved by the CALLER via the SKU->articleNumber resolver, matching the
  // outbound MapOrderInputLine convention.
  article_number?: string | null
  quantity?: number | null
}

export interface MapReturnOrderInput {
  goods_owner_id: number
  return_order_number: string
  // Ongoing's internal numeric id for the ORIGINAL outbound order this return
  // belongs to (OngoingOrderSync.ongoing_order_id).
  ongoing_order_id: number
  // Date-only string (see PostReturnOrderModel.inDate).
  in_date: string
  comment?: string | null
  lines: MapReturnOrderInputLine[]
  // The original order's Ongoing order lines, fetched fresh via `getOrder`, used to
  // resolve each return line's `customerOrderLine.orderLineId` by matching
  // articleNumber. Each original line is consumed at most once so two return lines
  // for the same articleNumber map to two distinct original order lines when the
  // original order had duplicate article numbers across rows.
  original_order_lines: OngoingOrderLineDetail[]
}

// --- Ongoing integration settings enums (admin CRUD + workflows; #40) ---

export const STOCK_RECONCILE_MODES = ["sellable_plus_reserved", "precise", "onhand"] as const
export type StockReconcileMode = (typeof STOCK_RECONCILE_MODES)[number]
