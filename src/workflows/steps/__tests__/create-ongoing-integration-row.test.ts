import { MedusaError } from "@medusajs/framework/utils"
import {
  createOngoingIntegrationRowHandler,
  compensateOngoingIntegrationRowHandler,
  type CreateOngoingIntegrationRowInput,
} from "../create-ongoing-integration-row"

const validInput: CreateOngoingIntegrationRowInput = {
  credential_key: "wh-1",
  stock_location_id: "sloc_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: null,
  status_poll_interval: null,
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules: null,
  shipped_status_codes: null,
  cancellable_status_codes: null,
}

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) },
})

describe("createOngoingIntegrationRowStep", () => {
  it("validates the credential_key, creates the row, and returns compensation data", async () => {
    const created = { id: "integ_1", ...validInput }
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    const createOngoingIntegrations = jest.fn().mockResolvedValue(created)
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    const res = await createOngoingIntegrationRowHandler(validInput, context)

    expect(getCredentials).toHaveBeenCalledWith("wh-1")
    expect(createOngoingIntegrations).toHaveBeenCalledWith(validInput)
    expect(res.output).toEqual(created)
    expect(res.compensateInput).toEqual({ integrationId: "integ_1" })
  })

  it("throws MedusaError(INVALID_DATA) for an unknown credential_key, without creating a row", async () => {
    const getCredentials = jest.fn(() => {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
    })
    const createOngoingIntegrations = jest.fn()
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(createOngoingIntegrationRowHandler(validInput, context)).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrations).not.toHaveBeenCalled()
  })
})

describe("compensateOngoingIntegrationRowStep", () => {
  it("deletes the row that was created", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const context = makeContext({ deleteOngoingIntegrations })

    await compensateOngoingIntegrationRowHandler({ integrationId: "integ_1" }, context)

    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
  })

  it("is a no-op when there is nothing to compensate", async () => {
    const deleteOngoingIntegrations = jest.fn()
    const context = makeContext({ deleteOngoingIntegrations })

    await compensateOngoingIntegrationRowHandler(undefined, context)

    expect(deleteOngoingIntegrations).not.toHaveBeenCalled()
  })
})
