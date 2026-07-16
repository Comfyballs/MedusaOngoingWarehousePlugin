import {
  mapWebhookPayloadToShipmentInput,
  type WebhookShipmentSource,
} from "../map-payload-to-shipment-input"

describe("mapWebhookPayloadToShipmentInput", () => {
  it("maps goodsOwnerOrderId, status code, and non-return waybills", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-1", isReturn: false },
        { waybill: "WB-RET", isReturn: true },
        { waybill: "WB-2", isReturn: false },
      ],
    }

    expect(mapWebhookPayloadToShipmentInput(payload)).toEqual({
      ongoing_order_number: "1001-abc",
      status_code: 200,
      status_text: "",
      tracking_numbers: ["WB-1", "WB-2"],
      tracking: [
        { number: "WB-1", url: undefined },
        { number: "WB-2", url: undefined },
      ],
    })
  })

  it("carries trackingUrl through the structured tracking pairs (bead 5vu)", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-1", trackingUrl: "https://carrier/track/WB-1", isReturn: false },
        { waybill: "WB-RET", trackingUrl: "https://carrier/track/ret", isReturn: true },
      ],
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking).toEqual([
      { number: "WB-1", url: "https://carrier/track/WB-1" },
    ])
  })

  it("always sets status_text to '' (webhook payload has no status text)", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1002-def",
      orderStatus: { number: 210 },
    }
    expect(mapWebhookPayloadToShipmentInput(payload).status_text).toBe("")
  })

  it("returns an empty tracking_numbers array when tracking is undefined", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1003-ghi",
      orderStatus: { number: 200 },
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([])
  })

  it("returns an empty tracking_numbers array when every parcel is a return", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1004-jkl",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-RET-1", isReturn: true },
        { waybill: "WB-RET-2", isReturn: true },
      ],
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([])
  })

  it("preserves outbound parcel order", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1005-mno",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-A", isReturn: false },
        { waybill: "WB-B", isReturn: false },
      ],
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([
      "WB-A",
      "WB-B",
    ])
  })
})
