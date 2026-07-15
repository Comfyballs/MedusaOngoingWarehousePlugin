import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import type { MedusaContainer, OrderWorkflow } from "@medusajs/framework/types"
import { OngoingApiError } from "../../lib/ongoing/errors"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type ApplyShipmentInput = {
  order_sync_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string
  tracking_numbers: string[]
  // Optional waybill+URL pairs (bead 5vu). When present, labels carry the real carrier
  // tracking URL; otherwise we fall back to tracking_numbers with an empty URL.
  tracking?: Array<{ number: string; url?: string }>
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
//
// Audit (#113): does an outer-workflow retry (syncOngoingShipmentWorkflow re-run after
// this step already succeeded once, but markOrderSyncShippedStep then failed — see
// src/jobs/status-poll.ts:120-129 and the webhook path in
// src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts, both of which re-invoke
// syncOngoingShipmentWorkflow whenever OngoingOrderSync.shipped_at is still null, i.e.
// before markOrderSyncShippedStep has committed) re-fire any SHIPMENT_CREATED-driven
// side effect (notification/webhook/analytics)? Audited and confirmed safe:
//
//  1. Emit gating: createOrderShipmentWorkflow's emitEventStep
//     (@medusajs/core-flows/dist/order/workflows/create-shipment.js:150-156) reads
//     `shipment.id`, the output of a parallel branch that includes
//     createShipmentWorkflow.runAsStep. That inner workflow's first step,
//     validateShipmentStep (@medusajs/core-flows/dist/fulfillment/steps/
//     validate-shipment.js:12-19), throws the exact "Shipment has already been created"
//     MedusaError caught above whenever `fulfillment.shipped_at` is already set — which
//     it is on any retry, because the first successful run already set it via
//     updateFulfillmentWorkflow. A failed step blocks every step that depends on its
//     output, so emitEventStep never runs on retry. The sibling parallel step
//     registerOrderShipmentStep (@medusajs/core-flows/dist/order/steps/
//     register-shipment.js:10-20) carries a `revertLastVersion` compensation that the
//     workflow engine runs automatically when its sibling fails, so even its transient
//     write is reverted before `.run()` returns.
//  2. No live consumer today: this plugin's subscribers (src/subscribers/
//     order-canceled.ts, order-edit-confirmed.ts, order-updated.ts) don't reference
//     shipment.created, and Medusa 2.16.0's only built-in notification subscriber
//     (@medusajs/medusa/dist/subscribers/configurable-notifications.js) is hardcoded to
//     "order.created" only.
//  3. Guardrail for a future subscriber: NotificationModuleService.createNotifications
//     (@medusajs/notification/dist/services/notification-module-service.js:39-55) only
//     dedupes entries carrying an explicit `idempotency_key` — not automatic per-event.
//     (1) already prevents a duplicate emit on retry, so this isn't a live gap, but any
//     future shipment.created subscriber should still set an idempotency_key rather than
//     rely on the module deduping for it.
export const applyOrderShipmentHandler = async (
  input: ApplyShipmentInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<ApplyShipmentResult>> => {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService

  // Prefer the enriched waybill+URL pairs (bead 5vu) so labels carry the carrier tracking
  // URL; fall back to the bare waybill list (URL unknown) when tracking isn't supplied.
  const labels = (input.tracking?.length
    ? input.tracking.map((t) => ({ tracking_number: t.number, tracking_url: t.url ?? "" }))
    : input.tracking_numbers.map((tn) => ({ tracking_number: tn, tracking_url: "" }))
  ).map((l) => ({ ...l, label_url: "" }))

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
