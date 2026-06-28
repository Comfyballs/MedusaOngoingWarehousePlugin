import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
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
import { cancelOngoingOrderWorkflow } from "../../workflows"

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
   * Return value is stored as the shipping method's `data`. For now we pass the
   * caller's data through unchanged (mirrors the manual provider). Real
   * way-of-delivery resolution happens at order-payload time in a later milestone.
   */
  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    return data
  }

  /** Ongoing rates are flat in this plugin → no calculated rates. */
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false
  }

  /**
   * Extension point — returns fulfillment.
   *
   * Returns are out of scope for now (see design §1 "Out of scope": returns /
   * label retrieval are stubbed as extension points). The base
   * `AbstractFulfillmentProviderService.createReturn` THROWS
   * ("createReturn must be overridden"), so this MUST be overridden even to
   * no-op. The empty `{ data, labels }` shape matches Medusa's manual
   * fulfillment provider. Implement real Ongoing return creation here when
   * returns come into scope.
   */
  async createReturnFulfillment(
    _fulfillment: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown>; labels: never[] }> {
    return { data: {}, labels: [] }
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
   * already-cancelled handling lives in that workflow. This method is a thin,
   * defensive adapter: it never throws on a benign already-cancelled or
   * missing-identifier path, but it lets genuine retryable failures propagate so
   * Medusa can surface a retry. Converges safely with the `order.canceled`
   * subscriber (#32) because the workflow is idempotent.
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
    // propagates here so Medusa surfaces a retry; benign already-cancelled
    // outcomes resolve via the decision result (no throw).
    const { result } = await cancelOngoingOrderWorkflow(container).run({ input })

    return {
      ...data,
      canceled: Boolean(result?.shouldCancel),
      reason: result?.reason ?? "unknown",
    }
  }
}

export default OngoingFulfillmentProviderService
