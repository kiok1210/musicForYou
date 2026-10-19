/**
 * 可移植模块 · 并发控制
 *
 * 「最多同时跑 N 个」是下载队列的刚需，但通用到任何批量任务。
 * 提供两种形态：一次性批处理，与可动态追加的队列。
 * 不依赖 electron / react / node。
 */

/**
 * 按并发上限跑完所有任务，返回结果并保持输入顺序。
 * 单个任务抛错即整体失败（需要「一个失败不影响其他」时请用 TaskQueue）。
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const size = Math.min(Math.max(Math.floor(limit), 1), items.length)
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 可随时 push 的并发队列。
 * 每个任务拿到自己的 Promise，`await queue.push(fn)` 的写法与直接调用无异。
 */
export class TaskQueue {
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(readonly limit: number) {
    if (limit < 1) throw new Error('TaskQueue limit must be >= 1')
  }

  /** 正在执行的任务数 */
  get active(): number {
    return this.running
  }

  /** 排队等待中的任务数 */
  get pending(): number {
    return this.waiting.length
  }

  get idle(): boolean {
    return this.running === 0 && this.waiting.length === 0
  }

  private async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running += 1
  }

  private release(): void {
    this.running -= 1
    this.waiting.shift()?.()
  }

  push<T>(task: () => Promise<T>): Promise<T> {
    return this.acquire().then(async () => {
      try {
        return await task()
      } finally {
        this.release()
      }
    })
  }
}

/** 简单去抖：同一 key 的连续调用只在静默 delay 后执行最后一次 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delay)
  }
}

/**
 * 节流：保证「冷却期内最多执行一次」，并且总是执行最后一次。
 * 适合播放进度落盘这种高频写入。
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  interval: number
): (...args: A) => void {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: A | null = null

  return (...args: A) => {
    const now = Date.now()
    latest = args
    if (now - last >= interval) {
      last = now
      fn(...args)
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      last = Date.now()
      if (latest) fn(...latest)
    }, interval - (now - last))
  }
}
