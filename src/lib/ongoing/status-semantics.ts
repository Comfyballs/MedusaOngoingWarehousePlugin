// Ongoing order status semantics.
//
// Ongoing exposes a numeric order-status lifecycle (GET /orders/statuses). The
// plugin used to decide "is this order shipped?" by a single flat membership
// test against a per-integration shipped_status_codes list, with no model of the
// canonical lifecycle and no way to express the pickup two-step (an order is
// *sent* at 450, then *picked up* at 500). This module gives those codes a
// semantic STAGE so the poll job and webhook receiver can act on meaning instead
// of a hand-maintained code list, and so a post-shipped "picked up" signal is a
// distinct, non-terminal transition rather than something the shipped short-
// circuit swallows.
//
// Canonical codes (Ongoing docs — https://docs.ongoingwarehouse.com/manuals/statuses,
// Norwegian sandbox labels in parentheses):
//   200  Åpen              — order created / open
//   300  Plukk             — picking in progress
//   320  Skrevet ut        — pick list printed (still picking)
//   400  Plukket           — picked at the warehouse
//   425  Sendt/Dellevert   — sent / partially delivered
//   450  Sendt             — sent (this is the point we create the Medusa shipment)
//   451  Klar til henting  — ready for pickup at the pickup point (dispatched)
//   475  Retur             — return (handled by the separate return path)
//   500  Hentet            — picked up at the pickup point (delivered / terminal)
//   1000 Annullert         — cancelled

// Status codes ABOVE this one mean Ongoing is finished with the order (451 Klar til
// henting, 475 Retur, 500 Hentet, 1000 Annullert): nothing more should happen to it,
// so the 15-minute status poll syncs it once at that code and then stops re-syncing
// it (bead 8rg). 450 itself stays polled — a pickup order still advances 450 -> 500.
// Overridable with the `defaultDoneStatusThreshold` plugin option.
export const DEFAULT_DONE_STATUS_THRESHOLD = 450

// Strictly above: a code equal to the threshold keeps its current polling behaviour.
export function isDoneStatusCode(code: number, threshold: number): boolean {
  return code > threshold
}

export type OngoingOrderStage =
  | "created"
  | "picking"
  | "picked"
  | "shipped"
  | "delivered"
  | "returned"
  | "cancelled"
  | "unknown"

// Canonical code -> stage. This is the documented source of truth the AC calls
// for; the behaviour-driving arrays below are derived from it so the two can
// never drift.
export const CANONICAL_ONGOING_STATUS_STAGES: Readonly<Record<number, OngoingOrderStage>> = {
  200: "created",
  300: "picking",
  320: "picking",
  400: "picked",
  425: "shipped",
  450: "shipped",
  451: "shipped",
  475: "returned",
  500: "delivered",
  1000: "cancelled",
}

function canonicalCodesForStage(stage: OngoingOrderStage): number[] {
  return Object.entries(CANONICAL_ONGOING_STATUS_STAGES)
    .filter(([, s]) => s === stage)
    .map(([code]) => Number(code))
    .sort((a, b) => a - b)
}

// Sensible defaults used when an integration has NOT hand-picked its status
// codes. Deriving these from the canonical list (rather than requiring every
// operator to configure shipped_status_codes) is the "sensible defaults" the AC
// asks for. 425/450/451 are all "the order has left the warehouse"; 500 is the
// pickup-point collection that marks a pickup order delivered.
export const CANONICAL_SHIPPED_STATUS_CODES = canonicalCodesForStage("shipped")
export const CANONICAL_DELIVERED_STATUS_CODES = canonicalCodesForStage("delivered")

// The subset of stages the shipment/delivery seam acts on. Everything else
// ("other") only refreshes latest_status_code for edit/cancel gating.
export type ShipmentStage = "shipped" | "delivered" | "other"

export type ShipmentStageConfig = {
  shippedCodes?: number[] | null
  deliveredCodes?: number[] | null
}

// Resolve a numeric Ongoing status to the behaviour it drives.
//
// - An explicit, non-empty integration list always wins (operators can model a
//   custom flow, e.g. treating 400 as "shipped").
// - A null/empty list falls back to the canonical defaults above, so a fresh
//   integration ships and records deliveries without any configuration.
// - "delivered" is checked FIRST so 500 is treated as a pickup/delivery even if
//   an operator has also (redundantly) listed it as a shipped code — this is
//   what keeps the 450 -> 500 pickup transition from collapsing back into a
//   plain "shipped".
export function resolveShipmentStage(
  code: number,
  config: ShipmentStageConfig = {}
): ShipmentStage {
  const deliveredCodes = config.deliveredCodes?.length
    ? config.deliveredCodes
    : CANONICAL_DELIVERED_STATUS_CODES
  const shippedCodes = config.shippedCodes?.length
    ? config.shippedCodes
    : CANONICAL_SHIPPED_STATUS_CODES

  if (deliveredCodes.includes(code)) {
    return "delivered"
  }
  if (shippedCodes.includes(code)) {
    return "shipped"
  }
  return "other"
}
