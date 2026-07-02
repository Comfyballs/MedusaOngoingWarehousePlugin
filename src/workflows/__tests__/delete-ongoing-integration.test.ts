import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { deleteOngoingIntegrationWorkflow } from "../delete-ongoing-integration"

describe("deleteOngoingIntegrationWorkflow", () => {
  it("runs the delete step through the real orchestrator and resolves the standard delete response", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const container: any = createMedusaContainer()
    container.register("ongoing", asValue({ deleteOngoingIntegrations }))

    const { result } = await deleteOngoingIntegrationWorkflow(container).run({
      input: { id: "integ_1" },
    })

    expect(result).toEqual({ id: "integ_1", object: "integration", deleted: true })
    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
  })
})
