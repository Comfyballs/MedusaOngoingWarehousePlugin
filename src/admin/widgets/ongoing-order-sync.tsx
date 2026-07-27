import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { Badge, Button, Container, Text, toast } from "@medusajs/ui"
import { Spinner } from "@medusajs/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/sdk"

type OngoingSyncState = "pending" | "sent" | "shipped" | "cancelled" | "error"

type OngoingOrderSyncTracking = {
  tracking_number: string
  tracking_url: string | null
}

type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: OngoingSyncState
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | null
  last_error: string | null
  retry_count: number
  edit_blocked_at: string | null
  edit_blocked_category: "address_contact" | "line_items" | null
  edit_blocked_reason: string | null
  cancel_refused_at: string | null
  cancel_refused_reason: string | null
  tracking: OngoingOrderSyncTracking[]
}

type SyncResponse = { syncs: OngoingOrderSyncRow[] }

type RepushResponse = { ongoing_order_id: number; ongoing_order_number: string }

// bead 8bs item 5: `cancelled` previously shared grey with `pending`, so a cancelled
// order was visually indistinguishable from a not-yet-sent one. Colours now match the
// dashboard's summary/table map (SYNC_STATE_BADGE_COLOR) exactly so a state reads the
// same on the order widget and the ops dashboard: pending grey, sent orange (was blue),
// shipped green, cancelled purple (was grey), error red.
const STATE_BADGE_COLOR: Record<
  OngoingSyncState,
  "grey" | "green" | "red" | "orange" | "purple"
> = {
  pending: "grey",
  sent: "orange",
  shipped: "green",
  cancelled: "purple",
  error: "red",
}

const EDIT_BLOCKED_CATEGORY_LABEL: Record<"address_contact" | "line_items", string> = {
  address_contact: "Address / contact",
  line_items: "Line items",
}

const EDIT_BLOCKED_REASON_LABEL: Record<string, string> = {
  no_edit_rules: "No edit rules configured for the current status",
  status_unknown: "Order status is unknown",
  status_blocked: "Order status does not allow this edit",
  no_sync_row: "The Ongoing sync record no longer exists",
}

const queryKeyFor = (orderId: string) => ["ongoing", "order-sync", orderId]

function RepushButton({ orderId, sync }: { orderId: string; sync: OngoingOrderSyncRow }) {
  const queryClient = useQueryClient()
  const fulfillmentId = sync.medusa_fulfillment_id

  const mutation = useMutation<RepushResponse, Error, string>({
    mutationFn: (fulfillment_id) =>
      sdk.client.fetch<RepushResponse>(`/admin/ongoing/orders/${orderId}/repush`, {
        method: "POST",
        body: { fulfillment_id },
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyFor(orderId) })
    },
    onError: (error) => {
      toast.error("Failed to re-push order to Ongoing", {
        description: error.message,
      })
    },
  })

  const terminalState = sync.sync_state === "shipped" || sync.sync_state === "cancelled"
  const disabled = !fulfillmentId || terminalState || mutation.isPending
  const label = sync.sync_state === "error" ? "Retry" : "Re-push"

  return (
    <Button
      size="small"
      variant="secondary"
      disabled={disabled}
      isLoading={mutation.isPending}
      onClick={() => fulfillmentId && mutation.mutate(fulfillmentId)}
    >
      {label}
    </Button>
  )
}

const OngoingOrderSyncWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const { data: response, isLoading, isError, error } = useQuery<SyncResponse>({
    queryKey: queryKeyFor(data.id),
    queryFn: () => sdk.client.fetch<SyncResponse>(`/admin/ongoing/orders/${data.id}/sync`),
  })

  const syncs = response?.syncs ?? []

  if (!isLoading && !isError && syncs.length === 0) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Text size="large" weight="plus">
          Ongoing Warehouse
        </Text>
      </div>
      {isLoading && (
        <div className="flex items-center justify-center px-6 py-4">
          <Spinner className="animate-spin text-ui-fg-subtle" />
        </div>
      )}
      {isError && (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            Failed to load Ongoing sync status
            {error instanceof Error && error.message ? `: ${error.message}` : "."}
          </Text>
        </div>
      )}
      {syncs.map((sync) => (
        <div key={sync.id} className="flex flex-col gap-y-2 px-6 py-4">
          <div className="flex items-center justify-between">
            <Text size="small" weight="plus">
              {sync.ongoing_order_number}
            </Text>
            <Badge color={STATE_BADGE_COLOR[sync.sync_state]}>{sync.sync_state}</Badge>
          </div>

          <Text size="small" className="text-ui-fg-subtle">
            Status: {sync.latest_status_text ?? "—"}
            {sync.latest_status_code != null ? ` (${sync.latest_status_code})` : ""}
          </Text>

          <Text size="small" className="text-ui-fg-subtle">
            Last synced: {sync.last_synced_at ? new Date(sync.last_synced_at).toLocaleString() : "—"}
          </Text>

          {sync.edit_blocked_at && (
            <div className="bg-ui-tag-orange-bg border-ui-tag-orange-border flex flex-col gap-y-1 rounded-md border px-3 py-2">
              <div className="flex items-center gap-x-2">
                <Badge color="orange" size="2xsmall">
                  Edit blocked
                </Badge>
                <Text size="small" leading="compact" weight="plus" className="text-ui-tag-orange-text">
                  {sync.edit_blocked_category
                    ? EDIT_BLOCKED_CATEGORY_LABEL[sync.edit_blocked_category]
                    : "Unknown edit type"}
                </Text>
              </div>
              <Text size="small" leading="compact" className="text-ui-tag-orange-text">
                {sync.edit_blocked_reason
                  ? (EDIT_BLOCKED_REASON_LABEL[sync.edit_blocked_reason] ?? sync.edit_blocked_reason)
                  : "Reason not recorded"}
              </Text>
            </div>
          )}

          {sync.cancel_refused_at && (
            <div className="bg-ui-tag-red-bg border-ui-tag-red-border flex flex-col gap-y-1 rounded-md border px-3 py-2">
              <div className="flex items-center gap-x-2">
                <Badge color="red" size="2xsmall">
                  Cancel refused
                </Badge>
                <Text size="small" leading="compact" weight="plus" className="text-ui-tag-red-text">
                  Ongoing may still ship this order
                </Text>
              </div>
              <Text size="small" leading="compact" className="text-ui-tag-red-text">
                {sync.cancel_refused_reason ??
                  "Ongoing declined the cancel because its status is not cancellable. Reconcile it in Ongoing."}
              </Text>
            </div>
          )}

          {sync.tracking.length > 0 && (
            <div className="flex flex-col gap-y-1">
              {sync.tracking.map((t) => (
                <Text size="small" key={t.tracking_number}>
                  Tracking:{" "}
                  {t.tracking_url ? (
                    <a href={t.tracking_url} target="_blank" rel="noreferrer">
                      {t.tracking_number}
                    </a>
                  ) : (
                    t.tracking_number
                  )}
                </Text>
              ))}
            </div>
          )}

          {sync.last_error && (
            <Text size="small" className="text-ui-fg-error">
              {sync.last_error}
            </Text>
          )}

          <div className="flex justify-end">
            <RepushButton orderId={data.id} sync={sync} />
          </div>
        </div>
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default OngoingOrderSyncWidget
