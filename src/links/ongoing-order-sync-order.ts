import { defineLink } from "@medusajs/framework/utils"
import OrderModule from "@medusajs/medusa/order"
import OngoingModule from "../modules/ongoing"

// 607: one Medusa order owns MANY ongoing_order_sync rows (per-fulfillment push
// rows plus return rows, all sharing one medusa_order_id). Mark the sync side
// isList so a query.graph join from `order` returns the full list instead of a
// single/ambiguous row. The fulfillment link stays 1:1 (one sync per fulfillment).
export default defineLink(
  {
    linkable: OngoingModule.linkable.ongoingOrderSync,
    isList: true,
  },
  OrderModule.linkable.order
)
