import { InjectManager, MedusaContext, MedusaError, MedusaService } from "@medusajs/framework/utils"
import type { Context } from "@medusajs/framework/types"
import OngoingIntegration from "./models/integration"
import OngoingOrderSync from "./models/order-sync"
import { validateOngoingOptions } from "./options"
import { OngoingClient } from "../../lib/ongoing/client"
import { DEFAULT_DONE_STATUS_THRESHOLD } from "../../lib/ongoing/status-semantics"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

// Parse a millisecond interval plugin option, falling back to `fallback` when the
// value is absent or not a finite positive number. validateOngoingOptions rejects a
// bad value at boot; this is the defense-in-depth guard so a NaN can never reach the
// poll/stock-sync scheduler (where it would silently disable the tick).
function parseIntervalMs(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// The two jobs that poll an integration are independent (status-poll reads order status;
// stock-sync reads inventory) and must not block each other — see LOCK_COLUMNS below.
export type SyncLockKind = "status_poll" | "stock_sync"

const LOCK_COLUMNS: Record<SyncLockKind, "sync_lock_until" | "stock_sync_lock_until"> = {
  status_poll: "sync_lock_until",
  stock_sync: "stock_sync_lock_until",
}

export type RetrySyncTransitionInput = {
  id: string
  expected_retry_count: number
  retry_count: number
  last_synced_at: Date
  error_class?: "terminal"
}

export type RecordSyncInput = {
  ongoing_order_number: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  // Omitted for outbound order pushes (defaults to "order" at the DB); return
  // pushes pass "return" so the retry job re-pushes them via the return workflow (8p8).
  sync_kind?: "order" | "return"
  sync_state: "pending" | "sent" | "shipped" | "delivered" | "cancelled" | "error"
  ongoing_order_id?: number | null
  error_class?: "retryable" | "terminal" | null
  last_error?: string | null
}

class OngoingModuleService extends MedusaService({
  OngoingIntegration,
  OngoingOrderSync,
}) {
  protected readonly options_: OngoingPluginOptions
  // One OngoingClient (hence one Throttle) per credential_key, cached for the life of
  // this singleton module service. Ongoing processes calls sequentially per goods owner,
  // so a fresh client per getClient() call (each with its own throttle) left process-wide
  // concurrency toward one goods owner effectively unbounded across the cron jobs, retry
  // sweeps and webhook workflows (bead 4s4).
  private readonly clients_ = new Map<string, OngoingClient>()

  // Medusa injects (container, moduleOptions) into the module service constructor.
  constructor(_: unknown, options: OngoingPluginOptions) {
    super(...arguments)
    this.options_ = validateOngoingOptions(options)
  }

  // Pure synchronous config accessor (no I/O) — kept sync on purpose so call
  // sites don't need to await a plain in-memory lookup. The async-methods rule
  // targets DB-backed service methods, which this is not.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getCredentials(credentialKey: string): OngoingCredentials {
    const found = this.options_.integrations.find((i) => i.key === credentialKey)
    if (!found) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] no credentials configured for credential_key "${credentialKey}"`
      )
    }
    return found
  }

  // Pure synchronous factory/cache (constructs a client from in-memory config, then
  // reuses it) — see getCredentials above for why this is intentionally not async. The
  // shared client means one Throttle governs all concurrent calls to a given goods owner.
  // Cached per (credential_key, goods_owner_id), not per credential key: one Ongoing
  // account can serve several goods owners (bead 9y2.9), and a client is bound to one
  // of them. This also scopes the Throttle per goods owner, which is what Ongoing's
  // parallel-requests guidance actually asks for.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getClient(credentialKey: string, goodsOwnerId: number): OngoingClient {
    const cacheKey = `${credentialKey}:${goodsOwnerId}`
    const cached = this.clients_.get(cacheKey)
    if (cached) {
      return cached
    }
    const client = new OngoingClient(this.getCredentials(credentialKey), {
      goodsOwnerId,
      concurrency: this.options_.rateLimitConcurrency ?? 1,
    })
    this.clients_.set(cacheKey, client)
    return client
  }

  // Pure synchronous config accessor (no I/O) — same rationale as getCredentials
  // and getClient above: this reads in-memory plugin options, not the DB.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  listCredentialKeys(): string[] {
    return this.options_.integrations.map((i) => i.key)
  }

  async getIntegrationByLocation(stockLocationId: string) {
    const [integration] = await this.listOngoingIntegrations({
      stock_location_id: stockLocationId,
      enabled: true,
    })
    return integration
  }

  async recordSync(input: RecordSyncInput): Promise<{ id: string }> {
    const [existing] = await this.listOngoingOrderSyncs({
      ongoing_order_number: input.ongoing_order_number,
    })

    const data: Record<string, unknown> = { ...input, last_synced_at: new Date() }

    if (existing) {
      // Reaching a terminal success (sent / shipped / cancelled) clears the previous
      // failed attempt's bookkeeping so a now-successful row does not keep surfacing a
      // stale retry_count / error_class / last_error on the dashboard and order widget
      // (bead i85). An explicit value in the input still wins.
      //
      // CRITICAL: this must NOT fire on "pending". A retry re-runs the push, which calls
      // recordSync({ sync_state: "pending" }) BEFORE the PUT (push-order-record-sync.ts)
      // while the retry job has already CAS-advanced retry_count on the still-"error" row.
      // Zeroing retry_count here would pin it at 0 forever → backoff never grows and the
      // dead-letter threshold is never reached. retry_count is owned by the retry job
      // (attemptRetrySyncTransition); recordSync only clears it once the push actually
      // succeeds. "error" and "pending" are both left untouched.
      const isTerminalSuccess =
        input.sync_state === "sent" ||
        input.sync_state === "shipped" ||
        input.sync_state === "cancelled"
      if (isTerminalSuccess) {
        data.retry_count = 0
        if (input.error_class === undefined) {
          data.error_class = null
        }
        if (input.last_error === undefined) {
          data.last_error = null
        }
      }
      // Single-object input -> auto-CRUD returns a single entity (not an array).
      const updated = await this.updateOngoingOrderSyncs({ id: existing.id, ...data })
      return { id: updated.id }
    }

    const created = await this.createOngoingOrderSyncs(data)
    return { id: created.id }
  }

  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getCredentials/getClient above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStatusPollIntervalMs(): number {
    return parseIntervalMs(this.options_.defaultStatusPollInterval, 60000)
  }

  // Status code above which the poll considers an order done and stops re-syncing it
  // (bead 8rg). Pure synchronous config accessor, same rationale as the getters around it.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDoneStatusThreshold(): number {
    const threshold = this.options_.defaultDoneStatusThreshold
    return Number.isInteger(threshold) && (threshold as number) >= 0
      ? (threshold as number)
      : DEFAULT_DONE_STATUS_THRESHOLD
  }

  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getDefaultStatusPollIntervalMs above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStockSyncIntervalMs(): number {
    return parseIntervalMs(this.options_.defaultStockSyncInterval, 600000)
  }

  /**
   * Advisory lock so two ticks can't poll the same integration for the same job at once.
   * `lockName` selects an independent column per job (see `LOCK_COLUMNS`) — status-poll
   * and stock-sync used to share a single `sync_lock_until` column, so whichever acquired
   * first blocked the other for its TTL even though they poll unrelated data (bead mjy).
   *
   * Acquisition itself is now a CAS, mirroring `attemptRetrySyncTransition` below: the
   * initial read establishes the expected current column value (busy vs. free/expired),
   * then a native `UPDATE ... WHERE id = ? AND <column> = <expected>` only lands if no
   * other tick changed that column since the read. A plain read-then-write here would
   * double-acquire under multi-instance deployment (two ticks both observe "free" and
   * both write); the guarded write lets only one of them win.
   */
  @InjectManager()
  async acquireSyncLock(
    integrationId: string,
    ttlMs: number,
    lockName: SyncLockKind = "status_poll",
    @MedusaContext() sharedContext: Context = {}
  ): Promise<boolean> {
    const column = LOCK_COLUMNS[lockName]
    const integration = await this.retrieveOngoingIntegration(integrationId)
    const currentValue = (integration as Record<string, unknown> | undefined)?.[column] as
      | Date
      | string
      | null
      | undefined
    const lockedUntil = currentValue ? new Date(currentValue).getTime() : 0
    if (lockedUntil > Date.now()) {
      return false
    }

    const manager = sharedContext.manager as {
      nativeUpdate: (
        entityName: string,
        where: Record<string, unknown>,
        data: Record<string, unknown>
      ) => Promise<number>
    }

    const affectedRows = await manager.nativeUpdate(
      "OngoingIntegration",
      { id: integrationId, [column]: currentValue ?? null },
      { [column]: new Date(Date.now() + ttlMs) }
    )

    return affectedRows === 1
  }

  async releaseSyncLock(integrationId: string, lockName: SyncLockKind = "status_poll"): Promise<void> {
    const column = LOCK_COLUMNS[lockName]
    await this.updateOngoingIntegrations({ id: integrationId, [column]: null })
  }

  /**
   * Guarded write for the retry-sweep driver (`src/jobs/retry-failed-syncs.ts`).
   * Atomically transitions a row's `retry_count` (and, when dead-lettering,
   * `error_class`) only if the row still matches the exact state this call site
   * observed when it listed the row: `sync_state = "error" AND retry_count =
   * expected_retry_count`.
   *
   * Returns `true` when this call won the race and the write landed. Returns
   * `false` ("CAS lost") when zero rows matched — another overlapping tick
   * already advanced `retry_count` for this row (multi-instance deployment, or
   * a slow prior tick still in flight), or the row left the `error` state
   * between listing and this call (e.g. a concurrent cancellation). The caller
   * cannot distinguish which case fired and does not need to: both mean skip
   * without re-invoking the sync or emitting a retry/dead-letter event, since
   * whichever tick won the guard already did so.
   *
   * Bypasses the auto-CRUD `updateOngoingOrderSyncs` (read-then-write via
   * `manager.assign()+persist()` — last-write-wins, confirmed by reading
   * `@medusajs/utils`'s `MikroOrmBaseRepository.update()`) in favour of a single
   * native `UPDATE ... WHERE id = ? AND sync_state = 'error' AND retry_count = ?`
   * so the guard is enforced by the database in one round-trip, not by
   * application-level read-then-write.
   */
  @InjectManager()
  async attemptRetrySyncTransition(
    input: RetrySyncTransitionInput,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<boolean> {
    const manager = sharedContext.manager as {
      nativeUpdate: (
        entityName: string,
        where: Record<string, unknown>,
        data: Record<string, unknown>
      ) => Promise<number>
    }

    const data: Record<string, unknown> = {
      retry_count: input.retry_count,
      last_synced_at: input.last_synced_at,
    }
    if (input.error_class) {
      data.error_class = input.error_class
    }

    const affectedRows = await manager.nativeUpdate(
      "OngoingOrderSync",
      {
        id: input.id,
        sync_state: "error",
        retry_count: input.expected_retry_count,
      },
      data
    )

    return affectedRows === 1
  }
}

export default OngoingModuleService
