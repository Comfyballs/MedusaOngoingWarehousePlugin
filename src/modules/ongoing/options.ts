import { MedusaError } from "@medusajs/framework/utils"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

const REQUIRED: (keyof OngoingCredentials)[] = ["key", "baseUrl", "username", "password", "goodsOwnerId"]

export function validateOngoingOptions(options: unknown): OngoingPluginOptions {
  const opts = options as Partial<OngoingPluginOptions> | undefined
  if (!opts || !Array.isArray(opts.integrations)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] plugin options must include an `integrations` array"
    )
  }

  const seen = new Set<string>()
  for (const integration of opts.integrations) {
    const key = (integration as Partial<OngoingCredentials>)?.key ?? "<missing key>"
    for (const field of REQUIRED) {
      if (integration[field] === undefined || integration[field] === null || integration[field] === "") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `[ongoing] integration "${key}" is missing required option "${field}"`
        )
      }
    }
    if (seen.has(integration.key)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] duplicate credential key "${integration.key}" in integrations`
      )
    }
    seen.add(integration.key)
  }

  return opts as OngoingPluginOptions
}
