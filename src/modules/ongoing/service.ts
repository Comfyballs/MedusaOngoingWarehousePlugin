import { InjectManager, MedusaContext, MedusaError, MedusaService } from "@medusajs/framework/utils"
import type { Context } from "@medusajs/framework/types"
import OngoingIntegration from "./models/integration"
import OngoingOrderSync from "./models/order-sync"
import { validateOngoingOptions } from "./options"
import { OngoingClient } from "../../lib/ongoing/client"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

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
  sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
  ongoing_order_id?: number | null
  error_class?: "retryable" | "terminal" | null
  last_error?: string | null
}

class OngoingModuleService extends MedusaService({
  OngoingIntegration,
  OngoingOrderSync,
}) {
  protected readonly options_: OngoingPluginOptions

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

  // Pure synchronous factory (constructs a client from in-memory config) — see
  // getCredentials above for why this is intentionally not async.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getClient(credentialKey: string): OngoingClient {
    return new OngoingClient(this.getCredentials(credentialKey), {
      concurrency: this.options_.rateLimitConcurrency ?? 2,
    })
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

    const data = { ...input, last_synced_at: new Date() }

    if (existing) {
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
    return parseInt(this.options_.defaultStatusPollInterval ?? "60000", 10)
  }

  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getDefaultStatusPollIntervalMs above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStockSyncIntervalMs(): number {
    return parseInt(this.options_.defaultStockSyncInterval ?? "600000", 10)
  }

  // Best-effort advisory lock so two ticks can't poll the same integration at
  // once. Read-then-write is fine for a single-instance cron; the TTL is a crash
  // safety net (the dispatcher also releases it in a finally).
  async acquireSyncLock(integrationId: string, ttlMs: number): Promise<boolean> {
    const integration = await this.retrieveOngoingIntegration(integrationId)
    const lockedUntil = integration?.sync_lock_until
      ? new Date(integration.sync_lock_until).getTime()
      : 0
    if (lockedUntil > Date.now()) {
      return false
    }
    await this.updateOngoingIntegrations({
      id: integrationId,
      sync_lock_until: new Date(Date.now() + ttlMs),
    })
    return true
  }

  async releaseSyncLock(integrationId: string): Promise<void> {
    await this.updateOngoingIntegrations({ id: integrationId, sync_lock_until: null })
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
