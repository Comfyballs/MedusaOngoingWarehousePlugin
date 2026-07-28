import type { MedusaContainer } from "@medusajs/framework/types"
import {
  updateOngoingIntegrationHandler,
  compensateOngoingIntegrationHandler,
} from "../update-ongoing-integration"

const previousRow = {
  id: "integ_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "300000",
  status_poll_interval: "60000",
  stock_reconcile_mode: "sellable_plus_reserved" as const,
  edit_sync_rules: null,
  shipped_status_codes: [320],
  delivered_status_codes: null,
  cancellable_status_codes: [100],
}

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) } as unknown as MedusaContainer,
})

describe("updateOngoingIntegrationStep", () => {
  it("snapshots the previous values, applies the update, and returns compensation data", async () => {
    const retrieveOngoingIntegration = jest.fn().mockResolvedValue(previousRow)
    const updated = { ...previousRow, enabled: false }
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(updated)
    const context = makeContext({ retrieveOngoingIntegration, updateOngoingIntegrations })

    const res = await updateOngoingIntegrationHandler({ id: "integ_1", enabled: false }, context)

    expect(updateOngoingIntegrations).toHaveBeenCalledWith({ id: "integ_1", enabled: false })
    expect(res.output).toEqual(updated)
    expect(res.compensateInput).toEqual({
      id: "integ_1",
      previous: {
        enabled: true,
        stock_sync_enabled: true,
        stock_sync_interval: "300000",
        status_poll_interval: "60000",
        stock_reconcile_mode: "sellable_plus_reserved",
        edit_sync_rules: null,
        shipped_status_codes: [320],
        delivered_status_codes: null,
        cancellable_status_codes: [100],
      },
    })
  })
})

describe("compensateOngoingIntegrationStep", () => {
  it("restores the previous values", async () => {
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(previousRow)
    const context = makeContext({ updateOngoingIntegrations })
    const previous = {
      enabled: true,
      stock_sync_enabled: true,
      stock_sync_interval: "300000",
      status_poll_interval: "60000",
      stock_reconcile_mode: "sellable_plus_reserved" as const,
      edit_sync_rules: null,
      shipped_status_codes: [320],
      delivered_status_codes: null,
      cancellable_status_codes: [100],
    }

    await compensateOngoingIntegrationHandler({ id: "integ_1", previous }, context)

    expect(updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "integ_1",
      enabled: true,
      stock_sync_enabled: true,
      stock_sync_interval: "300000",
      status_poll_interval: "60000",
      stock_reconcile_mode: "sellable_plus_reserved",
      edit_sync_rules: null,
      shipped_status_codes: [320],
      delivered_status_codes: null,
      cancellable_status_codes: [100],
    })
  })

  it("is a no-op when there is nothing to compensate", async () => {
    const updateOngoingIntegrations = jest.fn()
    const context = makeContext({ updateOngoingIntegrations })

    await compensateOngoingIntegrationHandler(undefined, context)

    expect(updateOngoingIntegrations).not.toHaveBeenCalled()
  })
})
