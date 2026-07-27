import {
  resolveRetryOutcome,
  MAX_SYNC_RETRIES,
  computeRetryBackoffMs,
  type RetryPolicyInput,
  type RetryOutcome,
} from "../retry-policy"

describe("MAX_SYNC_RETRIES", () => {
  it("is pinned at 5", () => {
    expect(MAX_SYNC_RETRIES).toBe(5)
  })
})

describe("resolveRetryOutcome", () => {
  type Case = {
    name: string
    input: RetryPolicyInput
    maxRetries?: number
    expected: RetryOutcome
  }

  const cases: Case[] = [
    {
      name: "retryable, count 0 → increments, still retryable",
      input: { retry_count: 0, error_class: "retryable" },
      expected: { retry_count: 1, error_class: "retryable", dead_lettered: false },
    },
    {
      name: "retryable, count 3 → increments to 4, still retryable",
      input: { retry_count: 3, error_class: "retryable" },
      expected: { retry_count: 4, error_class: "retryable", dead_lettered: false },
    },
    {
      name: "retryable, count 4 → increments to 5, cap reached → terminal + dead-lettered",
      input: { retry_count: 4, error_class: "retryable" },
      expected: { retry_count: 5, error_class: "terminal", dead_lettered: true },
    },
    {
      name: "null error_class, count 0 → treated as retryable → increments, still retryable",
      input: { retry_count: 0, error_class: null },
      expected: { retry_count: 1, error_class: "retryable", dead_lettered: false },
    },
    {
      name: "null error_class at boundary, count 4 → increments to 5 → terminal + dead-lettered",
      input: { retry_count: 4, error_class: null },
      expected: { retry_count: 5, error_class: "terminal", dead_lettered: true },
    },
    {
      name: "already terminal, count 2 → unchanged count, no further retry, dead-lettered",
      input: { retry_count: 2, error_class: "terminal" },
      expected: { retry_count: 2, error_class: "terminal", dead_lettered: true },
    },
    {
      name: "stored count already at/over cap, retryable, count 5 → increments to 6, terminal (guards >=, never loops)",
      input: { retry_count: 5, error_class: "retryable" },
      expected: { retry_count: 6, error_class: "terminal", dead_lettered: true },
    },
    {
      name: "explicit maxRetries override of 1 → first failure caps immediately",
      input: { retry_count: 0, error_class: "retryable" },
      maxRetries: 1,
      expected: { retry_count: 1, error_class: "terminal", dead_lettered: true },
    },
  ]

  it.each(cases)("$name", ({ input, maxRetries, expected }) => {
    const outcome =
      maxRetries === undefined
        ? resolveRetryOutcome(input)
        : resolveRetryOutcome(input, maxRetries)
    expect(outcome).toEqual(expected)
  })
})

describe("computeRetryBackoffMs", () => {
  // rng: () => 0 pins jitter to zero so the exponential schedule is asserted exactly.
  const noJitter = { rng: () => 0 }

  it("retry 0 → BASE (5 min = 300_000 ms)", () => {
    expect(computeRetryBackoffMs(0, noJitter)).toBe(300_000)
  })

  it("retry 1 → 2× BASE (10 min = 600_000 ms)", () => {
    expect(computeRetryBackoffMs(1, noJitter)).toBe(600_000)
  })

  it("retry 2 → 4× BASE (20 min = 1_200_000 ms)", () => {
    expect(computeRetryBackoffMs(2, noJitter)).toBe(1_200_000)
  })

  it("retry 3 → 8× BASE (40 min = 2_400_000 ms)", () => {
    expect(computeRetryBackoffMs(3, noJitter)).toBe(2_400_000)
  })

  it("retry 4 → capped at MAX (60 min = 3_600_000 ms)", () => {
    expect(computeRetryBackoffMs(4, noJitter)).toBe(3_600_000)
  })

  it("retry 10 → still capped at MAX (3_600_000 ms)", () => {
    expect(computeRetryBackoffMs(10, noJitter)).toBe(3_600_000)
  })

  it("retry 0 with explicit opts base=1000, cap=4000 → 1000", () => {
    expect(computeRetryBackoffMs(0, { baseMs: 1_000, capMs: 4_000, rng: () => 0 })).toBe(1_000)
  })

  it("retry 2 with explicit opts base=1000, cap=4000 → capped at 4000", () => {
    expect(computeRetryBackoffMs(2, { baseMs: 1_000, capMs: 4_000, rng: () => 0 })).toBe(4_000)
  })

  describe("jitter (bead e6f)", () => {
    it("adds full +20% jitter when rng returns 1", () => {
      // 300_000 + 300_000 * 0.2 * 1 = 360_000
      expect(computeRetryBackoffMs(0, { rng: () => 1 })).toBe(360_000)
    })

    it("adds half the jitter band when rng returns 0.5", () => {
      // 300_000 + 300_000 * 0.2 * 0.5 = 330_000
      expect(computeRetryBackoffMs(0, { rng: () => 0.5 })).toBe(330_000)
    })

    it("jitter is purely additive — never earlier than the base exponential delay", () => {
      const base = computeRetryBackoffMs(2, { rng: () => 0 })
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        expect(computeRetryBackoffMs(2, { rng: () => r })).toBeGreaterThanOrEqual(base)
      }
    })

    it("respects an explicit jitterRatio override", () => {
      // 300_000 + 300_000 * 0.5 * 1 = 450_000
      expect(computeRetryBackoffMs(0, { jitterRatio: 0.5, rng: () => 1 })).toBe(450_000)
    })

    it("defaults to Math.random and stays within [delay, delay*1.2]", () => {
      for (let i = 0; i < 50; i++) {
        const v = computeRetryBackoffMs(1)
        expect(v).toBeGreaterThanOrEqual(600_000)
        expect(v).toBeLessThanOrEqual(720_000)
      }
    })
  })
})
