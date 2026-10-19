/**
 * 可移植模块 · 分类与分组
 *
 * 「把一堆条目按主题归类、一键筛选、自动打标」是内容型应用的通用能力。
 * 这里的实现与具体媒体类型无关（播客单集、歌曲、视频都能用），
 * 也不依赖 Electron / React，可直接复制进任何项目。
 */

export interface Group<T> {
  key: string
  items: T[]
  /** 该组的数值合计，例如总时长、总大小 */
  total: number
}

/**
 * 按 keyOf 分组，并保序：先按 groupOrder 指定的顺序，
 * 其余组按条目数量从多到少排在后面。
 */
export function groupBy<T>(
  items: T[],
  keyOf: (item: T) => string,
  measure: (item: T) => number = () => 1,
  groupOrder: string[] = []
): Group<T>[] {
  const map = new Map<string, Group<T>>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = map.get(key)
    if (bucket) {
      bucket.items.push(item)
      bucket.total += measure(item)
    } else {
      map.set(key, { key, items: [item], total: measure(item) })
    }
  }

  const rank = new Map(groupOrder.map((key, index) => [key, index]))
  return [...map.values()].sort((a, b) => {
    const rankA = rank.get(a.key) ?? Number.POSITIVE_INFINITY
    const rankB = rank.get(b.key) ?? Number.POSITIVE_INFINITY
    if (rankA !== rankB) return rankA - rankB
    if (b.items.length !== a.items.length) return b.items.length - a.items.length
    return a.key.localeCompare(b.key, 'zh-CN')
  })
}

/* ── 关键词打标 ───────────────────────────────────────── */

/** 归一化：小写、去 emoji / 标点、压缩空白，让匹配不受排版干扰 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[|｜/／·•_\-–—]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 打分：命中特征词即计分（整词命中比子串命中权重更高），
 * 便于在多个候选分类里挑最贴合的一个。
 */
export function scoreByMarkers(text: string, markers: string[]): number {
  const haystack = normalizeText(text)
  if (!haystack) return 0
  const padded = ` ${haystack} `
  let score = 0
  for (const marker of markers) {
    const needle = normalizeText(marker)
    if (!needle) continue
    if (padded.includes(` ${needle} `)) score += 3
    else if (haystack.includes(needle)) score += 1
  }
  return score
}

export interface ClassifierBucket {
  id: string
  markers: string[]
}

/**
 * 从候选分类中挑出得分最高且高于阈值的一个。
 * 没有明显归属时返回 fallback，让界面永远有地方安放条目。
 */
export function inferBucket(
  text: string,
  buckets: ClassifierBucket[],
  options: { threshold?: number; fallback?: string } = {}
): string {
  const { threshold = 3, fallback = 'other' } = options
  let best = fallback
  let bestScore = 0
  for (const bucket of buckets) {
    const score = scoreByMarkers(text, bucket.markers)
    if (score > bestScore) {
      bestScore = score
      best = bucket.id
    }
  }
  return bestScore >= threshold ? best : fallback
}

/** 按关键词在文本里的位置排序，用于「搜索建议」之类的场景 */
export function rankByKeyword<T>(items: T[], keyword: string, textOf: (item: T) => string): T[] {
  const needle = normalizeText(keyword)
  if (!needle) return items
  return items
    .map((item) => {
      const position = normalizeText(textOf(item)).indexOf(needle)
      return { item, position: position < 0 ? Number.POSITIVE_INFINITY : position }
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.item)
}
