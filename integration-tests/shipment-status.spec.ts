import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import type { OngoingPluginOptions, OngoingTrackedOrder } from "../src/lib/ongoing/types"
import {
  CREDENTIAL_KEY,
  GOODS_OWNER_ID,
  ONGOING_BASE_URL,
  buildContainer,
  makeFakeQuery,
} from "./_shared/l2"

// Layer 2 — wh5.7: shipment webhook route + status-poll job driving
// syncOngoingShipmentWorkflow end-to-end against the REAL DB-backed ongoing module.
//
// applyOrderShipmentStep writes the fulfillment shipment/tracking via the core
// @medusajs/medusa/order|fulfillment createOrderShipmentWorkflow — those core
// modules are ABSENT from a moduleIntegrationTestRunner container (see epic wh5
// DESIGN). We stub that ONE seam with the exact same fake the pure unit suite uses
// (src/workflows/steps/__tests__/apply-order-shipment.test.ts,
// src/workflows/__tests__/sync-ongoing-shipment.test.ts) and assert the fulfillment
// write through it. Everything upstream — webhook auth, body parsing, the
// outbound/return-parcel filter (map-payload-to-shipment-input.ts), the
// status-poll job's due/lock/getOrdersByStatus flow, loadSyncForShipmentStep,
// markOrderSyncShippedStep — runs for REAL, so the OngoingOrderSync row actually
// advancing in Postgres is the genuine L2 value-add. True HTTP-route-via-api-client
// coverage against a real fulfillment-module registration is deferred to the
// full-app harness (bead wh5.9).
// Preserve every other @medusajs/core-flows export (e.g. useQueryGraphStep, which
// setup-location.ts needs and the ../../../../workflows barrel re-exports
// transitively) — only createOrderShipmentWorkflow is stubbed.
const run = jest.fn()
jest.mock("@medusajs/core-flows", () => ({
  ...jest.requireActual("@medusajs/core-flows"),
  createOrderShipmentWorkflow: jest.fn(() => ({ run })),
}))
import { createOrderShipmentWorkflow } from "@medusajs/core-flows"
import { POST } from "../src/api/ongoing/webhooks/[credentialKey]/route"
import ongoingStatusPollJob from "../src/jobs/status-poll"

const LOCATION_ID = "loc_shipment"
const WEBHOOK_SECRET = "s3cret-token"

const OPTIONS: OngoingPluginOptions = {
  integrations: [
    {
      key: CREDENTIAL_KEY,
      baseUrl: ONGOING_BASE_URL,
      username: "user",
      password: "pass",
      goodsOwnerId: GOODS_OWNER_ID,
      webhookSecret: WEBHOOK_SECRET,
    },
  ],
}

// Full Logger-shaped spy for the module boot injectedDependencies slot (mirrors
// push-order-to-ongoing.spec.ts / fulfillment-provider.spec.ts).
const spyLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
  activity: jest.fn(),
  progress: jest.fn(),
  success: jest.fn(),
  failure: jest.fn(),
  panic: jest.fn(),
  setLogLevel: jest.fn(),
  unsetLogLevel: jest.fn(),
  shouldLog: jest.fn(() => true),
}

function makeReq(opts: {
  token?: string
  body?: unknown
  scope: unknown
}): MedusaRequest {
  return {
    params: { credentialKey: CREDENTIAL_KEY },
    headers: opts.token === undefined ? {} : { "x-auth-token": opts.token },
    body: opts.body,
    scope: opts.scope,
  } as unknown as MedusaRequest
}

function makeRes(): MedusaResponse {
  return { sendStatus: jest.fn() } as unknown as MedusaResponse
}

function webhookBody(overrides: Record<string, unknown> = {}) {
  return {
    webhookOrdersId: 1,
    webhookEventId: 2,
    orderId: 1001,
    orderNumber: "SO-1001",
    goodsOwnerOrderId: "1001-ship",
    goodsOwnerId: GOODS_OWNER_ID,
    orderStatus: { number: 320, text: "Shipped" },
    // Outbound (isReturn:false) + a return parcel (isReturn:true) — the mapper
    // (map-payload-to-shipment-input.ts) must drop the latter from the labels
    // the shipment workflow writes.
    tracking: [
      { waybill: "TRK-OUT", trackingUrl: "https://carrier/TRK-OUT", isReturn: false },
      { waybill: "TRK-RET", trackingUrl: "https://carrier/TRK-RET", isReturn: true },
    ],
    timestamp: "2026-07-17T12:00:00.0000000Z",
    ...overrides,
  }
}

moduleIntegrationTestRunner<OngoingModuleService>({
  moduleName: ONGOING_MODULE,
  moduleModels: [OngoingIntegration, OngoingOrderSync],
  moduleOptions: OPTIONS,
  resolve: "./src/modules/ongoing",
  injectedDependencies: {
    [ContainerRegistrationKeys.LOGGER]: spyLogger,
  },
  testSuite: ({ service }) => {
    describe("shipment webhook + status-poll — Layer 2 (real DB, core-flows shipment stubbed)", () => {
      let integrationId: string

      beforeEach(async () => {
        // Fresh DB per test (runner re-inits the module) — seed one integration
        // bound to the fixed shipped-status code the tests dispatch against.
        // model.json() types shipped_status_codes as Record<string, unknown> | null in
        // the generated DTO though its real runtime shape is number[] | null (same
        // documented cast as src/workflows/steps/create-ongoing-integration-row.ts).
        const created = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: LOCATION_ID,
          enabled: true,
          shipped_status_codes: [320] as unknown as Record<string, unknown>,
        })
        integrationId = created.id
        run.mockReset()
        run.mockResolvedValue({ result: undefined })
        ;(createOrderShipmentWorkflow as unknown as jest.Mock).mockClear()
      })

      describe("POST /ongoing/webhooks/:credentialKey — verified shipment webhook", () => {
        it("verified in-band webhook writes the shipment+tracking (fake, outbound-only) and advances the sync row (real DB)", async () => {
          await service.recordSync({
            ongoing_order_number: "1001-ship",
            integration_id: integrationId,
            medusa_order_id: "order_1",
            medusa_fulfillment_id: "ful_1",
            sync_state: "sent",
          })

          const { container } = buildContainer({ service, query: makeFakeQuery([]) })
          const res = makeRes()

          await POST(
            makeReq({ token: WEBHOOK_SECRET, body: webhookBody(), scope: container }),
            res
          )

          expect(res.sendStatus).toHaveBeenCalledWith(200)

          // Fulfillment shipment+tracking write asserted via the fake (core Order/
          // Fulfillment modules are absent here — real route-through coverage is
          // bead wh5.9).
          expect(run).toHaveBeenCalledTimes(1)
          expect(run).toHaveBeenCalledWith({
            input: expect.objectContaining({
              order_id: "order_1",
              fulfillment_id: "ful_1",
              items: [],
              no_notification: false,
            }),
          })
          const labels = (run.mock.calls[0][0] as { input: { labels: Array<{ tracking_number: string; tracking_url: string }> } })
            .input.labels
          // Outbound waybill only — the return parcel (isReturn:true) is excluded.
          expect(labels).toEqual([
            { tracking_number: "TRK-OUT", tracking_url: "https://carrier/TRK-OUT", label_url: "" },
          ])

          // Real Postgres: the OngoingOrderSync row advanced to 'shipped'.
          const [row] = await service.listOngoingOrderSyncs({
            ongoing_order_number: "1001-ship",
          })
          expect(row).toMatchObject({
            sync_state: "shipped",
            latest_status_code: 320,
            medusa_order_id: "order_1",
            medusa_fulfillment_id: "ful_1",
          })
          expect(row.shipped_at).not.toBeNull()
        })

        it("bad X-Auth-Token -> 401, no workflow side effects, sync row untouched (real DB)", async () => {
          await service.recordSync({
            ongoing_order_number: "1001-badauth",
            integration_id: integrationId,
            medusa_order_id: "order_2",
            medusa_fulfillment_id: "ful_2",
            sync_state: "sent",
          })

          const { container } = buildContainer({ service, query: makeFakeQuery([]) })
          const res = makeRes()

          await POST(
            makeReq({
              token: "wrong-token",
              body: webhookBody({ goodsOwnerOrderId: "1001-badauth" }),
              scope: container,
            }),
            res
          )

          expect(res.sendStatus).toHaveBeenCalledWith(401)
          expect(run).not.toHaveBeenCalled()

          const [row] = await service.listOngoingOrderSyncs({
            ongoing_order_number: "1001-badauth",
          })
          expect(row).toMatchObject({ sync_state: "sent" })
          expect(row.shipped_at).toBeNull()
        })

        it("missing X-Auth-Token -> 401, no workflow side effects", async () => {
          const { container } = buildContainer({ service, query: makeFakeQuery([]) })
          const res = makeRes()

          await POST(makeReq({ body: webhookBody(), scope: container }), res)

          expect(res.sendStatus).toHaveBeenCalledWith(401)
          expect(run).not.toHaveBeenCalled()
        })
      })

      describe("status-poll job — getOrdersByStatus tracking write-back", () => {
        it("pulls tracking via getOrdersByStatus and advances the due integration's sync row to shipped (real DB)", async () => {
          await service.recordSync({
            ongoing_order_number: "1001-poll",
            integration_id: integrationId,
            medusa_order_id: "order_9",
            medusa_fulfillment_id: "ful_9",
            sync_state: "sent",
          })

          // Stub the transport at the client the module service caches per
          // credential_key — pollAndApply resolves this exact same cached
          // instance via service.getClient(integration.credential_key).
          const client = service.getClient(CREDENTIAL_KEY)
          const getOrdersByStatus = jest
            .spyOn(client, "getOrdersByStatus")
            .mockResolvedValue([
              {
                ongoingOrderId: 555,
                orderNumber: "1001-poll",
                statusNumber: 320,
                statusText: "Shipped",
                trackingNumbers: ["TRK-POLL"],
                tracking: [{ number: "TRK-POLL", url: "https://carrier/TRK-POLL" }],
              },
            ] satisfies OngoingTrackedOrder[])

          const { container } = buildContainer({ service, query: makeFakeQuery([]) })

          await ongoingStatusPollJob(container)

          // Wide active-status range (100..999) per status-poll.ts's ONGOING_ACTIVE_STATUS_*.
          expect(getOrdersByStatus).toHaveBeenCalledWith(100, 999)

          // Same fake seam as the webhook path — the tracking write-back reaches
          // the fulfillment shipment call.
          expect(run).toHaveBeenCalledWith({
            input: expect.objectContaining({
              order_id: "order_9",
              fulfillment_id: "ful_9",
              labels: [
                { tracking_number: "TRK-POLL", tracking_url: "https://carrier/TRK-POLL", label_url: "" },
              ],
            }),
          })

          const [row] = await service.listOngoingOrderSyncs({
            ongoing_order_number: "1001-poll",
          })
          expect(row).toMatchObject({
            sync_state: "shipped",
            latest_status_code: 320,
            latest_status_text: "Shipped",
          })
          expect(row.shipped_at).not.toBeNull()

          getOrdersByStatus.mockRestore()
        })
      })
    })
  },
})
