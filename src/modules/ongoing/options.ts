import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

const REQUIRED: (keyof OngoingCredentials)[] = ["key", "baseUrl", "username", "password", "goodsOwnerId"]

export function validateOngoingOptions(options: unknown): OngoingPluginOptions {
  const opts = options as Partial<OngoingPluginOptions> | undefined
  if (!opts || !Array.isArray(opts.integrations)) {
    throw new Error("[ongoing] plugin options must include an `integrations` array")
  }

  const seen = new Set<string>()
  for (const integration of opts.integrations) {
    const key = (integration as Partial<OngoingCredentials>)?.key ?? "<missing key>"
    for (const field of REQUIRED) {
      if (integration[field] === undefined || integration[field] === null || integration[field] === "") {
        throw new Error(`[ongoing] integration "${key}" is missing required option "${field}"`)
      }
    }
    if (seen.has(integration.key)) {
      throw new Error(`[ongoing] duplicate credential key "${integration.key}" in integrations`)
    }
    seen.add(integration.key)
  }

  return opts as OngoingPluginOptions
}
