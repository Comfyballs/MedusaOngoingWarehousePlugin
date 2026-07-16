import type { ReactNode } from "react"
import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query"
import { Spinner } from "@medusajs/icons"
import { Text } from "@medusajs/ui"

/**
 * Shared query wrapper for every Ongoing admin surface.
 *
 * Every operator-facing panel/table/modal must distinguish four states —
 * loading, error, empty, and data — so a *failed fetch never renders as an empty
 * state* (the worst case is the failed-syncs dashboard silently showing "0 failed
 * syncs" when the request actually errored). This wrapper derives a uniform
 * `isEmpty` (via an optional predicate) alongside react-query's own flags; pair it
 * with <QueryStateView> to render the prescribed UI for each state.
 */
export type OngoingQueryResult<TData> = {
  data: TData | undefined
  isLoading: boolean
  isError: boolean
  isEmpty: boolean
  error: unknown
}

export function useOngoingQuery<TData>(
  options: UseQueryOptions<TData, Error, TData, QueryKey> & {
    // Treats the successfully-loaded data as "empty" (e.g. `(d) => d.items.length === 0`).
    // Defaults to never-empty when omitted.
    isEmpty?: (data: TData) => boolean
  }
): OngoingQueryResult<TData> {
  const { isEmpty, ...queryOptions } = options
  const { data, isLoading, isError, error } = useQuery<TData, Error, TData, QueryKey>(
    queryOptions
  )

  const empty =
    !isLoading &&
    !isError &&
    (data === undefined || (isEmpty ? isEmpty(data) : false))

  return { data, isLoading, isError, isEmpty: empty, error }
}

type QueryStateViewProps = {
  isLoading: boolean
  isError: boolean
  // Optional: surfaces that delegate the empty state to a child (e.g. a DataTable
  // with its own "no records" row) simply omit it.
  isEmpty?: boolean
  error?: unknown
  errorMessage: string
  // Required only when isEmpty can be true.
  emptyMessage?: string
  children: ReactNode
  // Padding wrapper for the loading/error/empty placeholders. Defaults to the
  // standard section padding used across the dashboard.
  className?: string
}

/**
 * Renders the prescribed loading / error / empty placeholder for an Ongoing admin
 * surface, or `children` once real data is present. States are checked in
 * priority order (loading → error → empty → data) so an in-flight or failed
 * request can never fall through to the empty message.
 */
export function QueryStateView({
  isLoading,
  isError,
  isEmpty,
  error,
  errorMessage,
  emptyMessage,
  children,
  className = "px-6 py-4",
}: QueryStateViewProps) {
  if (isLoading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <Spinner className="animate-spin text-ui-fg-subtle" />
      </div>
    )
  }
  if (isError) {
    return (
      <div className={className}>
        <Text size="small" className="text-ui-fg-error">
          {errorMessage}
          {error instanceof Error && error.message ? `: ${error.message}` : "."}
        </Text>
      </div>
    )
  }
  if (isEmpty) {
    return (
      <div className={className}>
        <Text size="small" className="text-ui-fg-subtle">
          {emptyMessage}
        </Text>
      </div>
    )
  }
  return <>{children}</>
}
