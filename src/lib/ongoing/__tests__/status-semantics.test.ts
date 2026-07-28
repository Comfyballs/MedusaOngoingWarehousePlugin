import {
  CANONICAL_ONGOING_STATUS_STAGES,
  CANONICAL_SHIPPED_STATUS_CODES,
  CANONICAL_DELIVERED_STATUS_CODES,
  resolveShipmentStage,
} from "../status-semantics"

describe("ongoing status semantics", () => {
  describe("canonical map", () => {
    it("classifies the documented codes into the expected stages", () => {
      expect(CANONICAL_ONGOING_STATUS_STAGES[200]).toBe("created")
      expect(CANONICAL_ONGOING_STATUS_STAGES[300]).toBe("picking")
      expect(CANONICAL_ONGOING_STATUS_STAGES[320]).toBe("picking")
      expect(CANONICAL_ONGOING_STATUS_STAGES[400]).toBe("picked")
      expect(CANONICAL_ONGOING_STATUS_STAGES[425]).toBe("shipped")
      expect(CANONICAL_ONGOING_STATUS_STAGES[450]).toBe("shipped")
      expect(CANONICAL_ONGOING_STATUS_STAGES[451]).toBe("shipped")
      expect(CANONICAL_ONGOING_STATUS_STAGES[475]).toBe("returned")
      expect(CANONICAL_ONGOING_STATUS_STAGES[500]).toBe("delivered")
      expect(CANONICAL_ONGOING_STATUS_STAGES[1000]).toBe("cancelled")
    })

    it("derives the default shipped/delivered code arrays from the canonical map", () => {
      expect(CANONICAL_SHIPPED_STATUS_CODES).toEqual([425, 450, 451])
      expect(CANONICAL_DELIVERED_STATUS_CODES).toEqual([500])
    })
  })

  describe("resolveShipmentStage", () => {
    it("uses canonical defaults when config lists are null/empty", () => {
      const cfg = { shippedCodes: null, deliveredCodes: null }
      expect(resolveShipmentStage(400, cfg)).toBe("other") // picked, not shipped
      expect(resolveShipmentStage(450, cfg)).toBe("shipped")
      expect(resolveShipmentStage(451, cfg)).toBe("shipped")
      expect(resolveShipmentStage(500, cfg)).toBe("delivered")
      expect(resolveShipmentStage(200, cfg)).toBe("other")
    })

    it("falls back to canonical defaults with no config at all", () => {
      expect(resolveShipmentStage(450)).toBe("shipped")
      expect(resolveShipmentStage(500)).toBe("delivered")
    })

    it("treats an empty array the same as null (canonical fallback)", () => {
      expect(resolveShipmentStage(450, { shippedCodes: [] })).toBe("shipped")
      expect(resolveShipmentStage(500, { deliveredCodes: [] })).toBe("delivered")
    })

    it("lets an explicit shipped list override the canonical default", () => {
      // Operator models 400 (picked) as their "shipped" trigger.
      const cfg = { shippedCodes: [400], deliveredCodes: null }
      expect(resolveShipmentStage(400, cfg)).toBe("shipped")
      // 450 is no longer treated as shipped once the list is explicit.
      expect(resolveShipmentStage(450, cfg)).toBe("other")
    })

    it("checks delivered before shipped so 500 wins even if also listed as shipped", () => {
      const cfg = { shippedCodes: [450, 500], deliveredCodes: [500] }
      expect(resolveShipmentStage(500, cfg)).toBe("delivered")
      expect(resolveShipmentStage(450, cfg)).toBe("shipped")
    })

    it("classifies an unknown code as other", () => {
      expect(resolveShipmentStage(999, { shippedCodes: [450], deliveredCodes: [500] })).toBe("other")
    })
  })
})
