import {
  mapWebhookPayloadToReturnStatusInput,
  type WebhookReturnStatusSource,
} from "../map-payload-to-return-status-input"

describe("mapWebhookPayloadToReturnStatusInput", () => {
  it("returns hasReturnActivity: false when no tracking/parcels are return-flagged", () => {
    const payload: WebhookReturnStatusSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 200 },
      tracking: [{ waybill: "WB-1", isReturn: false }],
    }
    expect(mapWebhookPayloadToReturnStatusInput(payload)).toEqual({
      hasReturnActivity: false,
    })
  })

  it("returns hasReturnActivity: false when tracking/parcels are absent", () => {
    const payload: WebhookReturnStatusSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 200 },
    }
    expect(mapWebhookPayloadToReturnStatusInput(payload)).toEqual({
      hasReturnActivity: false,
    })
  })

  it("collects return waybills from tracking[isReturn]", () => {
    const payload: WebhookReturnStatusSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 400, text: "Return received" },
      tracking: [
        { waybill: "WB-1", isReturn: false },
        { waybill: "WB-RET", isReturn: true },
      ],
    }
    expect(mapWebhookPayloadToReturnStatusInput(payload)).toEqual({
      hasReturnActivity: true,
      input: {
        ongoing_order_number: "1001-abc",
        status_code: 400,
        status_text: "Return received",
        return_tracking_numbers: ["WB-RET"],
        return_parcel_numbers: [],
      },
    })
  })

  it("collects return parcel numbers from parcels[isReturnParcel]", () => {
    const payload: WebhookReturnStatusSource = {
      goodsOwnerOrderId: "1002-def",
      orderStatus: { number: 400 },
      parcels: [
        { parcelNumber: "P-1", isReturnParcel: false },
        { parcelNumber: "P-RET", isReturnParcel: true },
      ],
    }
    expect(mapWebhookPayloadToReturnStatusInput(payload)).toEqual({
      hasReturnActivity: true,
      input: {
        ongoing_order_number: "1002-def",
        status_code: 400,
        status_text: "",
        return_tracking_numbers: [],
        return_parcel_numbers: ["P-RET"],
      },
    })
  })

  it("defaults ongoing_order_number to '' when goodsOwnerOrderId is missing", () => {
    const payload: WebhookReturnStatusSource = {
      orderStatus: { number: 400 },
      tracking: [{ waybill: "WB-RET", isReturn: true }],
    }
    expect(mapWebhookPayloadToReturnStatusInput(payload)).toEqual({
      hasReturnActivity: true,
      input: {
        ongoing_order_number: "",
        status_code: 400,
        status_text: "",
        return_tracking_numbers: ["WB-RET"],
        return_parcel_numbers: [],
      },
    })
  })
})
