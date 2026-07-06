import { z } from "zod"

// Response shape parsed by mapInventoryRow (src/lib/ongoing/client.ts). Fields that
// the downstream OngoingInventoryRow requires (articleNumber, articleSystemId) are
// required in the schema; counts default to 0 downstream if omitted, so they stay
// optional here.
export const OngoingInventoryRowResponseSchema = z.object({
  article: z.object({
    articleNumber: z.string(),
    articleSystemId: z.number(),
  }),
  totalItems: z
    .object({
      NumberOfItemsDecimal: z.number().optional(),
      AllocatedNumberOfItems: z.number().optional(),
      SellableNumberOfItems: z.number().optional(),
      ToReceiveNumberOfItems: z.number().optional(),
    })
    .optional(),
})

export type OngoingInventoryRowResponse = z.infer<typeof OngoingInventoryRowResponseSchema>

// Response shape parsed by mapTrackedOrder (src/lib/ongoing/client.ts). Downstream
// OngoingTrackedOrder requires ongoingOrderId (number), orderNumber (string), and
// orderStatus.{number,text} — those are required here; parcels + inner trackingNumber
// alternates stay optional (mapTrackedOrder already handles their absence).
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
        parcelTracking: z.object({ code: z.string().optional() }).optional(),
        trackingNumber: z.string().optional(),
      })
    )
    .optional(),
})

export type OngoingTrackedOrderResponse = z.infer<typeof OngoingTrackedOrderResponseSchema>
