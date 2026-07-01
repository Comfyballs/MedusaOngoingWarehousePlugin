import OngoingModuleService from "../service"

describe("OngoingModuleService.listCredentialKeys", () => {
  it("returns the configured credential keys in order", () => {
    const svc = new OngoingModuleService({} as any, {
      integrations: [
        { key: "wh-1", baseUrl: "https://a", username: "u", password: "p", goodsOwnerId: 1 },
        { key: "wh-2", baseUrl: "https://b", username: "u", password: "p", goodsOwnerId: 2 },
      ],
    } as any)

    expect(svc.listCredentialKeys()).toEqual(["wh-1", "wh-2"])
  })

  it("returns an empty array when no integrations are configured", () => {
    const svc = new OngoingModuleService({} as any, { integrations: [] } as any)

    expect(svc.listCredentialKeys()).toEqual([])
  })
})
