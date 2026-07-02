import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"
import { createOngoingIntegrationWorkflow } from "../../../../workflows"
import { validateCreateIntegrationInput } from "./validators"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const integrations = await ongoing.listOngoingIntegrations()
  res.json({ integrations })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const input = validateCreateIntegrationInput(req.body)

  const { result: integration } = await createOngoingIntegrationWorkflow(req.scope).run({ input })

  res.status(201).json({ integration })
}
