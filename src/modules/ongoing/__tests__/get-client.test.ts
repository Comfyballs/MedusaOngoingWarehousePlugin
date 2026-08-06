import OngoingModuleService from "../service"

const options = {
  integrations: [
    { key: "wh-1", baseUrl: "https://a", username: "u", password: "p" },
    { key: "wh-2", baseUrl: "https://b", username: "u", password: "p" },
  ],
}

describe("OngoingModuleService.getClient (bead 4s4)", () => {
  it("returns the SAME client instance for repeated calls with one (key, goods owner)", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    const a1 = svc.getClient("wh-1", 1)
    const a2 = svc.getClient("wh-1", 1)

    // One shared client (hence one Throttle) per goods owner — not a fresh one per call.
    expect(a1).toBe(a2)
  })

  it("returns DISTINCT clients for different credential_keys", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    expect(svc.getClient("wh-1", 1)).not.toBe(svc.getClient("wh-2", 1))
  })

  // bead 9y2.9: one Ongoing account can serve several goods owners, and a client is
  // bound to one of them, so the cache must key on the pair — not the credential key
  // alone, which would hand warehouse B a client pinned to warehouse A's goods owner.
  it("returns DISTINCT clients for the same credential_key with different goods owners", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    expect(svc.getClient("wh-1", 1)).not.toBe(svc.getClient("wh-1", 2))
  })

  it("still throws for an unknown credential_key (no caching of failures)", () => {
    const svc = new OngoingModuleService({} as any, options as any)

    expect(() => svc.getClient("nope", 1)).toThrow()
  })
})
