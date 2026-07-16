import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Server, Spinner } from "@medusajs/icons"
import {
  Badge,
  Container,
  DataTable,
  DataTableRowSelectionState,
  DataTablePaginationState,
  Heading,
  Text,
  Tooltip,
  createDataTableColumnHelper,
  createDataTableCommandHelper,
  toast,
  useDataTable,
} from "@medusajs/ui"
import { useMemo, useState } from "react"
import { keepPreviousData, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../../lib/sdk"
import { useOngoingQuery, QueryStateView } from "../../lib/use-ongoing-query"
import {
  deriveConnectionHealth,
  type OngoingIntegrationHealth,
  type OngoingIntegrationsListResponse,
} from "./connection-health"

type OngoingSyncState = "pending" | "sent" | "error"
type OngoingErrorClass = "retryable" | "terminal"

type OngoingSyncRow = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  sync_state: OngoingSyncState
  error_class: OngoingErrorClass | null
  retry_count: number
  last_error: string | null
  last_synced_at: string | null
}

// Mirrors OngoingSyncStateSummary from src/api/admin/ongoing/syncs/summary.ts.
// Duplicated locally (not imported) the same way OngoingSyncRow above duplicates
// the route's row shape -- src/admin uses bundler/Vite resolution and a separate
// tsconfig from src/api's Node16 server build, so this file intentionally does
// not reach into src/api/**.
type OngoingSyncStateSummary = Record<
  "pending" | "sent" | "shipped" | "cancelled" | "error",
  number
>

type ListSyncsResponse = {
  syncs: OngoingSyncRow[]
  count: number
  limit: number
  offset: number
  summary: OngoingSyncStateSummary
}

type RetrySyncsResponse = {
  retried: string[]
  skipped: string[]
}

const SYNC_STATE_BADGE_COLOR: Record<OngoingSyncState, "red" | "orange" | "grey"> = {
  error: "red",
  sent: "orange",
  pending: "grey",
}

const ERROR_CLASS_BADGE_COLOR: Record<OngoingErrorClass, "orange" | "red"> = {
  retryable: "orange",
  terminal: "red",
}

// Order operators care about most first: error, then pending/in-flight, then
// terminal/settled states.
const SUMMARY_STATE_ORDER: (keyof OngoingSyncStateSummary)[] = [
  "error",
  "pending",
  "sent",
  "shipped",
  "cancelled",
]

const SUMMARY_BADGE_COLOR: Record<
  keyof OngoingSyncStateSummary,
  "red" | "grey" | "orange" | "green" | "purple"
> = {
  error: "red",
  pending: "grey",
  sent: "orange",
  shipped: "green",
  cancelled: "purple",
}

const HEALTH_BADGE_COLOR: Record<OngoingIntegrationHealth, "green" | "orange" | "grey"> = {
  healthy: "green",
  stale: "orange",
  disabled: "grey",
}

const LAST_ERROR_TRUNCATE_AT = 40

function isRetryEligible(row: OngoingSyncRow): boolean {
  return row.sync_state === "error" && row.error_class === "retryable"
}

const columnHelper = createDataTableColumnHelper<OngoingSyncRow>()

const columns = [
  columnHelper.select(),
  columnHelper.accessor("ongoing_order_number", { header: "Ongoing order #" }),
  columnHelper.accessor("medusa_order_id", { header: "Medusa order" }),
  columnHelper.accessor("sync_state", {
    header: "Sync state",
    cell: ({ getValue }) => (
      <Badge color={SYNC_STATE_BADGE_COLOR[getValue()]}>{getValue()}</Badge>
    ),
  }),
  columnHelper.accessor("error_class", {
    header: "Error class",
    cell: ({ getValue }) => {
      const value = getValue()
      if (!value) {
        return (
          <Text size="small" className="text-ui-fg-subtle">
            —
          </Text>
        )
      }
      return <Badge color={ERROR_CLASS_BADGE_COLOR[value]}>{value}</Badge>
    },
  }),
  columnHelper.accessor("retry_count", { header: "Retries" }),
  columnHelper.accessor("last_error", {
    header: "Last error",
    cell: ({ getValue }) => {
      const value = getValue()
      if (!value) {
        return (
          <Text size="small" className="text-ui-fg-subtle">
            —
          </Text>
        )
      }
      const truncated =
        value.length > LAST_ERROR_TRUNCATE_AT
          ? `${value.slice(0, LAST_ERROR_TRUNCATE_AT)}…`
          : value
      return (
        <Tooltip content={value}>
          <Text size="small">{truncated}</Text>
        </Tooltip>
      )
    },
  }),
  columnHelper.accessor("last_synced_at", {
    header: "Last synced",
    cell: ({ getValue }) => {
      const value = getValue()
      return (
        <Text size="small" className="text-ui-fg-subtle">
          {value ? new Date(value).toLocaleString() : "never"}
        </Text>
      )
    },
  }),
]

const commandHelper = createDataTableCommandHelper()

// Spec §11 "success/failure counters" (deferred to this issue by #44). Pure
// presentational component -- summary is fetched by the same query as the
// syncs table (OngoingSyncsTable), no separate request.
function SyncStateSummaryStrip({
  summary,
  isLoading,
  isError,
}: {
  summary: OngoingSyncStateSummary | undefined
  isLoading: boolean
  isError: boolean
}) {
  return (
    <Container className="flex items-center gap-x-6 px-6 py-4">
      {isLoading || (!isError && !summary) ? (
        <Spinner className="animate-spin" />
      ) : isError || !summary ? (
        <Text size="small" className="text-ui-fg-error">
          Failed to load sync summary
        </Text>
      ) : (
        SUMMARY_STATE_ORDER.map((state) => (
          <div key={state} className="flex items-center gap-x-2">
            <Badge color={SUMMARY_BADGE_COLOR[state]}>{state}</Badge>
            <Text size="small" weight="plus">
              {summary[state]}
            </Text>
          </div>
        ))
      )}
    </Container>
  )
}

function ConnectionHealthPanel() {
  const { data, isLoading, isError, isEmpty, error } =
    useOngoingQuery<OngoingIntegrationsListResponse>({
      queryFn: () =>
        sdk.client.fetch<OngoingIntegrationsListResponse>("/admin/ongoing/integrations"),
      queryKey: ["ongoing-integrations-health"],
      isEmpty: (d) => (d.integrations ?? []).length === 0,
    })

  const integrations = data?.integrations ?? []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Connection health</Heading>
      </div>
      <QueryStateView
        isLoading={isLoading}
        isError={isError}
        isEmpty={isEmpty}
        error={error}
        errorMessage="Failed to load connection health"
        emptyMessage="No Ongoing integrations configured yet."
      >
        <div className="flex flex-col gap-y-2 px-6 py-4">
          {integrations.map((integration) => {
            const health = deriveConnectionHealth(integration)
            return (
              <div key={integration.id} className="flex items-center justify-between">
                <Text size="small" weight="plus">
                  {integration.credential_key}
                </Text>
                <Badge color={HEALTH_BADGE_COLOR[health]}>{health}</Badge>
              </div>
            )
          })}
        </div>
      </QueryStateView>
    </Container>
  )
}

function OngoingSyncsTable() {
  const queryClient = useQueryClient()
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>({})
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })

  const limit = pagination.pageSize
  const offset = pagination.pageIndex * limit

  const { data, isLoading, isError, error } = useOngoingQuery<ListSyncsResponse>({
    queryFn: () =>
      sdk.client.fetch<ListSyncsResponse>("/admin/ongoing/syncs", {
        query: { limit, offset },
      }),
    queryKey: ["ongoing-syncs", limit, offset],
    placeholderData: keepPreviousData,
  })

  const commands = useMemo(
    () => [
      commandHelper.command({
        label: "Retry",
        shortcut: "r",
        action: async (selection: DataTableRowSelectionState) => {
          const syncIds = Object.keys(selection).filter((id) => selection[id])
          if (syncIds.length === 0) {
            return
          }

          try {
            const result = await sdk.client.fetch<RetrySyncsResponse>(
              "/admin/ongoing/syncs/retry",
              { method: "POST", body: { sync_ids: syncIds } }
            )
            queryClient.invalidateQueries({ queryKey: ["ongoing-syncs"] })
            setRowSelection({})
            toast.success("Retry queued", {
              description: `${result.retried.length} sync(s) queued for retry, ${result.skipped.length} skipped.`,
            })
          } catch (error) {
            toast.error("Retry failed", {
              description: error instanceof Error ? error.message : "Unknown error",
            })
          }
        },
      }),
    ],
    [queryClient]
  )

  const table = useDataTable({
    data: data?.syncs ?? [],
    columns,
    commands,
    getRowId: (row) => row.id,
    rowCount: data?.count ?? 0,
    isLoading,
    rowSelection: {
      state: rowSelection,
      onRowSelectionChange: setRowSelection,
      // Selection is restricted to error/retryable rows -- terminal rows are
      // shown (with a distinct badge) but not selectable for bulk retry. The
      // workflow step (Task 1) double-guards this server-side regardless.
      enableRowSelection: (row) => isRetryEligible(row.original),
    },
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
  })

  return (
    <>
      <SyncStateSummaryStrip summary={data?.summary} isLoading={isLoading} isError={isError} />
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <Heading level="h2">Failed &amp; pending syncs</Heading>
        </div>
        {/* A failed fetch must not render as an empty "0 syncs" table. Loading and
            empty are handled by the DataTable itself; QueryStateView only injects
            the error banner in place of the table. */}
        <QueryStateView
          isLoading={false}
          isError={isError}
          error={error}
          errorMessage="Failed to load syncs"
        >
          <DataTable instance={table}>
            <DataTable.Table />
            <DataTable.Pagination />
            <DataTable.CommandBar selectedLabel={(count) => `${count} selected`} />
          </DataTable>
        </QueryStateView>
      </Container>
    </>
  )
}

const OngoingDashboardPage = () => {
  return (
    <div className="flex flex-col gap-y-3">
      <ConnectionHealthPanel />
      <OngoingSyncsTable />
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Ongoing WMS",
  icon: Server,
})

export default OngoingDashboardPage
