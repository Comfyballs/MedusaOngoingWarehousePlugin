import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { Badge, Button, Container, Text } from "@medusajs/ui"
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
  tracking: OngoingOrderSyncTracking[]
}

type SyncResponse = { syncs: OngoingOrderSyncRow[] }

type RepushResponse = { ongoing_order_id: number; ongoing_order_number: string }

const STATE_BADGE_COLOR: Record<
  OngoingSyncState,
  "grey" | "blue" | "green" | "red" | "orange"
> = {
  pending: "grey",
  sent: "blue",
  shipped: "green",
  cancelled: "grey",
  error: "red",
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyFor(orderId) })
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
  const { data: response, isLoading } = useQuery<SyncResponse>({
    queryKey: queryKeyFor(data.id),
    queryFn: () => sdk.client.fetch<SyncResponse>(`/admin/ongoing/orders/${data.id}/sync`),
  })

  const syncs = response?.syncs ?? []

  if (!isLoading && syncs.length === 0) {
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
