import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { flagOrphanedOrderSyncsWorkflow } from "../../../../../workflows"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { result } = await flagOrphanedOrderSyncsWorkflow(req.scope).run({
    input: {},
  })

  res.status(200).json(result)
}
