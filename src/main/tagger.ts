/**
 * 自动标签引擎。
 * 全部基于本地已有信息（标题 / 艺术家 / 时长 / 歌词语言 / YouTube 元数据）推断，
 * 不额外发起网络请求。
 */

import { collectLabels, type KeywordRule } from '@shared/portable/text-rules'

/** 版本 / 演绎形式 */
const VERSION_RULES: KeywordRule[] = [
  { label: '现场版', pattern: /\b(live|concert|on\s*stage)\b|现场|演唱会/i },
  { label: '翻唱', pattern: /\b(cover|covered\s*by|tribute)\b|翻唱/i },
  { label: '混音', pattern: /\b(remix|mashup|bootleg|flip|rework)\b|混音|重编/i },
  { label: '伴奏', pattern: /\b(karaoke|instrumental|off\s*vocal|backing\s*track|minus\s*one)\b|伴奏|纯音乐|无人声/i },
  { label: '不插电', pattern: /\b(unplugged|acoustic)\b|不插电/i },
  { label: '串烧', pattern: /\b(medley|megamix|non-?stop)\b|串烧|联唱/i },
  { label: '电台版', pattern: /\b(radio\s*(edit|version)|on\s*air)\b|电台/i },
  { label: '慢速版', pattern: /\b(slowed|reverb|sped\s*up)\b|慢速|加速版/i }
]

/** 主奏乐器 */
const INSTRUMENT_RULES: KeywordRule[] = [
  { label: '钢琴', pattern: /\b(piano|pianist)\b|钢琴/i },
  { label: '吉他', pattern: /\b(guitar|guitarist)\b|吉他/i },
  { label: '小提琴', pattern: /\b(violin)\b|小提琴/i },
  { label: '大提琴', pattern: /\b(cello)\b|大提琴/i },
  { label: '萨克斯', pattern: /\b(sax|saxophone)\b|萨克斯/i },
  { label: '长笛', pattern: /\b(flute)\b|长笛|竹笛/i },
  { label: '管弦乐', pattern: /\b(orchestra|philharmonic|symphony)\b|管弦|交响/i },
  { label: '古筝', pattern: /\b(guzheng|guzheng|koto)\b|古筝|古琴/i },
  { label: '二胡', pattern: /\b(erhu)\b|二胡/i },
  { label: '手风琴', pattern: /\b(accordion)\b|手风琴/i }
]

/** 音乐风格 */
const GENRE_RULES: KeywordRule[] = [
  { label: '爵士', pattern: /\b(jazz|bossa\s*nova|swing|bebop)\b|爵士/i },
  { label: 'Lo-Fi', pattern: /\b(lo-?fi)\b/i },
  { label: '电子', pattern: /\b(edm|electronic|synthwave|techno|trance|dubstep|house\s*music)\b|电子/i },
  { label: '摇滚', pattern: /\b(rock|metal|punk|grunge)\b|摇滚/i },
  { label: '古典', pattern: /\b(classical|baroque|chopin|beethoven|mozart|bach|debussy)\b|古典/i },
  { label: '民谣', pattern: /\b(folk|country\s*folk|singer-?songwriter)\b|民谣/i },
  { label: 'R&B', pattern: /\b(r&b|rnb|soul|funk|motown)\b/i },
  { label: '说唱', pattern: /\b(hip-?hop|rap|trap)\b|说唱|嘻哈/i },
  { label: '流行', pattern: /\b(pop\b|pop\s*music|top\s*40)\b|流行/i },
  { label: '氛围', pattern: /\b(ambient|drone|new\s*age)\b|氛围/i },
  { label: '民乐', pattern: /\b(chinese\s*traditional|guzheng|erhu|pipa)\b|中国风|国风|民乐/i },
  { label: 'BGM', pattern: /\b(bgm|background\s*music|ost|soundtrack|theme\s*song)\b|背景音乐|配乐|原声/i }
]

/** 场景与情绪 */
const MOOD_RULES: KeywordRule[] = [
  { label: '助眠', pattern: /\b(sleep|bedtime|insomnia)\b|助眠|入睡|安眠/i },
  { label: '放松', pattern: /\b(relax|chill|calm|peaceful|soothing)\b|放松|舒压|治愈|轻音乐/i },
  { label: '学习', pattern: /\b(study|focus|concentrat|reading)\b|学习|专注|看书|自习/i },
  { label: '咖啡厅', pattern: /\b(cafe|coffee\s*shop|lounge|bistro)\b|咖啡/i },
  { label: '运动', pattern: /\b(workout|gym|running|cardio)\b|运动|跑步|健身/i },
  { label: '开车', pattern: /\b(driv(e|ing)|road\s*trip)\b|开车|驾驶|车载/i },
  { label: '雨天', pattern: /\b(rain|rainy)\b|下雨|雨天/i },
  { label: '深夜', pattern: /\b(late\s*night|midnight|3\s*am)\b|深夜|午夜/i },
  { label: '节日', pattern: /\b(christmas|xmas|halloween|new\s*year)\b|圣诞|节日/i },
  { label: '冥想', pattern: /\b(meditation|yoga|mindful)\b|冥想|瑜伽/i },
  { label: '怀旧', pattern: /\b(nostalgi|retro|vintage|oldies)\b|怀旧|复古|经典老歌/i }
]

const LANGUAGE_LABELS: Record<string, string> = {
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

export interface AutoTagInput {
  title: string
  artist: string
  duration: number
  /** 歌词语言代码 */
  language?: string | null
  /** 歌词库标记的纯器乐 */
  instrumental?: boolean
  /** YouTube 提供的分类 / 流派 */
  genre?: string | null
  categories?: string[]
}

/** 时长维度：区分单曲、长曲与合辑 */
function durationTag(duration: number): string | null {
  if (!duration) return null
  if (duration >= 1800) return '合辑'
  if (duration >= 600) return '长曲'
  if (duration > 0 && duration <= 75) return '短曲'
  return null
}

/**
 * 推断一首歌的自动标签。
 * 顺序即展示顺序：语言 → 版本 → 乐器 → 风格 → 场景 → 时长。
 */
export function deriveAutoTags(input: AutoTagInput): string[] {
  const labels: string[] = []
  // 标题和艺术家都参与匹配：很多风格线索藏在频道名里
  const haystack = `${input.title}\n${input.artist}`

  if (input.language && LANGUAGE_LABELS[input.language]) {
    labels.push(LANGUAGE_LABELS[input.language])
  }

  collectLabels(haystack, VERSION_RULES, labels)
  collectLabels(haystack, INSTRUMENT_RULES, labels)
  collectLabels(haystack, GENRE_RULES, labels)
  collectLabels(haystack, MOOD_RULES, labels)

  if (input.instrumental && !labels.includes('纯音乐')) labels.push('纯音乐')

  const genreText = [input.genre, ...(input.categories ?? [])].filter(Boolean).join(' ')
  if (/music/i.test(genreText) && !labels.includes('音乐')) labels.push('音乐')

  const lengthTag = durationTag(input.duration)
  if (lengthTag) labels.push(lengthTag)

  return [...new Set(labels)]
}
