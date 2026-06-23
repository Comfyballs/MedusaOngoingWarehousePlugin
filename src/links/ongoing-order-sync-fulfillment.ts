import { defineLink } from "@medusajs/framework/utils"
import FulfillmentModule from "@medusajs/medusa/fulfillment"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  OngoingModule.linkable.ongoingOrderSync,
  FulfillmentModule.linkable.fulfillment
)
