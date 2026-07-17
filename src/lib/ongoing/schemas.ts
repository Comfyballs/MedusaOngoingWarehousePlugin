import { z } from "@medusajs/framework/zod"

// Response shape parsed by mapInventoryRow (src/lib/ongoing/client.ts). Models the
// subset of Ongoing's GetArticleModel (GET /api/v1/articles, OpenAPI v57) we consume:
// articleNumber/articleSystemId at the top level, quantities under `inventoryInfo`
// (GetArticleInventoryInfo — camelCase `sellableNumberOfItems` etc.). The earlier
// `{ article, totalItems }` shape came from a `/articles/inventory` endpoint that does
// not exist in the spec (bead dtw). Counts default to 0 downstream if omitted, so they
// stay optional here; z.object ignores the many other GetArticleModel fields.
// Optional members are .nullish(), not .optional(): Ongoing's API serializes absent
// members as JSON null (observed live — a fresh order returns `"tracking": null`), and
// zod's .optional() rejects null (bead dw5). The mappers already null-guard via ??/?..
export const OngoingInventoryRowResponseSchema = z.object({
  articleNumber: z.string(),
  articleSystemId: z.number(),
  inventoryInfo: z
    .object({
      numberOfItems: z.number().nullish(),
      allocatedNumberOfItems: z.number().nullish(),
      sellableNumberOfItems: z.number().nullish(),
      toReceiveNumberOfItems: z.number().nullish(),
    })
    .nullish(),
})

export type OngoingInventoryRowResponse = z.infer<typeof OngoingInventoryRowResponseSchema>

// Response shape parsed by mapTrackedOrder (src/lib/ongoing/client.ts). Models the
// subset of Ongoing's GetOrderModel (GET /api/v1/orders, OpenAPI v57): orderInfo
// (required — ongoingOrderId/orderNumber/orderStatus flow downstream), plus tracking
// from two spec locations — parcels[].tracking (GetOrderParcelTracking) and the
// order-level tracking[] (GetOrderTracking) — each carrying { waybill, trackingUrl }.
// The earlier parcels[].parcelTracking.code / trackingNumber fields do not exist in the
// spec, so tracking extraction silently produced [] (bead 5vu).
const OngoingTrackingSchema = z.object({
  waybill: z.string().nullish(),
  trackingUrl: z.string().nullish(),
})

export const OngoingTrackedOrderResponseSchema = z.object({
  orderInfo: z.object({
    orderId: z.number(),
    orderNumber: z.string(),
    orderStatus: z.object({
      number: z.number(),
      text: z.string(),
    }),
  }),
  parcels: z
    .array(
      z.object({
        // GetOrderParcel.isReturnParcel — return parcels are excluded from outbound tracking.
        isReturnParcel: z.boolean().nullish(),
        tracking: OngoingTrackingSchema.nullish(),
      })
    )
    .nullish(),
  tracking: z.array(OngoingTrackingSchema).nullish(),
})

export type OngoingTrackedOrderResponse = z.infer<typeof OngoingTrackedOrderResponseSchema>

// Response shape parsed by mapOrderDetail (src/lib/ongoing/client.ts, `getOrder`).
// Models the subset of Ongoing's GetOrderModel (GET /api/v1/orders/{orderId}) needed to
// resolve a return order line's `customerOrderLine.orderLineId`: each order line's own
// internal `id` plus its `article.articleNumber`. Confirmed against the official
// example-requests repo's "Get an order (GET request)" response fixture (live openapi
// unreachable — site in maintenance — while this was built).
export const OngoingOrderDetailResponseSchema = z.object({
  orderInfo: z.object({
    orderId: z.number(),
  }),
  orderLines: z
    .array(
      z.object({
        id: z.number(),
        article: z
          .object({
            articleNumber: z.string(),
          })
          .nullish(),
      })
    )
    .nullish(),
})

export type OngoingOrderDetailResponse = z.infer<typeof OngoingOrderDetailResponseSchema>
