import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import type { OngoingPluginOptions } from "../src/lib/ongoing/types"

// Layer 2 boot smoke: prove the plugin's `ongoing` module registers, migrates, and
// resolves inside a real DB-backed Medusa module container — the wiring the unit suite
// mocks away. Ongoing is NEVER contacted here; these are well-formed fake plugin
// options, enough to satisfy validateOngoingOptions at boot (both in the module-service
// constructor and the validate-options loader) with no network access.
const FAKE_OPTIONS: OngoingPluginOptions = {
  integrations: [
    {
      key: "test-wh",
      baseUrl: "https://ongoing.test/api/v1",
      username: "user",
      password: "pass",
      goodsOwnerId: 1,
    },
  ],
}

// The validate-options loader resolves LOGGER from the module container and logs a
// one-line summary. Injecting a spy logger both (a) satisfies that resolve in the
// isolated module container and (b) lets us assert the loader actually ran at boot.
const loggerInfo = jest.fn()
const spyLogger = {
  info: loggerInfo,
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
  activity: jest.fn(),
  progress: jest.fn(),
  success: jest.fn(),
  failure: jest.fn(),
  panic: jest.fn(),
  setLogLevel: jest.fn(),
  unsetLogLevel: jest.fn(),
  shouldLog: jest.fn(() => true),
}

moduleIntegrationTestRunner<OngoingModuleService>({
  moduleName: ONGOING_MODULE,
  moduleModels: [OngoingIntegration, OngoingOrderSync],
  moduleOptions: FAKE_OPTIONS,
  // Load the real module definition (service + validate-options loader) from source,
  // resolved relative to the project root (the runner's default cwd).
  resolve: "./src/modules/ongoing",
  injectedDependencies: {
    [ContainerRegistrationKeys.LOGGER]: spyLogger,
  },
  testSuite: ({ service }) => {
    describe("ongoing module — Layer 2 boot smoke", () => {
      it("resolves the OngoingModuleService from a real DB-backed container", () => {
        expect(service).toBeDefined()
        expect(typeof service.getCredentials).toBe("function")
      })

      it("flowed plugin options through to the service (constructor validation ran)", () => {
        const creds = service.getCredentials("test-wh")
        expect(creds.baseUrl).toBe("https://ongoing.test/api/v1")
        expect(creds.goodsOwnerId).toBe(1)
      })

      it("is the real service, not a stub — unknown credential key throws MedusaError", () => {
        expect(() => service.getCredentials("does-not-exist")).toThrow(MedusaError)
      })

      it("ran the validate-options loader at boot", () => {
        // validate-options.ts logs `[ongoing] validated N warehouse integration(s)`.
        expect(loggerInfo).toHaveBeenCalledWith(
          expect.stringContaining("validated 1 warehouse integration")
        )
      })
    })
  },
})
