import OngoingModuleService from "../service"

const baseOptions = {
  integrations: [
    { key: "wh-1", baseUrl: "https://a", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

const svcWith = (extra: Record<string, unknown>) =>
  new OngoingModuleService({} as any, { ...baseOptions, ...extra } as any)

// Inject an option that bypassed boot validation, to exercise the getter's
// defense-in-depth fallback in isolation (validateOngoingOptions would normally
// reject these at construction — see options.test.ts).
const svcWithRawOption = (field: string, value: unknown) => {
  const svc = svcWith({})
  ;(svc as any).options_ = { ...baseOptions, [field]: value }
  return svc
}

describe("OngoingModuleService interval getters (NaN defense-in-depth, bead f483efcd)", () => {
  it("parses a valid defaultStatusPollInterval", () => {
    expect(svcWith({ defaultStatusPollInterval: "30000" }).getDefaultStatusPollIntervalMs()).toBe(30000)
  })

  it("falls back to 60000 when defaultStatusPollInterval is absent", () => {
    expect(svcWith({}).getDefaultStatusPollIntervalMs()).toBe(60000)
  })

  it("falls back to 60000 when defaultStatusPollInterval is non-numeric (NaN guard)", () => {
    // A NaN here would make isDue() always false — poll once then never again.
    expect(
      svcWithRawOption("defaultStatusPollInterval", "not-a-number").getDefaultStatusPollIntervalMs()
    ).toBe(60000)
  })

  it("falls back to 60000 when defaultStatusPollInterval is non-positive", () => {
    expect(
      svcWithRawOption("defaultStatusPollInterval", "0").getDefaultStatusPollIntervalMs()
    ).toBe(60000)
  })

  it("returns the configured defaultDoneStatusThreshold", () => {
    expect(svcWith({ defaultDoneStatusThreshold: 500 }).getDoneStatusThreshold()).toBe(500)
  })

  it("falls back to the canonical 450 when defaultDoneStatusThreshold is absent", () => {
    expect(svcWith({}).getDoneStatusThreshold()).toBe(450)
  })

  it("falls back to 450 when defaultDoneStatusThreshold is not a non-negative integer", () => {
    // A NaN/negative here would mark every polled order done on its first tick.
    expect(svcWithRawOption("defaultDoneStatusThreshold", "450").getDoneStatusThreshold()).toBe(450)
    expect(svcWithRawOption("defaultDoneStatusThreshold", -1).getDoneStatusThreshold()).toBe(450)
  })

  it("parses a valid defaultStockSyncInterval", () => {
    expect(svcWith({ defaultStockSyncInterval: "120000" }).getDefaultStockSyncIntervalMs()).toBe(120000)
  })

  it("falls back to 600000 when defaultStockSyncInterval is non-numeric", () => {
    expect(
      svcWithRawOption("defaultStockSyncInterval", "bad").getDefaultStockSyncIntervalMs()
    ).toBe(600000)
  })
})
