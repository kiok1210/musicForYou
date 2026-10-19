/**
 * 可移植模块 · 字幕与歌词解析
 *
 * 「把带时间轴的文本变成结构化行」这件事，音乐歌词、播客逐字稿、视频字幕完全一样。
 * 本文件收录三种最常见格式的解析、文本清洗、语言检测与双语对齐，
 * 不 import electron / react，不读写文件、不发请求，可整文件复制进任何项目。
 */

export interface TimedLine {
  /** 起始秒数；-1 表示该行没有时间轴 */
  time: number
  text: string
}

export interface TranslatedLine extends TimedLine {
  translation: string | null
}

const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const LRC_CUE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const VTT_CUE =
  /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/
const VTT_HEADER = /^(WEBVTT|NOTE|STYLE|Kind:|Language:|X-TIMESTAMP)/i

/** 把 mm:ss(.fff) 或 hh:mm:ss(.fff) 的分段换算成秒 */
function partsToSeconds(
  hoursOrMinutes: string,
  minutesOrSeconds: string,
  secondsOrFraction?: string,
  fraction?: string
): number {
  let base = Number(hoursOrMinutes) * 60 + Number(minutesOrSeconds)
  let fractionText = secondsOrFraction
  if (fraction !== undefined) {
    base = base * 60 + Number(secondsOrFraction)
    fractionText = fraction
  }
  if (fractionText === undefined) return base
  return base + Number(`0.${fractionText.padEnd(3, '0').slice(0, 3)}`)
}

/** 解析 LRC 歌词；同一行挂多个时间戳时会展开成多行 */
export function parseLrc(raw: string): TimedLine[] {
  const lines: TimedLine[] = []
  for (const source of raw.split(/\r?\n/)) {
    const stamps: number[] = []
    LRC_TAG.lastIndex = 0
    let match = LRC_TAG.exec(source)
    while (match) {
      stamps.push(partsToSeconds(match[1], match[2], match[3]))
      match = LRC_TAG.exec(source)
    }
    if (!stamps.length) continue
    const text = source.replace(LRC_TAG, '').trim()
    if (!text) continue
    for (const time of stamps) lines.push({ time, text })
  }
  return lines.sort((a, b) => a.time - b.time)
}

/** 去掉字幕里的标签与实体，压平空白 */
export function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析 WebVTT。
 * YouTube 的滚动字幕会出现连续重复行，这里按文本去重。
 */
export function parseVtt(raw: string): TimedLine[] {
  const lines: TimedLine[] = []
  let pendingTime: number | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (pendingTime === null) return
    const time = pendingTime
    const text = cleanSubtitleText(buffer.join(' '))
    pendingTime = null
    buffer = []
    if (!text) return
    const last = lines[lines.length - 1]
    if (last && last.text === text) return
    lines.push({ time, text })
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    const cue = VTT_CUE.exec(line)
    if (cue) {
      flush()
      pendingTime = Number(cue[1]) * 3600 + Number(cue[2]) * 60 + Number(cue[3])
      pendingTime += Number(`0.${String(cue[4]).padEnd(3, '0').slice(0, 3)}`)
      continue
    }
    if (!line) {
      flush()
      continue
    }
    if (VTT_HEADER.test(line)) continue
    if (pendingTime === null) continue
    buffer.push(line)
  }
  flush()
  return lines
}

/** 没有时间轴的纯文本，逐行降级为无时间行 */
export function parsePlain(raw: string): TimedLine[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ time: -1, text }))
}

/** 依据首个能识别的时间标签自动判断格式 */
export function parseTimedText(raw: string): TimedLine[] {
  const head = raw.slice(0, 4000)
  if (/^WEBVTT/m.test(head) || VTT_CUE.test(head)) return parseVtt(raw)
  if (LRC_CUE.test(head)) return parseLrc(raw)
  return parsePlain(raw)
}

/* ── 语言识别 ──────────────────────────────────────────── */

export const LANGUAGE_LABELS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  ru: '俄语',
  ar: '阿拉伯语',
  th: '泰语',
  fr: '法语',
  de: '德语',
  es: '西语',
  it: '意语',
  pt: '葡语'
}

/**
 * 够用即可的语种判断：不追求学术准确，只用于「要不要翻译」「该给识别模型什么提示」。
 * 假名/谚文优先于汉字，这样中日混排不会误判成中文。
 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 1200)
  const count = (pattern: RegExp): number => (sample.match(pattern) ?? []).length
  const han = count(/[\u4e00-\u9fff]/g)
  const kana = count(/[\u3040-\u30ff]/g)
  const hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/g)
  const cyrillic = count(/[\u0400-\u04ff]/g)
  const arabic = count(/[\u0600-\u06ff]/g)
  const thai = count(/[\u0e00-\u0e7f]/g)
  const latin = count(/[a-z]/gi)

  if (kana > 2) return 'ja'
  if (hangul > 2) return 'ko'
  if (han > latin && han > 2) return 'zh'
  if (cyrillic > 4) return 'ru'
  if (arabic > 4) return 'ar'
  if (thai > 4) return 'th'
  if (latin > 4) return 'en'
  return 'unknown'
}

export function languageLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return LANGUAGE_LABELS[code] ?? null
}

export function isChinese(code: string | null | undefined): boolean {
  return code === 'zh'
}

/**
 * 从标题等短文本推测语种，用于给语音识别模型提示。
 * 不加提示时 Whisper 会把中文歌声直接意译成英文。
 */
export function guessLanguageFromTitle(text: string): string | null {
  const count = (pattern: RegExp): number => (text.match(pattern) ?? []).length
  if (count(/[\u3040-\u30ff]/g) > 1) return 'ja'
  if (count(/[\uac00-\ud7af]/g) > 1) return 'ko'
  if (count(/[\u4e00-\u9fff]/g) > 1) return 'zh'
  return null
}

/* ── 双语对齐 ──────────────────────────────────────────── */

/**
 * 把译文按时间就近挂到原文行上。
 * 典型用途：YouTube 原文轨 + 自动翻译轨，两者的时间轴天然接近但不完全一致。
 */
export function mergeTranslation(
  primary: TimedLine[],
  secondary: TimedLine[],
  toleranceSeconds = 3
): TranslatedLine[] {
  if (!secondary.length) {
    return primary.map((line) => ({ ...line, translation: null }))
  }
  return primary.map((line) => {
    let best: TimedLine | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (const candidate of secondary) {
      const diff = Math.abs(candidate.time - line.time)
      if (diff < bestDiff) {
        bestDiff = diff
        best = candidate
      }
    }
    return {
      ...line,
      translation: best && bestDiff <= toleranceSeconds ? best.text : null
    }
  })
}

/** 按行顺序把译文逐行贴上（行数一致时最可靠） */
export function attachTranslations(primary: TimedLine[], translations: string[]): TranslatedLine[] {
  return primary.map((line, index) => ({
    ...line,
    translation: translations[index]?.trim() || null
  }))
}
