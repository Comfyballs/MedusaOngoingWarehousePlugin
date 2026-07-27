import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  useQueryGraphStep,
  dismissRemoteLinkStep,
  deleteShippingOptionsStep,
  deleteServiceZonesStep,
  deleteFulfillmentSetsStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import {
  buildCleanupPlan,
  requireIntegrationForCleanup,
  type CleanupPlan,
  type PreservedArtifact,
} from "./helpers"

export type CleanupOngoingLocationInput = {
  integration_id: string
}

export type CleanupOngoingLocationOutput = {
  integration_id: string
  stock_location_id: string | null
  dismissed_link: boolean
  deleted: {
    shipping_option_ids: string[]
    service_zone_ids: string[]
    fulfillment_set_ids: string[]
  }
  preserved: PreservedArtifact[]
}

// pud slice (b): a GUARDED, reusable cleanup of the fulfillment-set / service-zone /
// shipping-option artifacts setupOngoingLocationWorkflow created for an integration.
//
// This workflow is intentionally NOT wired into delete-ongoing-integration by default —
// deleting these artifacts is destructive and the operator must opt in (slice c). It only
// touches artifacts we recorded as created-by-us (pud slice a), and each deletion is guarded:
//   • shipping options still referenced by a live fulfillment are preserved
//   • the service zone is deleted only if it ends up empty
//   • the fulfillment set is deleted only if WE created it (not reused) and ends up empty
// It does NOT delete the OngoingIntegration row itself; that remains the job of
// deleteOngoingIntegrationWorkflow. The returned report lists exactly what was removed and
// what was preserved (with reasons) so the admin action can show it to the operator.
export const cleanupOngoingLocationWorkflow = createWorkflow(
  "cleanup-ongoing-location",
  function (input: CleanupOngoingLocationInput) {
    // (1) load the integration and the artifact ids setup recorded
    const integrationQuery = useQueryGraphStep({
      entity: "ongoing_integration",
      fields: [
        "id",
        "stock_location_id",
        "created_fulfillment_set_id",
        "created_service_zone_id",
        "created_shipping_option_ids",
      ],
      filters: { id: input.integration_id },
    }).config({ name: "query-integration-for-cleanup" })

    const integration = transform({ integrationQuery, input }, (data) =>
      requireIntegrationForCleanup(data.integrationQuery.data[0], data.input.integration_id)
    )

    const createdOptionIds = transform(
      { integration },
      (data) => data.integration.created_shipping_option_ids ?? []
    )
    const createdServiceZoneId = transform(
      { integration },
      (data) => data.integration.created_service_zone_id
    )
    const createdFulfillmentSetId = transform(
      { integration },
      (data) => data.integration.created_fulfillment_set_id
    )
    const hasCreatedOptions = transform(
      { createdOptionIds },
      (data) => data.createdOptionIds.length > 0
    )
    const hasServiceZone = transform(
      { createdServiceZoneId },
      (data) => !!data.createdServiceZoneId
    )
    const hasFulfillmentSet = transform(
      { createdFulfillmentSetId },
      (data) => !!data.createdFulfillmentSetId
    )

    // (2) which of our shipping options are still referenced by a live fulfillment?
    const referencedOptionIds = when(
      { hasCreatedOptions },
      (data) => data.hasCreatedOptions
    ).then(() => {
      const fulfillments = useQueryGraphStep({
        entity: "fulfillment",
        fields: ["id", "shipping_option_id"],
        filters: { shipping_option_id: createdOptionIds },
      }).config({ name: "query-fulfillments-referencing-options" })

      return transform({ fulfillments }, (data) =>
        (data.fulfillments.data ?? [])
          .map((f: { shipping_option_id?: string | null }) => f.shipping_option_id)
          .filter((id: string | null | undefined): id is string => !!id)
      )
    })

    // (3) current contents of our service zone (to decide emptiness)
    const serviceZoneState = when(
      { hasServiceZone },
      (data) => data.hasServiceZone
    ).then(() => {
      const zoneQuery = useQueryGraphStep({
        entity: "service_zone",
        fields: ["id", "shipping_options.id"],
        filters: { id: createdServiceZoneId },
      }).config({ name: "query-created-service-zone" })

      return transform({ zoneQuery }, (data) => {
        const zone = data.zoneQuery.data[0]
        if (!zone) {
          return null
        }
        return {
          id: zone.id as string,
          shippingOptionIds: (zone.shipping_options ?? []).map(
            (o: { id: string }) => o.id
          ),
        }
      })
    })

    // (4) current contents of our fulfillment set (to decide emptiness)
    const fulfillmentSetState = when(
      { hasFulfillmentSet },
      (data) => data.hasFulfillmentSet
    ).then(() => {
      const setQuery = useQueryGraphStep({
        entity: "fulfillment_set",
        fields: ["id", "service_zones.id"],
        filters: { id: createdFulfillmentSetId },
      }).config({ name: "query-created-fulfillment-set" })

      return transform({ setQuery }, (data) => {
        const set = data.setQuery.data[0]
        if (!set) {
          return null
        }
        return {
          id: set.id as string,
          serviceZoneIds: (set.service_zones ?? []).map((z: { id: string }) => z.id),
        }
      })
    })

    // (5) build the guarded deletion plan from the snapshot
    const plan = transform(
      { integration, referencedOptionIds, serviceZoneState, fulfillmentSetState },
      (data): CleanupPlan =>
        buildCleanupPlan(
          {
            created_fulfillment_set_id: data.integration.created_fulfillment_set_id,
            created_service_zone_id: data.integration.created_service_zone_id,
            created_shipping_option_ids: data.integration.created_shipping_option_ids,
          },
          {
            referencedShippingOptionIds: data.referencedOptionIds ?? [],
            serviceZone: data.serviceZoneState ?? null,
            fulfillmentSet: data.fulfillmentSetState ?? null,
          }
        )
    )

    // (6) dismiss the stock_location <-> integration link (when a location is bound)
    const dismissedLink = when(
      { integration },
      (data) => !!data.integration.stock_location_id
    ).then(() => {
      dismissRemoteLinkStep(
        transform({ integration }, (data) => [
          {
            [Modules.STOCK_LOCATION]: {
              stock_location_id: data.integration.stock_location_id as string,
            },
            [ONGOING_MODULE]: {
              ongoing_integration_id: data.integration.id,
            },
          },
        ])
      )
      return transform({}, () => true)
    })

    // (7) delete artifacts per the plan — each guarded on a non-empty target list
    when({ plan }, (data) => data.plan.shipping_option_ids_to_delete.length > 0).then(() => {
      deleteShippingOptionsStep(
        transform({ plan }, (data) => data.plan.shipping_option_ids_to_delete)
      )
    })

    when({ plan }, (data) => data.plan.service_zone_ids_to_delete.length > 0).then(() => {
      deleteServiceZonesStep(
        transform({ plan }, (data) => data.plan.service_zone_ids_to_delete)
      )
    })

    when({ plan }, (data) => data.plan.fulfillment_set_ids_to_delete.length > 0).then(() => {
      deleteFulfillmentSetsStep(
        transform({ plan }, (data) => data.plan.fulfillment_set_ids_to_delete)
      )
    })

    return new WorkflowResponse(
      transform(
        { input, integration, plan, dismissedLink },
        (data): CleanupOngoingLocationOutput => ({
          integration_id: data.input.integration_id,
          stock_location_id: data.integration.stock_location_id,
          dismissed_link: data.dismissedLink === true,
          deleted: {
            shipping_option_ids: data.plan.shipping_option_ids_to_delete,
            service_zone_ids: data.plan.service_zone_ids_to_delete,
            fulfillment_set_ids: data.plan.fulfillment_set_ids_to_delete,
          },
          preserved: data.plan.preserved,
        })
      )
    )
  }
)

export default cleanupOngoingLocationWorkflow
