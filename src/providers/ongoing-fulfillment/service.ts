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
}

export default OngoingFulfillmentProviderService
