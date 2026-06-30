import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import type { OrderWorkflow } from "@medusajs/framework/types"
import { OngoingApiError } from "../../lib/ongoing/errors"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type ApplyShipmentInput = {
  order_sync_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string
  tracking_numbers: string[]
}

export type ApplyShipmentResult = {
  applied: boolean
  reason: "shipped" | "already_shipped"
}

// The handler invokes the core `createOrderShipmentWorkflow` (which sets shipped_at,
// updates order state, releases reservations and emits SHIPMENT_CREATED) from INSIDE
// this step via `.run()` — the canonical "run a core-flow inside a step" pattern.
//
// Idempotency: Medusa's validate-shipment step throws a NOT_ALLOWED MedusaError with
// the exact message "Shipment has already been created" when the fulfillment is already
// shipped. That is swallowed as success WITHOUT writing an error row. Any other failure
// is classified (MedusaError -> terminal; OngoingApiError -> its kind; else retryable),
// recorded on the sync row, then re-thrown (record-then-rethrow, not compensation, since
// a throwing step returns no StepResponse).
export const applyOrderShipmentHandler = async (
  input: ApplyShipmentInput,
  { container }: { container: any }
): Promise<StepResponse<ApplyShipmentResult>> => {
  const service: any = container.resolve(ONGOING_MODULE)

  const labels = input.tracking_numbers.map((tn) => ({
    tracking_number: tn,
    tracking_url: "",
    label_url: "",
  }))

  const shipmentInput: OrderWorkflow.CreateOrderShipmentWorkflowInput = {
    order_id: input.medusa_order_id,
    fulfillment_id: input.medusa_fulfillment_id,
    items: [],
    labels,
    no_notification: false,
  }

  try {
    await createOrderShipmentWorkflow(container).run({ input: shipmentInput })
    return new StepResponse({ applied: true, reason: "shipped" })
  } catch (err) {
    if (
      err instanceof MedusaError &&
      err.type === MedusaError.Types.NOT_ALLOWED &&
      err.message === "Shipment has already been created"
    ) {
      return new StepResponse({ applied: false, reason: "already_shipped" })
    }

    const error_class =
      err instanceof MedusaError
        ? "terminal"
        : err instanceof OngoingApiError
          ? err.kind
          : "retryable"

    await service.updateOngoingOrderSyncs({
      id: input.order_sync_id,
      sync_state: "error",
      error_class,
      last_error: (err as Error).message,
      last_synced_at: new Date(),
    })

    throw err
  }
}

export const applyOrderShipmentStep = createStep(
  "apply-order-shipment",
  applyOrderShipmentHandler
)
