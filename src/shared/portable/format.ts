/**
 * 可移植模块 · 格式化与标题清洗
 *
 * 时长 / 体积 / 相对时间的展示格式化，以及「把平台标题洗成可检索词」——
 * 后者是搜索下载类项目共通的难点：标题里塞满 emoji、`Official MV`、`｜` 分段。
 * 纯函数，不依赖 electron / react / node。
 */

/** 秒 → 3:07 / 1:02:33，非法值给占位符 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 时间戳 → 刚刚 / 12 分钟前 / 今天 14:32 / 昨天 22:31 / 10月12日 21:08 / 2026/1/5 */
export function formatRelative(timestamp: number, now = Date.now()): string {
  if (!timestamp) return ''
  const diff = now - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  // 一小时以上就带上钟点与分钟：同一小时里的多批结果靠它才分得开
  const date = new Date(timestamp)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const startOfToday = today.getTime()
  if (timestamp >= startOfToday) return `今天 ${hm}`
  if (timestamp >= startOfToday - day) return `昨天 ${hm}`
  if (date.getFullYear() === today.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
  }
  return date.toLocaleDateString('zh-CN')
}

/**
 * 去掉标题里的营销噪声：emoji、`(Official Video)`、`【MV】`、`[4K]`、
 * 以及 `Official / Lyrics / MV / HD` 这类版式词。
 */
export function cleanMediaTitle(raw: string): string {
  return raw
    .replace(/\((?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|visualizer|mv|hd|4k)\)/gi, '')
    .replace(/\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|visualizer|mv|hd|4k)\]/gi, '')
    .replace(/【[^】]{0,30}】/g, '')
    .replace(/「[^」]{0,30}」/g, '')
    .replace(/\b(?:official|lyrics?|video|audio|mv|hd|4k|remaster(?:ed)?|topic)\b/gi, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 由平台标题 + 频道名生成候选检索词，按「最可能命中」排序。
 *
 * 平台标题常见三种结构：`歌名 - 艺术家`、`艺术家｜歌名｜更多`、
 * 以及纯标题党（`最好听的 100 首…`）。这里把它们切开并组合出几种查询，
 * 让下游的歌词库 / 字幕库有机会命中任何一种。
 */
export function searchCandidates(title: string, artist: string, limit = 3): string[] {
  const stripNoise = (input: string): string =>
    input
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
      .replace(/[（(][^）)]{0,40}(?:official|mv|pv|lyric|video|audio|hd|4k)[^）)]{0,40}[）)]/gi, ' ')
      .replace(/【[^】]{0,30}】/g, ' ')
      .replace(/「[^」]{0,30}」/g, ' ')
      .replace(/\[[^\]]{0,30}\]/g, ' ')
      .replace(/\b(?:official|lyrics?|video|audio|mv|hd|4k|remaster(?:ed)?)\b/gi, ' ')
      .replace(/[|｜/／]+/g, ' | ')
      .replace(/\s{2,}/g, ' ')
      .trim()

  const cleaned = stripNoise(title)
  const segments = cleaned
    .split(/\s*\|\s*|\s+-\s+|\s+–\s+|\s+—\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)

  const artistClean = stripNoise(artist).replace(/\s*-\s*topic$/i, '').trim()
  const candidates = new Set<string>()

  if (segments.length) candidates.add(segments[0])
  if (segments.length > 1) candidates.add(segments[1])
  candidates.add(cleaned)
  candidates.add(title.trim())
  if (artistClean && segments.length) candidates.add(`${artistClean} ${segments[0]}`)

  return [...candidates].filter((item) => item.length >= 2).slice(0, limit)
}

/** 截断长文本用于日志或提示，保持末尾可读 */
export function ellipsis(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
