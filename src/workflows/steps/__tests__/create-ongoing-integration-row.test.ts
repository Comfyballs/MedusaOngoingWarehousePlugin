import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
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
  container: { resolve: jest.fn(() => service) } as unknown as MedusaContainer,
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

  it("re-tags Medusa's mapped INVALID_DATA duplicate to DUPLICATE_ERROR (422), keeping its message (I6)", async () => {
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    // Medusa's repository dbErrorMapper converts the Postgres 23505 to this
    // BEFORE the step's catch sees it — the realistic mainline shape.
    const mapped = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Ongoing integration with credential_key: wh-1, already exists."
    )
    const createOngoingIntegrations = jest.fn().mockRejectedValue(mapped)
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(
      createOngoingIntegrationRowHandler(validInput, context)
    ).rejects.toMatchObject({
      type: MedusaError.Types.DUPLICATE_ERROR,
      message: "Ongoing integration with credential_key: wh-1, already exists.",
    })
  })

  it("translates a RAW unique violation (23505, unparseable detail) to DUPLICATE_ERROR", async () => {
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    // Edge: dbErrorMapper rethrows the raw MikroORM error when it can't parse a
    // constraint detail, so the SQLSTATE reaches us on `.code`.
    const createOngoingIntegrations = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }))
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(
      createOngoingIntegrationRowHandler(validInput, context)
    ).rejects.toMatchObject({
      type: MedusaError.Types.DUPLICATE_ERROR,
      message: expect.stringContaining("credential_key"),
    })
  })

  it("re-throws a non-duplicate MedusaError(INVALID_DATA) unchanged (e.g. NOT NULL)", async () => {
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    const notNull = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Cannot set field 'credential_key' of Ongoing integration to null"
    )
    const createOngoingIntegrations = jest.fn().mockRejectedValue(notNull)
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(
      createOngoingIntegrationRowHandler(validInput, context)
    ).rejects.toBe(notNull)
  })

  it("re-throws a non-unique DB error unchanged (not masked as a duplicate)", async () => {
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    const boom = Object.assign(new Error("connection reset"), { code: "08006" })
    const createOngoingIntegrations = jest.fn().mockRejectedValue(boom)
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(
      createOngoingIntegrationRowHandler(validInput, context)
    ).rejects.toBe(boom)
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
