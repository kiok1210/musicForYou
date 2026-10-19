import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { session } from 'electron'
import type { LyricLine, Lyrics, Track } from '@shared/types'
import {
  detectLanguage,
  isChinese,
  mergeTranslation,
  parseLrc,
  parsePlain,
  parseVtt,
  type TimedLine
} from '@shared/portable/subtitles'
import { searchCandidates } from '@shared/portable/format'
import type { CacheStore } from './library'
import { resolveProxyArgs } from './tools'
import { spawnYtDlp } from './ytdlp'

// 解析能力来自可移植层，这里转出去供其他模块使用
export { detectLanguage, parseLrc, parsePlain, parseVtt, searchCandidates }

const USER_AGENT = 'VinylBox/0.1.0 (Windows; local music cache player)'
/** 空结果的缓存有效期：过期后自动重试，避免一次失败被永久记住 */
const EMPTY_CACHE_TTL = 12 * 60 * 60 * 1000
/** 单批翻译的字符上限，避免 URL 过长被拒 */
const TRANSLATE_BATCH_CHARS = 1100

/* ── 解析：统一来自可移植层，两个姊妹项目共用一份实现 ─── */

/** 可移植层只关心时间与文本，这里补上翻译位 */
function toLyricLines(lines: TimedLine[]): LyricLine[] {
  return lines.map((line) => ({ ...line, translation: null }))
}

/* ── 网络请求 ─────────────────────────────────────────── */

let networkSession: Electron.Session | null = null

async function sessionForProxy(proxy: string | null): Promise<Electron.Session> {
  if (!proxy) return session.defaultSession
  if (!networkSession) networkSession = session.fromPartition('vinylbox-network')
  await networkSession.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>' })
  return networkSession
}

async function activeProxy(store: CacheStore): Promise<string | null> {
  const settings = store.getSettings()
  const { proxy } = await resolveProxyArgs(settings.proxyMode, settings.proxy)
  return proxy
}

async function requestText(
  url: string,
  store: CacheStore,
  options: { timeoutMs?: number; viaProxy?: boolean } = {}
): Promise<string> {
  const { timeoutMs = 12_000, viaProxy = false } = options
  const proxy = viaProxy ? await activeProxy(store) : null
  const target = await sessionForProxy(proxy)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await target.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/plain,*/*' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/* ── 歌词源：lrclib ───────────────────────────────────── */

interface LrclibRecord {
  id?: number
  trackName?: string
  artistName?: string
  name?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

/** 时长允许的偏差：至少 20 秒，或目标时长的 5% */
function durationTolerance(targetDuration: number): number {
  return Math.max(20, targetDuration * 0.05)
}

function pickBestRecord(records: LrclibRecord[], targetDuration: number): LrclibRecord | null {
  const usable = records.filter(
    (record) => !record.instrumental && (record.syncedLyrics || record.plainLyrics)
  )
  if (!usable.length) return null
  if (!targetDuration) return usable[0]

  // 时长对不上的一律排除。
  // 否则「一小时合辑」「长混音」这类标题党会被模糊搜索匹配到毫不相干的单曲，
  // 结果是歌词是别人的、语言也被判错。
  const tolerance = durationTolerance(targetDuration)
  const aligned = usable.filter(
    (record) =>
      typeof record.duration === 'number' &&
      record.duration > 0 &&
      Math.abs(record.duration - targetDuration) <= tolerance
  )
  if (!aligned.length) return null

  // 时长最接近的优先；其次有同步歌词的优先
  return [...aligned].sort((a, b) => {
    const scoreA = Math.abs((a.duration ?? 0) - targetDuration) - (a.syncedLyrics ? 8 : 0)
    const scoreB = Math.abs((b.duration ?? 0) - targetDuration) - (b.syncedLyrics ? 8 : 0)
    return scoreA - scoreB
  })[0]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fromLrclib(
  track: Track,
  store: CacheStore
): Promise<{ lyrics: Lyrics | null; transient: boolean }> {
  const candidates = searchCandidates(track.title, track.artist)
  let transient = false

  for (const [index, query] of candidates.entries()) {
    // 候选之间稍作间隔，避免触发 lrclib 的速率限制
    if (index > 0) await delay(280)
    let raw: string
    try {
      raw = await requestText(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, store, {
        timeoutMs: 8000
      })
    } catch (err) {
      if (/HTTP (429|503)/.test(err instanceof Error ? err.message : String(err))) transient = true
      continue
    }
    let records: LrclibRecord[]
    try {
      const parsed = JSON.parse(raw) as LrclibRecord[]
      records = Array.isArray(parsed) ? parsed : []
    } catch {
      continue
    }
    const best = pickBestRecord(records, track.duration)
    if (!best) continue

    const lines = toLyricLines(
      best.syncedLyrics ? parseLrc(best.syncedLyrics) : parsePlain(best.plainLyrics ?? '')
    )
    if (!lines.length) continue

    return {
      transient: false,
      lyrics: {
        source: 'lrclib',
        synced: Boolean(best.syncedLyrics) && lines.some((line) => line.time >= 0),
        language: detectLanguage(lines.map((line) => line.text).join('\n')),
        lines,
        translated: false,
        matchedTitle: best.trackName ?? best.name ?? null,
        matchedArtist: best.artistName ?? null,
        fetchedAt: Date.now()
      }
    }
  }
  return { lyrics: null, transient }
}

/* ── 歌词源：YouTube 字幕（自带多语言自动翻译） ────────── */

/** 下载语言：中文用来看译文，其余用来识别原文。请求越少越不容易被限流 */
const SUB_LANGS = 'zh-Hans,zh-CN,zh,en,ja,ko'

interface SubsOutcome {
  lyrics: Lyrics | null
  note?: string
  /** 临时性失败（限流 / 网络），空结果不应写进缓存 */
  transient: boolean
}

async function downloadSubtitles(
  track: Track,
  store: CacheStore
): Promise<{ files: string[]; note?: string; transient: boolean }> {
  const args = [
    `https://www.youtube.com/watch?v=${track.id}`,
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    SUB_LANGS,
    '--sub-format',
    'vtt',
    '--no-warnings',
    ...(await store.requestArgs()),
    '-o',
    path.join(store.subsDir, '%(id)s.%(ext)s')
  ]
  const { stdout, stderr, timedOut } = await spawnYtDlp(args, { timeoutMs: 30_000 })
  const entries = await fsp.readdir(store.subsDir).catch(() => [] as string[])
  const files = entries.filter((name) => name.startsWith(`${track.id}.`) && name.endsWith('.vtt'))
  if (files.length) return { files, transient: false }

  const log = `${stderr}\n${stdout}`
  if (/429|Too Many Requests/i.test(log)) {
    return {
      files: [],
      transient: true,
      note: 'YouTube 字幕服务暂时限流，稍后点「重新匹配」即可重试'
    }
  }
  if (timedOut) {
    return { files: [], transient: true, note: '字幕请求超时，请检查网络后重试' }
  }
  return { files: [], transient: false }
}

function languageOfSubtitleFile(fileName: string, trackId: string): string {
  const rest = fileName.slice(trackId.length + 1).replace(/\.vtt$/i, '')
  return rest.split('.').pop() ?? rest
}



async function fromYoutube(track: Track, store: CacheStore): Promise<SubsOutcome> {
  const { files, note, transient } = await downloadSubtitles(track, store)
  if (!files.length) return { lyrics: null, note, transient }

  const parsed = new Map<string, LyricLine[]>()
  for (const file of files) {
    const language = languageOfSubtitleFile(file, track.id)
    const content = await fsp.readFile(path.join(store.subsDir, file), 'utf8').catch(() => '')
    if (!content) continue
    const lines = toLyricLines(parseVtt(content))
    if (lines.length) parsed.set(language, lines)
    // 解析完即清理，避免 subs 目录堆积
    await fsp.rm(path.join(store.subsDir, file), { force: true })
  }
  if (!parsed.size) return { lyrics: null, transient: false }

  const chineseKey = [...parsed.keys()].find((key) => /^zh/i.test(key))
  const chinese = chineseKey ? parsed.get(chineseKey)! : null
  const originalKey = [...parsed.keys()].find((key) => !/^zh/i.test(key))
  const original = originalKey ? parsed.get(originalKey)! : null

  // 原文 + 中文译文并存时，直接得到双语对照（时间轴天然对齐）
  if (original && chinese) {
    return {
      transient: false,
      lyrics: {
        source: 'youtube',
        synced: original.some((line) => line.time >= 0),
        language: detectLanguage(original.map((line) => line.text).join('\n')),
        lines: mergeTranslation(original, chinese),
        translated: true,
        matchedTitle: null,
        matchedArtist: null,
        fetchedAt: Date.now()
      }
    }
  }

  const single = original ?? chinese
  if (!single) return { lyrics: null, transient: false }
  return {
    transient: false,
    lyrics: {
      source: 'youtube',
      synced: single.some((line) => line.time >= 0),
      language: detectLanguage(single.map((line) => line.text).join('\n')),
      lines: single,
      translated: Boolean(chinese && !original),
      matchedTitle: null,
      matchedArtist: null,
      fetchedAt: Date.now()
    }
  }
}

/* ── 翻译 ─────────────────────────────────────────────── */

function mapToMyMemoryCode(language: string): string {
  const table: Record<string, string> = {
    zh: 'zh-CN',
    en: 'en-GB',
    ja: 'ja-JP',
    ko: 'ko-KR',
    ru: 'ru-RU',
    ar: 'ar-SA',
    th: 'th-TH'
  }
  return table[language] ?? 'en-GB'
}

/** 引擎 1：Google 免密钥接口（需经代理，共享出口 IP 可能被临时限流） */
async function translateWithGoogle(texts: string[], store: CacheStore): Promise<string[] | null> {
  const payload = texts.join('\n')
  const endpoints = [
    'https://translate.googleapis.com/translate_a/single',
    'https://translate.google.com/translate_a/single'
  ]
  for (const endpoint of endpoints) {
    try {
      const url = `${endpoint}?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(payload)}`
      const raw = await requestText(url, store, { viaProxy: true, timeoutMs: 15_000 })
      if (raw.trimStart().startsWith('<')) continue
      const data = JSON.parse(raw) as [Array<[string, string]>, ...unknown[]]
      const translated = (data[0] ?? []).map((segment) => segment[0] ?? '').join('')
      if (!translated) continue
      const lines = translated.split('\n')
      if (lines.length === texts.length) return lines
      return texts.map((_, index) => lines[index] ?? '')
    } catch {
      /* 尝试下一个端点 */
    }
  }
  return null
}

/** 引擎 2：MyMemory（直连可用；多行不可靠时逐行重试） */
async function translateWithMyMemory(
  texts: string[],
  store: CacheStore
): Promise<string[] | null> {
  const attempt = async (source: string[]): Promise<string[] | null> => {
    const joined = source.join('\n')
    const pair = `${mapToMyMemoryCode(detectLanguage(joined))}|zh-CN`
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(joined)}&langpair=${encodeURIComponent(pair)}`
    const raw = await requestText(url, store, { timeoutMs: 15_000 })
    const data = JSON.parse(raw) as { responseData?: { translatedText?: string } }
    const translated = data.responseData?.translatedText ?? ''
    if (!translated) return null
    const lines = translated.split('\n')
    return lines.length === source.length ? lines : null
  }

  const batched = await attempt(texts).catch(() => null)
  if (batched) return batched

  // 多行容易踩到配额或换行丢失，退化成逐行（限制条数避免长时间等待）
  const limit = Math.min(texts.length, 60)
  const result: string[] = []
  for (let index = 0; index < limit; index += 1) {
    const text = texts[index]
    if (!text.trim()) {
      result.push('')
      continue
    }
    const single = await attempt([text]).catch(() => null)
    if (!single || !single[0]) return null
    result.push(single[0])
  }
  return result
}

async function translateBatch(texts: string[], store: CacheStore): Promise<string[] | null> {
  return (await translateWithGoogle(texts, store)) ?? (await translateWithMyMemory(texts, store))
}

/** 逐行翻译，内部按字符数分批 */
async function translateLines(texts: string[], store: CacheStore): Promise<string[] | null> {
  const result: string[] = new Array(texts.length).fill('')
  let batch: number[] = []
  let size = 0

  const flush = async (): Promise<boolean> => {
    if (!batch.length) return true
    const pending = batch
    const translated = await translateBatch(
      pending.map((index) => texts[index]),
      store
    )
    batch = []
    size = 0
    if (!translated) return false
    pending.forEach((index, k) => {
      result[index] = translated[k] ?? ''
    })
    return true
  }

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index].trim()
    if (!text) continue
    if (size && size + text.length > TRANSLATE_BATCH_CHARS) {
      if (!(await flush())) return null
    }
    batch.push(index)
    size += text.length + 1
  }
  if (!(await flush())) return null
  return result
}

/* ── 对外入口 ─────────────────────────────────────────── */

function lyricsFile(store: CacheStore, trackId: string): string {
  return path.join(store.lyricsDir, `${trackId}.json`)
}

async function readCached(file: string): Promise<Lyrics | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as Lyrics
  } catch {
    return null
  }
}

/** 只读缓存，不发起网络请求。用于重算标签时回填语言信息 */
export function readLyricsCache(store: CacheStore, trackId: string): Promise<Lyrics | null> {
  return readCached(lyricsFile(store, trackId))
}

/** 写入歌词缓存（本地识别结果走这里） */
export async function saveLyrics(
  store: CacheStore,
  trackId: string,
  lyrics: Lyrics
): Promise<void> {
  await fsp
    .writeFile(lyricsFile(store, trackId), JSON.stringify(lyrics, null, 2), 'utf8')
    .catch(() => undefined)
}

/**
 * 给一份已有的歌词补中文翻译。
 * 本地识别得到的歌词没有译文，走同样的引擎补一次。
 */
export async function localizeLyrics(lyrics: Lyrics, store: CacheStore): Promise<Lyrics> {
  const settings = store.getSettings()
  if (!settings.autoTranslate || lyrics.translated || !lyrics.lines.length) return lyrics
  const language = lyrics.language ?? detectLanguage(lyrics.lines.map((line) => line.text).join('\n'))
  lyrics.language = language
  if (isChinese(language)) return lyrics

  const translations = await translateLines(
    lyrics.lines.map((line) => line.text),
    store
  )
  if (translations) {
    lyrics.lines = lyrics.lines.map((line, index) => ({
      ...line,
      translation: translations[index]?.trim() || null
    }))
    lyrics.translated = lyrics.lines.some((line) => Boolean(line.translation))
  }
  if (!lyrics.translated) lyrics.note = '翻译服务暂时不可用，已显示原文'
  return lyrics
}

export async function fetchLyrics(
  track: Track,
  store: CacheStore,
  force = false
): Promise<Lyrics> {
  const file = lyricsFile(store, track.id)
  if (!force) {
    const cached = await readCached(file)
    if (cached) {
      const usable = cached.lines.length > 0
      const fresh = Date.now() - (cached.fetchedAt ?? 0) < EMPTY_CACHE_TTL
      if (usable || fresh) return cached
    }
  }

  const settings = store.getSettings()
  let result: Lyrics | null = null
  let transientNote: string | undefined
  let transient = false

  try {
    const outcome = await fromLrclib(track, store)
    result = outcome.lyrics
    if (outcome.transient) transient = true
  } catch {
    /* 换下一个来源 */
  }

  if (!result || !result.lines.length) {
    try {
      const outcome = await fromYoutube(track, store)
      if (outcome.lyrics) result = outcome.lyrics
      if (outcome.note) transientNote = outcome.note
      if (outcome.transient) transient = true
    } catch {
      /* 换下一个来源 */
    }
  }

  if (!result || !result.lines.length) {
    const empty: Lyrics = {
      source: 'none',
      synced: false,
      language: null,
      lines: [],
      translated: false,
      matchedTitle: null,
      matchedArtist: null,
      note:
        transientNote ??
        '暂未收录这首歌的歌词。合辑、直播回放等非单曲内容通常无法匹配。',
      fetchedAt: Date.now()
    }
    // 限流 / 超时属于临时状态：不写缓存，下次播放会自动重试
    if (!transient) {
      await fsp.writeFile(file, JSON.stringify(empty, null, 2), 'utf8').catch(() => undefined)
    }
    return empty
  }

  // 非中文且尚无译文时，自动补中文翻译
  if (settings.autoTranslate && !result.translated && result.lines.length) {
    const language = result.language ?? detectLanguage(result.lines.map((line) => line.text).join('\n'))
    result.language = language
    if (!isChinese(language)) {
      const translations = await translateLines(
        result.lines.map((line) => line.text),
        store
      )
      if (translations) {
        result.lines = result.lines.map((line, index) => ({
          ...line,
          translation: translations[index]?.trim() || null
        }))
        result.translated = result.lines.some((line) => Boolean(line.translation))
      }
      if (!result.translated) result.note = '翻译服务暂时不可用，已显示原文'
    }
  }

  await fsp.writeFile(file, JSON.stringify(result, null, 2), 'utf8').catch(() => undefined)
  return result
}
