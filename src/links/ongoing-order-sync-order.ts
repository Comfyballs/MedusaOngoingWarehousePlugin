import { defineLink } from "@medusajs/framework/utils"
import OrderModule from "@medusajs/medusa/order"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  OngoingModule.linkable.ongoingOrderSync,
  OrderModule.linkable.order
)
