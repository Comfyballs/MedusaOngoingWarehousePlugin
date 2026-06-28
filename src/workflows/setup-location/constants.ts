// Provider identity for the Ongoing fulfillment provider.
//
// NOTE (issue #20 coordination): the canonical source for these two values is the
// provider package's `src/providers/ongoing-fulfillment/constants.ts`, which is
// owned by issue #20 and not yet merged. To avoid blocking this workflow and to
// avoid a merge conflict on a sibling branch, they are defined locally here. The
// literals MUST stay identical to #20's `ONGOING_PROVIDER_ID` /
// `ONGOING_STANDARD_OPTION_ID`. Once #20 lands, switch these to a re-export from
// the provider package so there is a single source of truth.
export const ONGOING_PROVIDER_IDENTIFIER = "ongoing"
export const ONGOING_FULFILLMENT_OPTION_ID = "ongoing-standard"

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
