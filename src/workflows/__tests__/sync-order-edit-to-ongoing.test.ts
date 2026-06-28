import { decideOrderEditGate } from "../steps/gate-order-edit"

describe("decideOrderEditGate", () => {
  const base = {
    medusa_order_id: "order_1",
    category: "line_items" as const,
  }

  it("allows when latest_status_code is in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 200,
      },
      integration: { edit_sync_rules: { line_items: [200, 210], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("allowed")
    expect(decision.ongoing_order_number).toBe("1001-abc")
    expect(decision.order_sync_id).toBe("os_1")
    expect(decision.integration_id).toBe("int_1")
  })

  it("blocks when latest_status_code is NOT in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 500,
      },
      integration: { edit_sync_rules: { line_items: [200], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_blocked")
  })

  it("uses the category-specific allow list (address_contact vs line_items)", () => {
    const sync = {
      id: "os_1",
      integration_id: "int_1",
      ongoing_order_number: "1001-abc",
      latest_status_code: 300,
    }
    const rules = { line_items: [200], address_contact: [300] }
    expect(
      decideOrderEditGate({ input: { ...base, category: "address_contact" }, sync, integration: { edit_sync_rules: rules } }).allowed
    ).toBe(true)
    expect(
      decideOrderEditGate({ input: { ...base, category: "line_items" }, sync, integration: { edit_sync_rules: rules } }).allowed
    ).toBe(false)
  })

  it("blocks with status_unknown when latest_status_code is null", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: null },
      integration: { edit_sync_rules: { line_items: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_unknown")
  })

  it("blocks with no_sync_row when there is no sync row", () => {
    const decision = decideOrderEditGate({ input: base, sync: undefined, integration: undefined })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_sync_row")
  })

  it("blocks with no_edit_rules when integration has no edit_sync_rules", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 200 },
      integration: { edit_sync_rules: null },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_edit_rules")
  })
})
