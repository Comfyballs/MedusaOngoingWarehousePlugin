import { Throttle } from "../throttle"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("Throttle", () => {
  it("never runs more than maxConcurrent at once", async () => {
    const throttle = new Throttle(2)
    let active = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]

    const tasks = gates.map((g) =>
      throttle.run(async () => {
        active++
        peak = Math.max(peak, active)
        await g.promise
        active--
      })
    )

    // Let the first batch start.
    await Promise.resolve()
    expect(active).toBe(2)

    // Release all gates, allowing the queue to drain.
    gates.forEach((g) => g.resolve())
    await Promise.all(tasks)

    expect(peak).toBe(2)
  })

  it("returns each task's resolved value", async () => {
    const throttle = new Throttle(1)
    const results = await Promise.all([
      throttle.run(async () => "a"),
      throttle.run(async () => "b"),
    ])
    expect(results).toEqual(["a", "b"])
  })

  it("frees a slot when a task rejects", async () => {
    const throttle = new Throttle(1)
    await expect(throttle.run(async () => { throw new Error("x") })).rejects.toThrow("x")
    await expect(throttle.run(async () => "ok")).resolves.toBe("ok")
  })
})
