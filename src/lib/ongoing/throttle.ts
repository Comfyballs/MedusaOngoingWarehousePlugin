export class Throttle {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error("Throttle maxConcurrent must be >= 1")
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      next()
    }
  }
}
