import { defineLink } from "@medusajs/framework/utils"
import StockLocationModule from "@medusajs/medusa/stock-location"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  StockLocationModule.linkable.stockLocation,
  {
    linkable: OngoingModule.linkable.ongoingIntegration,
    deleteCascade: true,
  }
)
