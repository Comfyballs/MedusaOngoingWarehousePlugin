import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
import type {
  CreateShippingOptionDTO,
  FulfillmentOption,
  Logger,
  MedusaContainer,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import {
  ONGOING_FULFILLMENT_OPTIONS,
  ONGOING_PROVIDER_ID,
  ONGOING_RETURN_OPTION_ID,
  ONGOING_STANDARD_OPTION_ID,
} from "./constants"
import { cancelOngoingOrderWorkflow, pushOrderToOngoing, pushReturnOrderToOngoing } from "../../workflows"
import { assertValidOngoingCarrierConfig } from "../../lib/ongoing/way-of-delivery"

/**
 * Shape `createFulfillment` (#21) stashes as the fulfillment `data`. Medusa hands
 * this object (and nothing else) back to `cancelFulfillment`, so every identifier
 * cancellation needs must be read out of it.
 */
export type OngoingFulfillmentData = {
  ongoing_order_number?: string
  ongoing_order_id?: number
  location_id?: string
  credential_key?: string
  medusa_order_id?: string
  medusa_fulfillment_id?: string
}

const KNOWN_OPTION_IDS = new Set<string>([
  ONGOING_STANDARD_OPTION_ID,
  ONGOING_RETURN_OPTION_ID,
])

/**
 * Ongoing Warehouse fulfillment provider.
 *
 * This issue (#20) scaffolds the class and the shipping-option lifecycle:
 * getFulfillmentOptions / validateOption / validateFulfillmentData / canCalculate.
 * Order creation (#21), cancellation (#22), and return/document stubs (#23) are
 * deliberately left on the throwing AbstractFulfillmentProviderService base so they
 * slot in without restructuring this class.
 */
class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = ONGOING_PROVIDER_ID

  // The Medusa container (cradle) is captured so createFulfillment (#21) and
  // cancelFulfillment (#22) can resolve the 'ongoing' module and run workflows
  // via this.container_. Do not drop this field.
  protected readonly container_: MedusaContainer
  protected readonly logger_: Logger
  protected readonly options_: Record<string, unknown>

  constructor(container: MedusaContainer, options?: Record<string, unknown>) {
    // AbstractFulfillmentProviderService's constructor takes no arguments in 2.16.0.
    super()
    this.container_ = container
    // `logger` is registered on the module's container (awilix cradle) and is
    // resolvable as a property at runtime; MedusaContainer doesn't type it, so cast.
    this.logger_ = (container as unknown as { logger: Logger }).logger
    this.options_ = options ?? {}
  }

  /**
   * One global option list (the method takes no args, so it cannot be
   * warehouse-specific — known limitation, spec §5/§13.4).
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return ONGOING_FULFILLMENT_OPTIONS
  }

  /**
   * Base implementation throws; overriding it is what lets admins create
   * shipping options for this provider. Accept only ids we advertise.
   */
  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return typeof data?.id === "string" && KNOWN_OPTION_IDS.has(data.id)
  }

  /**
   * Return value is stored as the shipping method's `data` (passed through
   * unchanged, mirroring the manual provider). This is also the config-time seam
   * (R6) that validates the optional Ongoing carrier config an admin sets on the
   * shipping option's `data` (`way_of_delivery` / `transporter`): a malformed
   * value fails here at shipping-option creation instead of being silently
   * dropped at order-push time. The value actually mapped into the Ongoing order
   * is read at push time from the persisted `shipping_option.data`
   * (query-fulfillment-order → order-mapper), which is durable across retries.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    assertValidOngoingCarrierConfig(optionData)
    return data
  }

  /** Ongoing rates are flat in this plugin → no calculated rates. */
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false
  }

  /**
   * Create the Ongoing order behind a freshly-created Medusa fulfillment.
   *
   * Medusa's fulfillment module-service calls this with the persisted fulfillment
   * row as the 4th arg (minus `provider_id`/`data`/`items`), so `fulfillment.id`
   * and `fulfillment.location_id` are hydrated — `location_id` is a non-nullable
   * column on the fulfillment model and the upstream create-fulfillment workflow
   * always resolves it. We still guard defensively (the DTO type is `Partial`):
   * a missing `location_id` throws a terminal error, which makes the module-service
   * delete the just-created fulfillment and surface a clean failure rather than
   * guessing a warehouse.
   *
   * The integration is resolved here ONLY to obtain `credential_key` for the
   * returned stash; the `pushOrderToOngoing` workflow (#26) re-queries the full
   * order and re-derives its own integration context from the fulfillment id. The
   * push runs synchronously so a failure aborts fulfillment creation.
   *
   * The returned `data` is persisted onto the fulfillment row and is the ONLY
   * thing `cancelFulfillment` (#22) later receives — hence `credential_key` and
   * `ongoing_order_number` must be stashed.
   */
  async createFulfillment(
    _data: Record<string, unknown>,
    _items: unknown[],
    _order: unknown,
    fulfillment: { id?: string; location_id?: string }
  ): Promise<{ data: Record<string, unknown>; labels: [] }> {
    const fulfillmentId = fulfillment?.id
    const locationId = fulfillment?.location_id

    // fulfillment.id is the only input the push workflow needs to re-query the
    // order; without it there is nothing to push. Guard before anything else so
    // the workflow is never invoked with an undefined id.
    if (!fulfillmentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot push to Ongoing: fulfillment.id is missing from the createFulfillment payload.`
      )
    }

    if (!locationId) {
      // Log once so a dev fulfillment surfaces any 2.16.0 hydration surprise.
      this.logger_?.warn(
        `[ongoing] createFulfillment received fulfillment ${fulfillmentId} without a location_id; refusing to guess a warehouse.`
      )
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot push fulfillment ${fulfillmentId} to Ongoing: ` +
          `fulfillment.location_id is missing. Refusing to guess a warehouse.`
      )
    }

    const ongoingService = this.container_.resolve("ongoing") as {
      getIntegrationByLocation: (
        locationId: string
      ) => Promise<{ credential_key: string } | undefined>
    }

    const integration = await ongoingService.getIntegrationByLocation(locationId)
    if (!integration) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `[ongoing] no enabled Ongoing integration is bound to stock location "${locationId}"; ` +
          `cannot push fulfillment ${fulfillmentId}.`
      )
    }

    // credential_key is captured here ONLY for the returned stash; the workflow
    // re-derives its own integration context from the fulfillment id.
    const credentialKey = integration.credential_key

    const { result } = await pushOrderToOngoing(this.container_).run({
      input: { fulfillment_id: fulfillmentId },
    })

    return {
      data: {
        ongoing_order_number: result.orderNumber,
        ongoing_order_id: result.ongoingOrderId,
        location_id: locationId,
        credential_key: credentialKey,
      },
      labels: [],
    }
  }

  /**
   * Create the Ongoing return order (PUT /returnOrders) behind a freshly-created
   * Medusa return fulfillment.
   *
   * Medusa's `FulfillmentModuleService.createReturnFulfillment` creates the return
   * fulfillment row FIRST, then calls this method with `{ ...fulfillment,
   * shipping_option }` — so `fromData.id` is hydrated, but (unlike the outbound
   * `createFulfillment`) there is no `order`/`order_id` on it: the core method
   * destructures `order` out before persisting, and links the return fulfillment to
   * the order only indirectly via `order_return.fulfillment_id`. So, mirroring
   * `createFulfillment`'s "resolve everything fresh from the id" pattern, only
   * `fromData.id` is trusted here — `pushReturnOrderToOngoing` (#new) re-queries the
   * return fulfillment's items/location fresh and resolves the original order (and
   * its already-synced Ongoing order) from one of those items' `line_item_id`.
   *
   * Runs synchronously so a failure aborts return-fulfillment creation, matching
   * `createFulfillment`: `FulfillmentModuleService.createReturnFulfillment` deletes
   * the just-created return fulfillment row on any provider throw.
   *
   * The returned `data` is persisted onto the return fulfillment row. There is no
   * `cancelReturnFulfillment` counterpart in Medusa 2.16.0 (its compensation TODO
   * falls back to `cancelFulfillment`), so nothing downstream currently reads this
   * stash back — it exists for operator visibility (fulfillment detail / audit).
   */
  async createReturnFulfillment(
    fromData: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown>; labels: never[] }> {
    const returnFulfillmentId = typeof fromData?.id === "string" ? fromData.id : undefined

    if (!returnFulfillmentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot push return to Ongoing: return fulfillment.id is missing from the createReturnFulfillment payload.`
      )
    }

    const { result } = await pushReturnOrderToOngoing(this.container_).run({
      input: { return_fulfillment_id: returnFulfillmentId },
    })

    return {
      data: {
        ongoing_return_order_number: result.returnOrderNumber,
        ongoing_return_order_id: result.ongoingReturnOrderId,
        medusa_return_fulfillment_id: returnFulfillmentId,
      },
      labels: [],
    }
  }

  /**
   * Extension point — fulfillment document retrieval.
   *
   * Label / document retrieval is out of scope for now (design §1). The base
   * returns `[]` and does NOT throw, so this override is optional; it is added
   * explicitly to mark a discoverable extension point. The sibling
   * `getReturnDocuments` and `getShipmentDocuments` methods also default to
   * `[]` on the base class and are related extension points to implement when
   * document retrieval comes into scope.
   */
  async getFulfillmentDocuments(
    _data: Record<string, unknown>
  ): Promise<never[]> {
    return []
  }

  /**
   * Cancel the Ongoing order behind a fulfillment.
   *
   * Medusa's fulfillment module-service calls
   * `provider.cancelFulfillment(provider_id, fulfillment.data ?? {})`, so this
   * method receives ONLY the stashed `data` — no fulfillment row, items, or
   * location argument. It reads the order identifiers out of `data` and runs the
   * idempotent `cancelOngoingOrderWorkflow` (#28); all cancellation gating and
   * already-cancelled handling lives in that workflow. This method resolves
   * (never throws) on a genuine no-op decision reason — `already_cancelled`,
   * `no_sync_row`, `no_ongoing_order_id`, or a missing identifier — because none
   * of those describe a real Ongoing order that is still shipping. It THROWS a
   * `MedusaError(NOT_ALLOWED)` for `status_not_cancellable` (#109): that reason
   * means the `OngoingOrderSync` row AND the Ongoing order both exist and
   * Ongoing's own status says it can no longer be cancelled there, so this
   * method must NOT resolve — Medusa's core `FulfillmentModuleService
   * .cancelFulfillment` (verified against `@medusajs/fulfillment` 2.16.0,
   * `fulfillment-module-service.js:711-728`) only inspects throw/no-throw and
   * unconditionally sets `fulfillment.canceled_at` on any non-throwing return.
   * It also lets genuine retryable failures propagate so Medusa can surface a
   * retry. Converges safely with the `order.canceled` subscriber (#32) because
   * that subscriber calls `cancelOngoingOrderWorkflow` directly (not through
   * this method) and already never throws out of its own per-row try/catch —
   * this method's new throw does not change that call site (#109).
   */
  async cancelFulfillment(
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const stashed = (data ?? {}) as OngoingFulfillmentData

    const ongoingOrderNumber =
      typeof stashed.ongoing_order_number === "string"
        ? stashed.ongoing_order_number
        : undefined
    const medusaFulfillmentId =
      typeof stashed.medusa_fulfillment_id === "string"
        ? stashed.medusa_fulfillment_id
        : undefined
    const medusaOrderId =
      typeof stashed.medusa_order_id === "string"
        ? stashed.medusa_order_id
        : undefined

    const container = this.container_

    // Idempotent no-op: nothing in `data` lets us locate an OngoingOrderSync row.
    if (!ongoingOrderNumber && !medusaFulfillmentId && !medusaOrderId) {
      if (typeof stashed.location_id === "string") {
        // Diagnostic lookup only; never throws.
        try {
          const ongoing = container.resolve("ongoing") as {
            getIntegrationByLocation: (id: string) => Promise<unknown>
          }
          await ongoing.getIntegrationByLocation(stashed.location_id)
        } catch {
          // swallow — this is purely a diagnostic lookup
        }
      }
      return { ...data, canceled: false, reason: "no_identifier" }
    }

    const input: Record<string, string> = {}
    if (ongoingOrderNumber) {
      input.ongoing_order_number = ongoingOrderNumber
    }
    if (medusaFulfillmentId) {
      input.medusa_fulfillment_id = medusaFulfillmentId
    }
    if (medusaOrderId) {
      input.medusa_order_id = medusaOrderId
    }

    // The workflow is idempotent and status-gated (#28). A `retryable` error
    // propagates here so Medusa surfaces a retry; benign no-op outcomes
    // (already_cancelled / no_sync_row / no_ongoing_order_id) resolve via the
    // decision result (no throw) because none of them describe a real Ongoing
    // order that is still shipping.
    const { result } = await cancelOngoingOrderWorkflow(container).run({ input })

    // status_not_cancellable is the one reason where a real Ongoing order is
    // known to exist and Ongoing itself refuses the cancel because its status
    // has moved past the integration's cancellable window. Resolving here
    // would let Medusa's core module-service mark the fulfillment cancelled
    // while Ongoing keeps shipping it (#109) — throw instead so canceled_at is
    // never set.
    if (result?.reason === "status_not_cancellable") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `[ongoing] cannot cancel fulfillment: Ongoing order ` +
          `${ongoingOrderNumber ?? medusaFulfillmentId ?? medusaOrderId} has moved ` +
          `past its integration's cancellable status window; Ongoing will ` +
          `continue shipping it.`
      )
    }

    return {
      ...data,
      canceled: Boolean(result?.shouldCancel),
      reason: result?.reason ?? "unknown",
    }
  }
}

export default OngoingFulfillmentProviderService
