// Provider identity for the Ongoing fulfillment provider.
//
// Re-exported from the provider package (`src/providers/ongoing-fulfillment/
// constants.ts`) so there is a single source of truth: the shipping option this
// workflow seeds must carry a provider_id that resolves to the registered provider,
// and a divergent literal here would silently point it at a nonexistent provider.
import {
  ONGOING_PROVIDER_ID,
  ONGOING_STANDARD_OPTION_ID,
} from "../../providers/ongoing-fulfillment/constants"

export const ONGOING_PROVIDER_IDENTIFIER = ONGOING_PROVIDER_ID
export const ONGOING_FULFILLMENT_OPTION_ID = ONGOING_STANDARD_OPTION_ID

// Seed values — placeholders, clearly flagged so operators edit before go-live.
export const ONGOING_SHIPPING_OPTION_NAME = "Ongoing Fulfillment"

export const ONGOING_SEED_PRICE_AMOUNT = 0

export const ONGOING_SEED_OPTION_TYPE = {
  label: "Ongoing Fulfillment (placeholder)",
  description:
    "Auto-created by the Ongoing plugin. Edit name, price, and carrier before going live.",
  code: "ongoing-fulfillment-placeholder",
}

export const ONGOING_FULFILLMENT_SET_NAME = "Ongoing Fulfillment"
