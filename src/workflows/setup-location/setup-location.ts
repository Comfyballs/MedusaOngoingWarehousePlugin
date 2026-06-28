import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createLocationFulfillmentSetWorkflow,
  createServiceZonesWorkflow,
  createShippingOptionsWorkflow,
  createRemoteLinkStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import {
  ONGOING_PROVIDER_IDENTIFIER,
  ONGOING_FULFILLMENT_OPTION_ID,
  ONGOING_FULFILLMENT_SET_NAME,
} from "./constants"
import {
  composeProviderId,
  decideReuse,
  extractFulfillmentSetId,
  buildServiceZoneInput,
  buildShippingOptionInput,
  FulfillmentSetMode,
} from "./helpers"
import { upsertIntegrationLocationStep } from "./steps/upsert-integration-location"

export type SetupOngoingLocationInput = {
  integration_id: string
  stock_location_id: string
  // Override for the fulfillment-set decision (future admin control of issue #30's
  // create-new-vs-link-to-existing question). Default "auto" = reuse-if-exists.
  fulfillment_set_mode?: FulfillmentSetMode
}

export const setupOngoingLocationWorkflow = createWorkflow(
  "setup-ongoing-location",
  function (input: SetupOngoingLocationInput) {
    // (1) detect existing fulfillment binding + the location's country
    const existing = useQueryGraphStep({
      entity: "stock_location",
      fields: [
        "id",
        "address.country_code",
        "fulfillment_sets.id",
        "fulfillment_sets.service_zones.id",
        "fulfillment_sets.service_zones.shipping_options.id",
        "fulfillment_sets.service_zones.shipping_options.provider_id",
      ],
      filters: { id: input.stock_location_id },
    }).config({ name: "query-existing-location" })

    // honor the optional override flag; default "auto" = reuse-if-exists
    const reuseDecision = transform({ existing, input }, (data) =>
      decideReuse(data.existing.data[0], data.input.fulfillment_set_mode ?? "auto")
    )

    // precompute the create gate as a plain boolean so when() reads no flag logic
    const shouldCreate = transform(
      { reuseDecision },
      (data) => data.reuseDecision.reuse === false
    )

    const countryCode = transform({ existing }, (data) =>
      data.existing.data[0].address.country_code
    )

    // (2) create the fulfillment set only when the decision says so
    //     ("create" mode forces this even if a set already exists)
    const created = when({ shouldCreate }, (data) => data.shouldCreate).then(() => {
      createLocationFulfillmentSetWorkflow.runAsStep({
        input: transform({ input }, (data) => ({
          location_id: data.input.stock_location_id,
          fulfillment_set_data: {
            name: ONGOING_FULFILLMENT_SET_NAME,
            type: "shipping",
          },
        })),
      })

      // re-query to read back the created set id (the create returns `unknown`)
      const requeried = useQueryGraphStep({
        entity: "stock_location",
        fields: ["id", "fulfillment_sets.id"],
        filters: { id: input.stock_location_id },
      }).config({ name: "query-created-fulfillment-set" })

      return transform({ requeried }, (data) =>
        extractFulfillmentSetId(data.requeried.data[0])
      )
    })

    // (3) effective fulfillment set id: existing (reused) or newly created
    const fulfillmentSetId = transform({ reuseDecision, created }, (data) => {
      if (data.reuseDecision.reuse === true) {
        return data.reuseDecision.fulfillmentSetId as string
      }
      return data.created as string
    })

    // (4) default shipping profile
    const profiles = useQueryGraphStep({
      entity: "shipping_profile",
      fields: ["id"],
      filters: { type: "default" },
    }).config({ name: "query-default-shipping-profile" })

    const shippingProfileId = transform({ profiles }, (data) => data.profiles.data[0].id)

    // (5) service zone scoped to the location country
    const serviceZones = createServiceZonesWorkflow.runAsStep({
      input: transform({ fulfillmentSetId, countryCode }, (data) =>
        buildServiceZoneInput({
          fulfillmentSetId: data.fulfillmentSetId,
          countryCode: data.countryCode,
        })
      ),
    })

    const serviceZoneId = transform({ serviceZones }, (data) => data.serviceZones[0].id)

    // (6) shipping option pointing at the Ongoing provider
    const providerId = transform({}, () =>
      composeProviderId(ONGOING_PROVIDER_IDENTIFIER, ONGOING_FULFILLMENT_OPTION_ID)
    )

    // store default currency for the seeded flat price
    const stores = useQueryGraphStep({
      entity: "store",
      fields: ["id", "supported_currencies.currency_code", "supported_currencies.is_default"],
    }).config({ name: "query-store-currency" })

    const currencyCode = transform({ stores }, (data) => {
      const currencies = data.stores.data[0].supported_currencies || []
      const def = currencies.find((c: { is_default?: boolean }) => c.is_default === true)
      if (def) {
        return def.currency_code
      }
      return currencies[0].currency_code
    })

    const shippingOptions = createShippingOptionsWorkflow.runAsStep({
      input: transform(
        { serviceZoneId, shippingProfileId, providerId, currencyCode },
        (data) =>
          buildShippingOptionInput({
            serviceZoneId: data.serviceZoneId,
            shippingProfileId: data.shippingProfileId,
            providerId: data.providerId,
            currencyCode: data.currencyCode,
          })
      ),
    })

    const shippingOptionIds = transform({ shippingOptions }, (data) =>
      data.shippingOptions.map((o: { id: string }) => o.id)
    )

    // (7) write the unique stock_location_id column on the integration
    upsertIntegrationLocationStep({
      integration_id: input.integration_id,
      stock_location_id: input.stock_location_id,
    })

    // (8) create the OngoingIntegration <-> stock_location link (stock_location FIRST)
    createRemoteLinkStep(
      transform({ input }, (data) => [
        {
          [Modules.STOCK_LOCATION]: {
            stock_location_id: data.input.stock_location_id,
          },
          [ONGOING_MODULE]: {
            ongoing_integration_id: data.input.integration_id,
          },
        },
      ])
    )

    // (9) surface what was created
    return new WorkflowResponse(
      transform(
        {
          input,
          fulfillmentSetId,
          serviceZoneId,
          shippingOptionIds,
          reuseDecision,
        },
        (data) => ({
          integration_id: data.input.integration_id,
          stock_location_id: data.input.stock_location_id,
          fulfillment_set_id: data.fulfillmentSetId,
          service_zone_id: data.serviceZoneId,
          shipping_option_ids: data.shippingOptionIds,
          reused: data.reuseDecision.reuse,
        })
      )
    )
  }
)

export default setupOngoingLocationWorkflow
