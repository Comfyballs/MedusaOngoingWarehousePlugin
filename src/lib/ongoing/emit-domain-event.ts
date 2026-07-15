import type { IEventBusModuleService } from "@medusajs/framework/types"
import type { OngoingEventName } from "./events"

/**
 * Emit an Ongoing domain event as an isolated, best-effort side effect.
 *
 * Callers MUST persist their state (run the state-writing workflow) BEFORE
 * calling this. The emit is wrapped in its own try/catch so an event-bus
 * outage is logged with a distinct "state already persisted" line and
 * swallowed — never rethrown. This closes the two #116 failure modes:
 *
 *  1. An emit that throws AFTER a workflow already succeeded gets caught by
 *     the caller's workflow try/catch and mis-logged as "workflow failed".
 *  2. An emit placed BEFORE the state-persisting workflow throws and skips the
 *     persist entirely (the edit-blocked state is never written even though
 *     the blocking decision was correct).
 *
 * Mirrors the persist-then-emit pattern already used in src/jobs/stock-sync.ts
 * and src/jobs/retry-failed-syncs.ts.
 */
export async function emitDomainEvent<TData>(
  eventBus: IEventBusModuleService,
  logger: { error: (message: string) => void },
  name: OngoingEventName,
  data: TData,
  context?: string
): Promise<void> {
  try {
    await eventBus.emit({ name, data })
  } catch (emitErr) {
    logger.error(
      `[ongoing] failed to emit ${name}${
        context ? ` (${context})` : ""
      } — state already persisted; event-bus emit error: ${
        (emitErr as Error).message
      }`
    )
  }
}
