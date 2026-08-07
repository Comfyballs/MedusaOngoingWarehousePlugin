import { LoaderOptions } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { validateOngoingOptions } from "../options"
import buildInfo from "../build-info"

export default async function validateOptionsLoader({ options, container }: LoaderOptions) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const validated = validateOngoingOptions(options)
  logger.info(
    `[ongoing] validated ${validated.integrations.length} warehouse integration(s) (build ${buildInfo.id})`
  )
}
