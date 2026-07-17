import {
  deriveBurstChangedTypes,
  hasAddressContactChange,
  ADDRESS_CONTACT_DETAIL_TYPES,
  ORDER_CHANGE_BURST_WINDOW_MS,
} from "../order-change-burst"

describe("deriveBurstChangedTypes", () => {
  it("returns an empty array when there are no rows", () => {
    expect(deriveBurstChangedTypes([])).toEqual([])
    expect(deriveBurstChangedTypes(null)).toEqual([])
    expect(deriveBurstChangedTypes(undefined)).toEqual([])
  })

  it("returns the single row's type for a single-row change", () => {
    const rows = [
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows)).toEqual(["shipping_address"])
  })

  it("unions detail types across rows within the burst window (address+locale bundle)", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(new Set(deriveBurstChangedTypes(rows))).toEqual(
      new Set(["locale", "shipping_address"])
    )
  })

  it("excludes a row older than the burst window from a separate earlier edit", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:02.500Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    // 2500ms gap > default 2000ms window
    expect(deriveBurstChangedTypes(rows)).toEqual(["locale"])
  })

  it("includes a row exactly at the burst window boundary", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:02.000Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    // exactly 2000ms gap == default window, inclusive
    expect(new Set(deriveBurstChangedTypes(rows))).toEqual(
      new Set(["locale", "shipping_address"])
    )
  })

  it("respects a custom burstWindowMs override", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.500Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows, 100)).toEqual(["locale"])
  })

  it("ignores rows/actions with a missing or non-string details.type", () => {
    const rows = [
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: {} }, { details: undefined }],
      },
    ]
    expect(deriveBurstChangedTypes(rows as any)).toEqual([])
  })

  it("dedupes a repeated type across rows in the same burst", () => {
    const rows = [
      {
        id: "ordch_2",
        created_at: "2026-07-03T10:00:00.010Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_1",
        created_at: "2026-07-03T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]
    expect(deriveBurstChangedTypes(rows)).toEqual(["shipping_address"])
  })
})

describe("hasAddressContactChange", () => {
  it("is true when any changed type is in ADDRESS_CONTACT_DETAIL_TYPES", () => {
    expect(hasAddressContactChange(["metadata", "billing_address"])).toBe(true)
  })

  it("is false when no changed type is address/contact", () => {
    expect(hasAddressContactChange(["metadata", "locale"])).toBe(false)
  })

  it("is false for an empty array", () => {
    expect(hasAddressContactChange([])).toBe(false)
  })
})

describe("ADDRESS_CONTACT_DETAIL_TYPES", () => {
  it("contains exactly the classified detail types", () => {
    // Verified against Medusa 2.16.0 updateOrderWorkflow (see order-change-burst.ts
    // comment): "contact" is not a real detail type and was removed.
    expect([...ADDRESS_CONTACT_DETAIL_TYPES].sort()).toEqual(
      ["billing_address", "email", "shipping_address"].sort()
    )
  })
})

describe("ORDER_CHANGE_BURST_WINDOW_MS", () => {
  it("defaults to 2000ms", () => {
    expect(ORDER_CHANGE_BURST_WINDOW_MS).toBe(2000)
  })
})
