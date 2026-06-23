import { Module } from "@medusajs/framework/utils"
import OngoingModuleService from "./service"
import validateOptionsLoader from "./loaders/validate-options"

export const ONGOING_MODULE = "ongoing"

export default Module(ONGOING_MODULE, {
  service: OngoingModuleService,
  loaders: [validateOptionsLoader],
})
