import { GET } from "../route"

const makeService = (keys: string[]) => ({
  listCredentialKeys: jest.fn(() => keys),
})

const makeReq = (service: ReturnType<typeof makeService>) =>
  ({
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("GET /admin/ongoing/credential-keys", () => {
  it("returns the configured credential keys", async () => {
    const service = makeService(["wh-1", "wh-2"])
    const res = makeRes()

    await GET(makeReq(service), res)

    expect(service.listCredentialKeys).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ credential_keys: ["wh-1", "wh-2"] })
  })

  it("returns an empty list when no integrations are configured", async () => {
    const service = makeService([])
    const res = makeRes()

    await GET(makeReq(service), res)

    expect(res.json).toHaveBeenCalledWith({ credential_keys: [] })
  })
})
