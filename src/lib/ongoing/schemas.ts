import { z } from "@medusajs/framework/zod"

// Response shape parsed by mapInventoryRow (src/lib/ongoing/client.ts). Models the
// subset of Ongoing's GetArticleModel (GET /api/v1/articles, OpenAPI v57) we consume:
// articleNumber/articleSystemId at the top level, quantities under `inventoryInfo`
// (GetArticleInventoryInfo — camelCase `sellableNumberOfItems` etc.). The earlier
// `{ article, totalItems }` shape came from a `/articles/inventory` endpoint that does
// not exist in the spec (bead dtw). Counts default to 0 downstream if omitted, so they
// stay optional here; z.object ignores the many other GetArticleModel fields.
export const OngoingInventoryRowResponseSchema = z.object({
  articleNumber: z.string(),
  articleSystemId: z.number(),
  inventoryInfo: z
    .object({
      numberOfItems: z.number().optional(),
      allocatedNumberOfItems: z.number().optional(),
      sellableNumberOfItems: z.number().optional(),
      toReceiveNumberOfItems: z.number().optional(),
    })
    .optional(),
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
  waybill: z.string().optional(),
  trackingUrl: z.string().optional(),
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
        tracking: OngoingTrackingSchema.optional(),
      })
    )
    .optional(),
  tracking: z.array(OngoingTrackingSchema).optional(),
})

export type OngoingTrackedOrderResponse = z.infer<typeof OngoingTrackedOrderResponseSchema>
