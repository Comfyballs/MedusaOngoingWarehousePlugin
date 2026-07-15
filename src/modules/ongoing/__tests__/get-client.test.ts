import OngoingModuleService from "../service"

const options = {
  integrations: [
    { key: "wh-1", baseUrl: "https://a", username: "u", password: "p", goodsOwnerId: 1 },
    { key: "wh-2", baseUrl: "https://b", username: "u", password: "p", goodsOwnerId: 2 },
  ],
}

describe("OngoingModuleService.getClient (bead 4s4)", () => {
  it("returns the SAME client instance for repeated calls with one credential_key", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    const a1 = svc.getClient("wh-1")
    const a2 = svc.getClient("wh-1")

    // One shared client (hence one Throttle) per goods owner — not a fresh one per call.
    expect(a1).toBe(a2)
  })

  it("returns DISTINCT clients for different credential_keys", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    expect(svc.getClient("wh-1")).not.toBe(svc.getClient("wh-2"))
  })

  it("still throws for an unknown credential_key (no caching of failures)", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    expect(() => svc.getClient("nope")).toThrow()
  })
})
