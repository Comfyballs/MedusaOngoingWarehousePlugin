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

  // rateLimitConcurrency feeds `new Throttle(concurrency)`, which throws on < 1 at
  // first client use (mid-request/mid-job). Surface a misconfig at boot instead.
  if (opts.rateLimitConcurrency !== undefined) {
    const concurrency = opts.rateLimitConcurrency
    if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] rateLimitConcurrency must be an integer >= 1 (received ${JSON.stringify(concurrency)})`
      )
    }
  }

  // Interval options parse to milliseconds via parseInt at read time; a non-numeric
  // value silently yields NaN (poll fires once then never again). Reject at boot.
  validateIntervalOption(opts.defaultStatusPollInterval, "defaultStatusPollInterval")
  validateIntervalOption(opts.defaultStockSyncInterval, "defaultStockSyncInterval")

  return opts as OngoingPluginOptions
}

function validateIntervalOption(value: string | undefined, name: string): void {
  if (value === undefined) {
    return
  }
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `[ongoing] ${name} must be a positive integer number of milliseconds (received ${JSON.stringify(value)})`
    )
  }
}
