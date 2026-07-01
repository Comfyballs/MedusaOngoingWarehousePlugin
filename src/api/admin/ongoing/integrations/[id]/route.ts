import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../../modules/ongoing"
import OngoingModuleService from "../../../../../modules/ongoing/service"
import { updateOngoingIntegrationWorkflow, deleteOngoingIntegrationWorkflow } from "../../../../../workflows"
import { validateUpdateIntegrationInput } from "./validators"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const integration = await ongoing.retrieveOngoingIntegration(id)
  res.json({ integration })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params
  const update = validateUpdateIntegrationInput(req.body)

  const { result: integration } = await updateOngoingIntegrationWorkflow(req.scope).run({
    input: { id, ...update },
  })

  res.json({ integration })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params

  const { result } = await deleteOngoingIntegrationWorkflow(req.scope).run({ input: { id } })

  res.json(result)
}
