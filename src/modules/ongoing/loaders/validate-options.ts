import { LoaderOptions } from "@medusajs/framework/types"
import { validateOngoingOptions } from "../options"

export default async function validateOptionsLoader({ options, container }: LoaderOptions) {
  const logger = container.resolve("logger")
  const validated = validateOngoingOptions(options)
  logger.info(`[ongoing] validated ${validated.integrations.length} warehouse integration(s)`)
}
