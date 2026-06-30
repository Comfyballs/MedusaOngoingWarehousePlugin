import {
  resolveRetryOutcome,
  MAX_SYNC_RETRIES,
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
