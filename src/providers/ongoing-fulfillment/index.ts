import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import OngoingFulfillmentProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [OngoingFulfillmentProviderService],
})
