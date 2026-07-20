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
import { assertValidOngoingCarrierConfig } from "../../lib/ongoing/way-of-delivery"

/**
 * Shape `createFulfillment` stashes as the fulfillment `data`. Medusa hands this
 * object (and nothing else) back to `cancelFulfillment`.
 *
 * MODULE ISOLATION (bug ei4): a fulfillment provider is instantiated by
 * @medusajs/fulfillment's provider loader as `asFunction((cradle) => new klass(
 * cradle, options))` — so `this.container_` is the FULFILLMENT module's OWN
 * isolated container. By Medusa module isolation it does NOT have the sibling
 * `ongoing` module, `query`, or the workflow engine registered. Therefore NO
 * provider method can resolve `ongoing` or run a plugin workflow. All Ongoing
 * push/return/cancel orchestration lives in APP-SCOPE subscribers instead
 * (src/subscribers/fulfillment-created.ts, return-created.ts,
 * fulfillment-canceled.ts), which run in the app container that can resolve
 * everything. These provider methods stay within what a module-isolated
 * container can do: validate/guard and stash identifiers.
 *
 * Because the Ongoing push now happens asynchronously (off `order.fulfillment_created`),
 * `createFulfillment` cannot know the resulting `ongoing_order_number`/`ongoing_order_id`
 * at return time — those live in the `OngoingOrderSync` ledger the push subscriber
 * writes, keyed by `medusa_fulfillment_id`. So the stash only carries what the
 * provider already knows; downstream cancellation locates the Ongoing order via the
 * ledger (by `medusa_fulfillment_id`), not this stash.
 */
export type OngoingFulfillmentData = {
  location_id?: string
  medusa_fulfillment_id?: string
}

const KNOWN_OPTION_IDS = new Set<string>([
  ONGOING_STANDARD_OPTION_ID,
  ONGOING_RETURN_OPTION_ID,
])

/**
 * Ongoing Warehouse fulfillment provider.
 *
 * Owns the shipping-option lifecycle (getFulfillmentOptions / validateOption /
 * validateFulfillmentData / canCalculate) and thin, module-isolation-safe
 * create/cancel hooks. The actual cross-module Ongoing sync is driven by
 * app-scope subscribers — see the `OngoingFulfillmentData` doc comment (ei4).
 */
class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = ONGOING_PROVIDER_ID

  // The provider is handed the fulfillment module's isolated container (cradle).
  // It is stored only for the `logger` registered on it — it CANNOT resolve the
  // `ongoing` module, `query`, or the workflow engine (module isolation, ei4).
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
   * Stash the identifiers the async Ongoing push needs, and nothing more.
   *
   * The push itself runs in the `order.fulfillment_created` subscriber
   * (src/subscribers/fulfillment-created.ts), which resolves the `ongoing`
   * module and runs `pushOrderToOngoing` in the APP container — this provider's
   * module-isolated container cannot do either (ei4). A push failure is recorded
   * as an error `OngoingOrderSync` row and swept by the `retry-failed-syncs`
   * job, so — unlike the old synchronous design — a transient Ongoing outage no
   * longer aborts Medusa fulfillment creation.
   *
   * The guards remain: `fulfillment.id` is what the push subscriber re-queries
   * the order from, and `location_id` is a non-nullable column the upstream
   * create-fulfillment workflow always resolves. A missing value throws a
   * terminal error so the module-service deletes the just-created fulfillment
   * and surfaces a clean failure rather than emitting an unpushable fulfillment.
   */
  async createFulfillment(
    _data: Record<string, unknown>,
    _items: unknown[],
    _order: unknown,
    fulfillment: { id?: string; location_id?: string }
  ): Promise<{ data: OngoingFulfillmentData; labels: [] }> {
    const fulfillmentId = fulfillment?.id
    const locationId = fulfillment?.location_id

    if (!fulfillmentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot fulfill through Ongoing: fulfillment.id is missing from the createFulfillment payload.`
      )
    }

    if (!locationId) {
      this.logger_?.warn(
        `[ongoing] createFulfillment received fulfillment ${fulfillmentId} without a location_id; refusing to guess a warehouse.`
      )
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot fulfill fulfillment ${fulfillmentId} through Ongoing: ` +
          `fulfillment.location_id is missing. Refusing to guess a warehouse.`
      )
    }

    return {
      data: {
        location_id: locationId,
        medusa_fulfillment_id: fulfillmentId,
      },
      labels: [],
    }
  }

  /**
   * Stash the return fulfillment id; the Ongoing return push (PUT /returnOrders)
   * runs in the `order.return_requested` subscriber
   * (src/subscribers/return-created.ts), for the same module-isolation reason as
   * `createFulfillment` (ei4).
   *
   * `FulfillmentModuleService.createReturnFulfillment` creates the return
   * fulfillment row first, then calls this with `{ ...fulfillment,
   * shipping_option }`, so `fromData.id` is hydrated. Guard it: without it there
   * is nothing to push.
   */
  async createReturnFulfillment(
    fromData: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown>; labels: never[] }> {
    const returnFulfillmentId = typeof fromData?.id === "string" ? fromData.id : undefined

    if (!returnFulfillmentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] cannot return through Ongoing: return fulfillment.id is missing from the createReturnFulfillment payload.`
      )
    }

    return {
      data: {
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
   * Fulfillment cancellation hook.
   *
   * Medusa's `FulfillmentModuleService.cancelFulfillment` calls this with ONLY
   * the stashed `data` and inspects nothing but throw/no-throw before setting
   * `fulfillment.canceled_at`. The real Ongoing cancel runs in APP scope — the
   * `order.fulfillment_canceled` subscriber (and, for whole-order cancels, the
   * `order.canceled` subscriber) runs the idempotent, status-gated
   * `cancelOngoingOrderWorkflow`, which this module-isolated container cannot do
   * (ei4). So this hook is a non-throwing no-op: it must not throw, or the core
   * module-service would abort the Medusa-side cancel.
   *
   * TRADE-OFF (ei4): the old synchronous design threw here on
   * `status_not_cancellable` to keep `canceled_at` unset when Ongoing refused the
   * cancel. A module-isolated provider cannot run the status-gated workflow, so
   * that guard now lives only in the subscriber's ledger/logs — the Medusa
   * fulfillment is marked cancelled regardless, and a refused Ongoing cancel is
   * surfaced via the OngoingOrderSync row + logs. Tracked as a follow-up.
   */
  async cancelFulfillment(
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return { ...(data ?? {}) }
  }
}

export default OngoingFulfillmentProviderService
