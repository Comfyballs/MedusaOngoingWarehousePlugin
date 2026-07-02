import { deleteOngoingIntegrationHandler } from "../delete-ongoing-integration"

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) },
})

describe("deleteOngoingIntegrationStep", () => {
  it("deletes the row and returns the standard delete response", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const context = makeContext({ deleteOngoingIntegrations })

    const res = await deleteOngoingIntegrationHandler({ id: "integ_1" }, context)

    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
    expect(res.output).toEqual({ id: "integ_1", object: "integration", deleted: true })
  })
})
