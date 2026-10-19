/**
 * 可移植模块 · 播放增强
 *
 * 倍速播放、断点续听、睡眠定时——三件「长内容播放器」都该有、但音乐播放器
 * 常常忽略的事。这里全部是纯函数，不依赖 Electron / React / DOM，
 * 可以直接把本文件复制进任何播放器项目（含 musicForYou）后使用。
 */

/* ── 倍速 ─────────────────────────────────────────────── */

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const

/** 把任意数值吸附到最近的受支持倍速，避免出现 1.0000001 这种脏值 */
export function nearestRate(rate: number): number {
  let best: number = PLAYBACK_RATES[1]
  let bestDiff = Number.POSITIVE_INFINITY
  for (const candidate of PLAYBACK_RATES) {
    const diff = Math.abs(candidate - rate)
    if (diff < bestDiff) {
      bestDiff = diff
      best = candidate
    }
  }
  return best
}

/** 在倍速档位之间循环，供「点一下换个速度」的交互使用 */
export function cycleRate(current: number, direction = 1): number {
  const index = PLAYBACK_RATES.indexOf(nearestRate(current) as (typeof PLAYBACK_RATES)[number])
  const next = (index + direction + PLAYBACK_RATES.length) % PLAYBACK_RATES.length
  return PLAYBACK_RATES[next]
}

export function formatRate(rate: number): string {
  const fixed = Number.isInteger(rate) ? rate.toFixed(0) : String(rate)
  return `${fixed}×`
}

/* ── 断点续听 ─────────────────────────────────────────── */

/** 听到不足这么久就退出，不值得记忆 */
export const RESUME_MIN_SECONDS = 15
/** 距离结尾不足这么久，视为「已听完」 */
export const RESUME_TAIL_SECONDS = 30

/**
 * 决定从第几秒开始播放。
 * - 没有历史进度时从头开始
 * - 进度太靠前（< RESUME_MIN_SECONDS）或已经接近结尾时也从头开始
 */
export function resumePosition(duration: number, savedSeconds: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  if (!Number.isFinite(savedSeconds) || savedSeconds < RESUME_MIN_SECONDS) return 0
  if (duration - savedSeconds <= RESUME_TAIL_SECONDS) return 0
  return Math.min(savedSeconds, Math.max(0, duration - 1))
}

/** 是否已听完（用于列表划线、统计） */
export function isFinished(duration: number, position: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false
  return duration - position <= RESUME_TAIL_SECONDS
}

export function progressRatio(duration: number, position: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0, Math.min(1, position / duration))
}

/* ── 播放顺序 ─────────────────────────────────────────── */

/**
 * 生成一个打乱的播放顺序（Fisher-Yates）。
 *
 * 返回的是「索引数组」而不是曲目本身：队列随时会变（删歌、流式曲目落盘后换成
 * 本地文件），索引比对象更经得起变化。把当前这首挪到最前面，
 * 免得刚打开随机就跳到别的歌上去。
 */
export function shuffleOrder(total: number, current = -1, random = Math.random): number[] {
  const order = Array.from({ length: total }, (_, index) => index)
  for (let i = total - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  if (current >= 0) {
    const at = order.indexOf(current)
    if (at > 0) {
      const tmp = order[0]
      order[0] = order[at]
      order[at] = tmp
    }
  }
  return order
}

/** 顺序（非随机）的播放顺序 */
export function sequentialOrder(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index)
}

/**
 * 沿播放顺序走一步，返回新的游标位置；走到尽头且不许循环时返回 -1。
 */
export function stepPosition(
  length: number,
  position: number,
  delta: number,
  wrap: boolean
): number {
  if (length <= 0) return -1
  let next = position + delta
  if (next < 0 || next >= length) {
    if (!wrap) return -1
    next = (next + length) % length
  }
  return next
}

/* ── 睡眠定时 ─────────────────────────────────────────── */

export const SLEEP_PRESETS = [15, 30, 45, 60, 90] as const

/** 由「还剩多少分钟」得到截止时间戳 */
export function sleepDeadline(minutes: number, now = Date.now()): number {
  return now + Math.max(0, minutes) * 60_000
}

export function sleepRemainingSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function shouldSleep(deadline: number, now = Date.now()): boolean {
  return deadline > 0 && now >= deadline
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
