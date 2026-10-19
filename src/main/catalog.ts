import type { ContentKind, MusicCategory, SubCategory } from '@shared/types'
import { scoreByMarkers } from '@shared/portable/collections'

/**
 * 音乐分类目录。
 *
 * 每个分类同时承担两件事：
 * - `keywords`：「发现更多」拿去搜 YouTube 的查询词，内置多条并在点击时轮换，
 *   避免同一个分类永远只搜到同一批结果
 * - `markers`：下载后按「标题 + 频道名」自动归类的特征词，命中即打上分类名标签；
 *   因为分类名本身就是标签，所以筛选栏、分类看板都能直接复用标签体系
 *
 * 关键词刻意中英混排：中文词命中华语内容，英文词命中海外内容，两边都覆盖。
 */
const MUSIC_SEEDS: Omit<MusicCategory, 'kind'>[] = [
  {
    id: 'jazz',
    name: '爵士',
    blurb: '慵懒沙发、Bossa Nova 与深夜小酒馆',
    keywords: ['smooth jazz music', 'jazz cafe music playlist', 'bossa nova playlist', '爵士乐 慵懒'],
    markers: ['jazz', 'bossa', 'swing', 'bebop', 'saxophone', '爵士', '萨克斯'],
    accent: '#e0b25c'
  },
  {
    id: 'lofi',
    name: 'Lo-Fi 学习',
    blurb: '写作业、读论文、敲代码时的背景声',
    keywords: ['lofi hip hop study', 'lofi beats to relax', 'chillhop mix', 'lofi 学习 音乐'],
    markers: ['lofi', 'lo-fi', 'chillhop', 'study beats', '学习', '专注'],
    accent: '#6ea8fe'
  },
  {
    id: 'classical',
    name: '古典',
    blurb: '钢琴、弦乐与交响乐的经典曲目',
    keywords: ['classical music playlist', 'piano sonata', 'relaxing classical music', '古典音乐 钢琴'],
    markers: ['classical', 'symphony', 'sonata', 'concerto', 'chopin', 'beethoven', '古典', '交响'],
    accent: '#c58cf0'
  },
  {
    id: 'chinese-style',
    name: '中国风',
    blurb: '古筝、国风与东方意境',
    keywords: ['古风音乐 歌曲', '中国风 音乐', 'guzheng music', 'chinese traditional music'],
    markers: ['中国风', '国风', '古风', 'guzheng', 'guqin', 'erhu', 'pipa', '古筝', '古琴', '二胡', '民乐'],
    accent: '#e07a5f'
  },
  {
    id: 'folk',
    name: '民谣',
    blurb: '吉他、故事与温柔的嗓音',
    keywords: ['acoustic folk songs', '民谣 歌曲 吉他', 'indie folk playlist', 'singer songwriter acoustic'],
    markers: ['folk', 'acoustic', '民谣', '吉他弹唱', 'singer songwriter'],
    accent: '#8fbf6e'
  },
  {
    id: 'electronic',
    name: '电子',
    blurb: '合成器、氛围电子与舞曲',
    keywords: ['electronic music mix', 'synthwave playlist', 'chill electronic music', '电子音乐 纯音乐'],
    markers: ['edm', 'electronic', 'synthwave', 'techno', 'trance', 'house music', '电子'],
    accent: '#4fd1c5'
  },
  {
    id: 'rock',
    name: '摇滚',
    blurb: '经典摇滚、独立与现场感',
    keywords: ['classic rock playlist', 'rock anthems', 'indie rock mix', '摇滚 经典 歌曲'],
    markers: ['rock', 'metal', 'punk', 'grunge', '摇滚', '乐队'],
    accent: '#e2665f'
  },
  {
    id: 'rnb-soul',
    name: 'R&B / Soul',
    blurb: '律动、灵魂乐与深夜情调',
    keywords: ['rnb soul mix', 'neo soul playlist', 'funk music playlist', 'rnb 音乐'],
    markers: ['r&b', 'rnb', 'soul', 'funk', 'motown', '灵魂乐'],
    accent: '#f08fb3'
  },
  {
    id: 'hiphop',
    name: '说唱',
    blurb: 'Hip-Hop、Trap 与踩点伴奏',
    keywords: ['hip hop beats', 'rap music playlist', 'trap beat mix', '说唱 歌曲 中文'],
    markers: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', '说唱', '嘻哈'],
    accent: '#f2a65a'
  },
  {
    id: 'sleep-relax',
    name: '助眠放松',
    blurb: '入睡、冥想与解压',
    keywords: ['sleep music relaxing', 'relaxing piano music', 'deep sleep music', '助眠音乐 深度睡眠'],
    markers: ['sleep', 'relaxing', 'meditation', 'insomnia', '助眠', '放松', '冥想', '治愈'],
    accent: '#8ba6d8'
  },
  {
    id: 'cafe-lounge',
    name: '咖啡厅',
    blurb: '午后、拿铁与不打扰的背景乐',
    keywords: ['cafe music jazz', 'coffee shop music', 'lounge music playlist', '咖啡厅 背景音乐'],
    markers: ['cafe', 'coffee', 'lounge', 'bistro', 'bar music', '咖啡'],
    accent: '#d9a15a'
  },
  {
    id: 'late-night',
    name: '深夜氛围',
    blurb: '午夜、独处与城市夜景',
    keywords: ['late night music mix', 'ambient music playlist', 'midnight chill music', '深夜 音乐 电台'],
    markers: ['late night', 'midnight', 'ambient', 'night drive', '深夜', '午夜', '氛围'],
    accent: '#7f8fd8'
  },
  {
    id: 'workout',
    name: '运动跑步',
    blurb: '健身、跑步与节奏推进',
    keywords: ['workout music motivation', 'gym music mix', 'running music playlist', '运动 音乐 节奏'],
    markers: ['workout', 'gym', 'running', 'cardio', 'motivation', '运动', '跑步', '健身'],
    accent: '#67c48d'
  },
  {
    // 必须排在 ost 之前：动漫标题里常见的「theme song」会同时命中配乐分类，
    // inferCategory 取先命中者，顺序反了动漫歌就全被归成「影视配乐」
    id: 'anime',
    name: '日漫金曲',
    blurb: '主题曲、片尾曲与热血名场面',
    keywords: [
      'anime opening songs',
      'アニソン 名曲 メドレー',
      'anime best opening collection',
      '动漫 主题曲 合集'
    ],
    // 中日英三路都收：中文标题常直接写「主题曲」而不提「动漫」，
    // 英文标题则常只写 opening / ending theme（带空格的整词命中权重更高）
    markers: [
      'anime',
      'anison',
      'anime song',
      'opening theme',
      'ending theme',
      'アニメ',
      'アニソン',
      '主題歌',
      'オープニング',
      'エンディング',
      '动漫',
      '番剧',
      '主题曲',
      '片尾曲'
    ],
    accent: '#f2a0c0'
  },
  {
    id: 'ost',
    name: '影视配乐',
    blurb: '电影、剧集与游戏原声',
    keywords: ['movie soundtrack playlist', 'epic cinematic music', 'game soundtrack', '影视原声 配乐'],
    markers: ['ost', 'soundtrack', 'film score', 'theme song', '原声', '配乐', 'bgm'],
    accent: '#9d8df1'
  },
  {
    id: 'nostalgia',
    name: '怀旧金曲',
    blurb: '老歌、复古与卡带年代',
    keywords: ['oldies playlist', '80s music hits', '90s songs playlist', '经典老歌 怀旧 歌曲'],
    markers: ['oldies', 'retro', 'vintage', '80s', '90s', '怀旧', '经典老歌', '复古'],
    accent: '#b8895a'
  }
]

/**
 * 自动归类的最低得分。
 * scoreByMarkers 对「带空格分隔的整词」给 3 分、对「包含」给 1 分；
 * 中文没有空格，绝大多数命中都走包含分支，因此阈值必须按 1 来定，
 * 否则中文曲目永远归不进任何分类。
 */
const MATCH_THRESHOLD = 1

export function categoryById(id: string): MusicCategory | null {
  return allCategories().find((category) => category.id === id) ?? null
}

/**
 * 按标题 / 频道名推断所属分类，取得分最高者。
 * 得分太低就返回 null，宁可留在「未归类」也不要乱贴标签。
 */
export function inferCategory(text: string): MusicCategory | null {
  let best: MusicCategory | null = null
  let bestScore = 0
  for (const category of allCategories()) {
    const score = scoreByMarkers(text, category.markers)
    if (score > bestScore) {
      bestScore = score
      best = category
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null
}

/** 按 id 找二级子分类，同时带回它所属的一级分类 */
export function findSubCategory(
  subId: string
): { sub: SubCategory; parent: MusicCategory } | null {
  for (const category of allCategories()) {
    const sub = category.subcategories?.find((item) => item.id === subId)
    if (sub) return { sub, parent: category }
  }
  return null
}

/** 某个一级分类下的全部子分类 */
export function subCategoriesOf(categoryId: string): SubCategory[] {
  return categoryById(categoryId)?.subcategories ?? []
}

function pickKeyword(keywords: string[], seed: number): string {
  if (!keywords.length) return 'music playlist'
  const index = Math.abs(Math.floor(seed)) % keywords.length
  return keywords[index]
}

/** 取一个搜索词；seed 变化时轮换，让「换一批」真的换到不同查询 */
export function discoverQuery(categoryId: string, seed = 0): string {
  // 二级子分类优先：id 命中就直接用它的关键词
  const found = findSubCategory(categoryId)
  if (found) return pickKeyword(found.sub.keywords, seed)

  const category = categoryById(categoryId)
  if (!category) return 'music playlist'
  return pickKeyword(category.keywords, seed)
}

/* ── 有声书分类 ───────────────────────────────────────── */

/**
 * 与音乐平级的一大类。
 * 关键词刻意全用中文：YouTube 上这类内容的标题与上传者几乎都是中文站，
 * 用英文词搜出来的多是英文有声书，不是国内听众要的那批。
 */
const AUDIOBOOK_SEEDS: Omit<MusicCategory, 'kind'>[] = [
  {
    // 排在「有声小说」之前：网文标题常只写「玄幻 / 重生」这类品类词，
    // 同分时先命中的分类胜出，所以更具体的要放前面
    id: 'ab-web-novel',
    name: '网络小说',
    blurb: '起点、番茄与晋江的网文朗读',
    keywords: ['网络小说 有声', '网文 有声书 全集', '起点 小说 朗读'],
    markers: [
      '网络小说',
      '网文',
      '起点',
      '番茄',
      '晋江',
      '玄幻',
      '修仙',
      '仙侠',
      '重生',
      '穿越',
      '系统',
      '全季'
    ],
    accent: '#f2a65a'
  },
  {
    id: 'ab-novel',
    name: '有声小说',
    blurb: '出版与经典小说的朗读版',
    keywords: ['有声小说 完整版', '茅盾文学奖 小说 有声', '有声小说 多人演播'],
    markers: ['有声小说', '小说', '茅盾文学奖', '当代文学', '经典小说'],
    accent: '#c9a227'
  },
  {
    id: 'ab-story',
    name: '评书相声',
    blurb: '单口评书、相声与曲艺',
    keywords: ['评书 完整版', '单田芳 评书', '郭德纲 相声'],
    markers: ['评书', '相声', '单口', '曲艺', '快板', '京韵'],
    accent: '#d98c5f'
  },
  {
    id: 'ab-history',
    name: '历史人文',
    blurb: '通史、断代史与人物评说',
    keywords: ['中国历史 有声', '历史 有声书', '明朝那些事儿 有声'],
    markers: ['历史', '通史', '断代', '王朝', '史记', '帝王'],
    accent: '#b8895a'
  },
  {
    id: 'ab-business',
    name: '商业财经',
    blurb: '投资、经济与管理',
    keywords: ['财经 有声书', '投资 有声', '商业 有声书'],
    markers: ['财经', '投资', '经济', '商业', '管理', '金融'],
    accent: '#67c48d'
  },
  {
    id: 'ab-kids',
    name: '儿童故事',
    blurb: '睡前故事与国学启蒙',
    keywords: ['儿童故事 大全', '睡前故事 有声', '国学启蒙 有声'],
    markers: ['儿童故事', '睡前故事', '启蒙', '童话', '国学', '成语故事'],
    accent: '#f2a0c0'
  },
  {
    id: 'ab-language',
    name: '外语学习',
    blurb: '英语、日语与口语听力',
    keywords: ['英语 有声书', '英语听力 材料', '日语 有声'],
    markers: ['英语', '口语', '听力', '外语', '词汇', '新概念'],
    accent: '#6ea8fe'
  },
  {
    id: 'ab-philosophy',
    name: '哲学心理',
    blurb: '哲学、心理学与思维方式',
    keywords: ['哲学 有声书', '心理学 有声书', '西方哲学史 有声'],
    markers: ['哲学', '心理', '思想', '认知', '伦理', '逻辑'],
    accent: '#c58cf0'
  },
  {
    id: 'ab-biography',
    name: '传记纪实',
    blurb: '人物传记、回忆录与纪实文学',
    keywords: ['传记 有声书', '人物传记 完整版', '纪实文学 有声'],
    markers: ['传记', '回忆录', '纪实', '自传', '列传'],
    accent: '#8ba6d8'
  },
  {
    id: 'ab-literature',
    name: '文学经典',
    blurb: '名著、散文与诗词朗诵',
    keywords: ['名著 有声书', '散文 有声', '古诗词 朗诵'],
    markers: ['名著', '文学', '散文', '诗词', '朗诵', '小说 朗读'],
    accent: '#e07a5f'
  },
  {
    id: 'ab-knowledge',
    name: '知识杂谈',
    blurb: '科普、健康与生活百科',
    keywords: ['科普 有声书', '健康养生 有声', '百科知识 有声'],
    markers: ['科普', '健康', '养生', '百科', '知识', '地理'],
    accent: '#4fd1c5'
  }
]

/**
 * 二级子分类，按一级分类的 id 挂载。
 * 集中放在这里而不是写进 27 个分类块：既省去逐块改动，
 * 也让「某个分类有哪几个小类」一眼能看全。
 */
const SUBCATEGORIES: Record<string, SubCategory[]> = {
  /* ── 音乐 ─────────────────────────────────────────── */
  jazz: [
    { id: 'jazz-smooth', name: 'Smooth Jazz', keywords: ['smooth jazz music', 'smooth jazz saxophone playlist'] },
    { id: 'jazz-bossa', name: 'Bossa Nova', keywords: ['bossa nova playlist', 'bossa nova covers'] },
    { id: 'jazz-piano', name: '爵士钢琴', keywords: ['jazz piano playlist', '爵士钢琴 独奏'] },
    { id: 'jazz-vocal', name: '人声爵士', keywords: ['vocal jazz playlist', 'jazz female vocal songs'] },
    { id: 'jazz-cool', name: '酷派爵士', keywords: ['cool jazz playlist', 'miles davis cool jazz'] }
  ],
  lofi: [
    { id: 'lofi-chillhop', name: 'Chillhop', keywords: ['chillhop mix', 'chillhop 2024'] },
    { id: 'lofi-jazzhop', name: 'Jazz Hop', keywords: ['jazz hop mix', 'jazzy hip hop instrumental'] },
    { id: 'lofi-piano', name: 'Lo-Fi 钢琴', keywords: ['lofi piano music', 'lofi piano beats'] },
    { id: 'lofi-study', name: '学习节拍', keywords: ['lofi study beats', 'lofi beats to study'] },
    { id: 'lofi-guitar', name: 'Lo-Fi 吉他', keywords: ['lofi guitar beats', 'chill guitar instrumental'] }
  ],
  classical: [
    { id: 'cls-piano', name: '钢琴独奏', keywords: ['classical piano playlist', 'chopin piano solo'] },
    { id: 'cls-string', name: '弦乐四重奏', keywords: ['string quartet playlist', 'classical string music'] },
    { id: 'cls-symphony', name: '交响曲', keywords: ['symphony orchestra playlist', 'beethoven symphony'] },
    { id: 'cls-baroque', name: '巴洛克', keywords: ['baroque music playlist', 'bach vivaldi'] },
    { id: 'cls-romantic', name: '浪漫主义', keywords: ['romantic classical music', 'liszt schumann playlist'] }
  ],
  'chinese-style': [
    { id: 'cf-guofeng', name: '古风歌曲', keywords: ['古风音乐 歌曲', '古风歌曲 合集'] },
    { id: 'cf-guzheng', name: '古筝', keywords: ['guzheng music', '古筝 纯音乐'] },
    { id: 'cf-erhu', name: '二胡', keywords: ['erhu music', '二胡 名曲'] },
    { id: 'cf-dizi', name: '笛箫', keywords: ['chinese flute music', '笛子 箫 纯音乐'] },
    { id: 'cf-xiqiang', name: '戏腔', keywords: ['戏腔 歌曲', '古风 戏腔 流行'] }
  ],
  folk: [
    { id: 'folk-chinese', name: '华语民谣', keywords: ['华语民谣 歌曲', '中文民谣 合集'] },
    { id: 'folk-western', name: '欧美民谣', keywords: ['acoustic folk songs', 'indie folk playlist'] },
    { id: 'folk-fingerstyle', name: '指弹吉他', keywords: ['fingerstyle guitar', '指弹吉他 纯音乐'] },
    { id: 'folk-rock', name: '民谣摇滚', keywords: ['folk rock playlist', '民谣摇滚 歌曲'] }
  ],
  electronic: [
    { id: 'edm-ambient', name: '氛围电子', keywords: ['ambient electronic music', '氛围电子 纯音乐'] },
    { id: 'edm-synthwave', name: '合成波', keywords: ['synthwave playlist', 'retrowave mix'] },
    { id: 'edm-house', name: 'House', keywords: ['deep house playlist', 'house music mix'] },
    { id: 'edm-techno', name: 'Techno', keywords: ['techno mix', 'techno playlist'] },
    { id: 'edm-chillstep', name: 'Chillstep', keywords: ['chillstep playlist', 'chill electronic beats'] }
  ],
  rock: [
    { id: 'rock-classic', name: '经典摇滚', keywords: ['classic rock playlist', '70s 80s rock hits'] },
    { id: 'rock-hard', name: '硬摇滚', keywords: ['hard rock playlist', 'ac dc guns n roses'] },
    { id: 'rock-punk', name: '朋克', keywords: ['punk rock playlist', 'punk songs mix'] },
    { id: 'rock-alt', name: '另类摇滚', keywords: ['alternative rock playlist', 'alt rock mix'] },
    { id: 'rock-indie', name: '独立摇滚', keywords: ['indie rock playlist', 'indie rock 2024'] }
  ],
  'rnb-soul': [
    { id: 'rnb-neo', name: 'Neo Soul', keywords: ['neo soul playlist', 'neo soul mix'] },
    { id: 'rnb-motown', name: 'Motown', keywords: ['motown playlist', 'motown classics'] },
    { id: 'rnb-funk', name: 'Funk', keywords: ['funk music playlist', 'funk mix'] },
    { id: 'rnb-modern', name: '当代 R&B', keywords: ['rnb playlist 2024', 'contemporary rnb'] }
  ],
  hiphop: [
    { id: 'rap-hiphop', name: 'Hip-Hop', keywords: ['hip hop playlist', 'hip hop hits'] },
    { id: 'rap-trap', name: 'Trap', keywords: ['trap beat mix', 'trap playlist 2024'] },
    { id: 'rap-boom', name: 'Boom Bap', keywords: ['boom bap playlist', '90s hip hop mix'] },
    { id: 'rap-jazz', name: 'Jazz Rap', keywords: ['jazz rap playlist', 'jazzy hip hop'] }
  ],
  'sleep-relax': [
    { id: 'sl-sleep', name: '睡眠音乐', keywords: ['sleep music relaxing', '深度睡眠 音乐'] },
    { id: 'sl-meditation', name: '冥想', keywords: ['meditation music', '冥想音乐 疗愈'] },
    { id: 'sl-white', name: '白噪音', keywords: ['white noise sleep', '白噪音 助眠'] },
    { id: 'sl-nature', name: '自然声', keywords: ['nature sounds relaxing', '大自然 白噪音'] },
    { id: 'sl-rain', name: '雨声', keywords: ['rain sounds sleep', '雨声 助眠'] }
  ],
  'cafe-lounge': [
    { id: 'cafe-jazz', name: '爵士咖啡', keywords: ['jazz cafe music', 'coffee shop jazz'] },
    { id: 'cafe-bossa', name: '波萨诺瓦', keywords: ['bossa nova cafe', 'cafe bossa playlist'] },
    { id: 'cafe-acoustic', name: '原声吉他', keywords: ['acoustic cafe music', 'cafe acoustic guitar'] },
    { id: 'cafe-piano', name: '钢琴咖啡', keywords: ['cafe piano music', 'coffee shop piano'] }
  ],
  'late-night': [
    { id: 'ln-drive', name: '夜驾', keywords: ['night drive music', 'night drive playlist'] },
    { id: 'ln-jazz', name: '午夜爵士', keywords: ['late night jazz playlist', 'midnight jazz'] },
    { id: 'ln-ambient', name: '深夜氛围', keywords: ['late night ambient music', '深夜 氛围 音乐'] },
    { id: 'ln-citypop', name: 'City Pop', keywords: ['city pop playlist', 'japanese city pop 80s'] }
  ],
  workout: [
    { id: 'wk-edm', name: '电子健身', keywords: ['edm workout music', 'gym edm mix'] },
    { id: 'wk-rock', name: '摇滚健身', keywords: ['rock workout playlist', 'gym rock music'] },
    { id: 'wk-run', name: '跑步节拍', keywords: ['running music playlist', 'running beats'] },
    { id: 'wk-hiit', name: 'HIIT', keywords: ['hiit music mix', 'workout motivation music'] }
  ],
  anime: [
    { id: 'anime-op', name: 'OP 主题曲', keywords: ['anime opening songs', 'anime op full'] },
    { id: 'anime-ed', name: 'ED 片尾曲', keywords: ['anime ending songs', 'anime ed full'] },
    { id: 'anime-ost', name: '动漫 OST', keywords: ['anime ost playlist', 'anime soundtrack'] },
    { id: 'anime-classic', name: '经典老番', keywords: ['classic anime songs', '90s anime op'] },
    { id: 'anime-hype', name: '燃系神曲', keywords: ['hype anime songs', 'anime battle theme'] }
  ],
  ost: [
    { id: 'ost-movie', name: '电影配乐', keywords: ['movie soundtrack playlist', 'film score music'] },
    { id: 'ost-tv', name: '剧集原声', keywords: ['tv series soundtrack', '剧集 原声 配乐'] },
    { id: 'ost-game', name: '游戏原声', keywords: ['game soundtrack playlist', '游戏原声 神曲'] },
    { id: 'ost-epic', name: '史诗配乐', keywords: ['epic cinematic music', '史诗 配乐'] }
  ],
  nostalgia: [
    { id: 'ns-80s', name: '80 年代', keywords: ['80s music hits', '80年代 经典 歌曲'] },
    { id: 'ns-90s', name: '90 年代', keywords: ['90s songs playlist', '90年代 经典 老歌'] },
    { id: 'ns-2000s', name: '千禧年', keywords: ['2000s hits playlist', '千禧年 流行 金曲'] },
    { id: 'ns-chinese', name: '华语老歌', keywords: ['经典老歌 怀旧 歌曲', '华语 经典 老歌'] },
    { id: 'ns-western', name: '欧美老歌', keywords: ['oldies playlist', 'classic oldies hits'] }
  ],

  /* ── 有声书 ───────────────────────────────────────── */
  'ab-web-novel': [
    { id: 'wn-xuanhuan', name: '玄幻修真', keywords: ['玄幻 修真 有声', '修仙 有声小说'] },
    { id: 'wn-urban', name: '都市重生', keywords: ['都市 重生 有声小说', '都市 异能 有声'] },
    { id: 'wn-chuanyue', name: '穿越系统', keywords: ['穿越 系统 有声小说', '穿越小说 有声'] },
    { id: 'wn-scifi', name: '科幻末世', keywords: ['科幻 末世 有声小说', '末世 有声书'] },
    { id: 'wn-romance', name: '言情古言', keywords: ['言情 有声小说', '古言 有声书'] }
  ],
  'ab-novel': [
    { id: 'nl-maodun', name: '茅盾文学奖', keywords: ['茅盾文学奖 小说', '茅奖 作品 有声'] },
    { id: 'nl-modern', name: '当代文学', keywords: ['当代文学 有声书', '中国当代小说 朗读'] },
    { id: 'nl-classic', name: '经典名著', keywords: ['经典名著 有声书', '中国名著 朗读'] },
    { id: 'nl-mystery', name: '推理悬疑', keywords: ['推理小说 有声', '悬疑 有声书'] }
  ],
  'ab-story': [
    { id: 'st-shantianfang', name: '单田芳评书', keywords: ['单田芳 评书', '单田芳 大全'] },
    { id: 'st-guodegang', name: '郭德纲相声', keywords: ['郭德纲 相声', '德云社 相声 全集'] },
    { id: 'st-pingshu', name: '评书演义', keywords: ['评书 完整版', '评书 演义'] },
    { id: 'st-quyi', name: '曲艺杂谈', keywords: ['曲艺 大全', '相声 评书 合集'] }
  ],
  'ab-history': [
    { id: 'hi-tongshi', name: '中国通史', keywords: ['中国通史 有声', '中国历史 有声'] },
    { id: 'hi-duandai', name: '断代史', keywords: ['断代史 有声书', '明朝 历史 有声'] },
    { id: 'hi-world', name: '世界历史', keywords: ['世界历史 有声书', '世界史 有声'] },
    { id: 'hi-figure', name: '人物评说', keywords: ['历史人物 评说', '历史人物 有声'] }
  ],
  'ab-business': [
    { id: 'bz-invest', name: '投资理财', keywords: ['投资 有声书', '理财 有声'] },
    { id: 'bz-econ', name: '经济学', keywords: ['经济学 有声书', '经济 科普 有声'] },
    { id: 'bz-manage', name: '企业管理', keywords: ['管理学 有声书', '企业管理 有声'] },
    { id: 'bz-startup', name: '创业励志', keywords: ['创业 有声书', '商业 励志 有声'] }
  ],
  'ab-kids': [
    { id: 'kd-bedtime', name: '睡前故事', keywords: ['睡前故事 有声', '儿童 睡前故事'] },
    { id: 'kd-guoxue', name: '国学启蒙', keywords: ['国学启蒙 有声', '三字经 弟子规 朗读'] },
    { id: 'kd-idiom', name: '成语故事', keywords: ['成语故事 有声', '儿童 成语 故事'] },
    { id: 'kd-fairy', name: '童话寓言', keywords: ['童话故事 有声', '寓言故事 儿童'] }
  ],
  'ab-language': [
    { id: 'lg-english', name: '英语有声书', keywords: ['英语 有声书', 'english audiobook'] },
    { id: 'lg-listening', name: '英语听力', keywords: ['英语听力 材料', '英语听力 练习'] },
    { id: 'lg-japanese', name: '日语学习', keywords: ['日语 有声', '日语 听力 学习'] },
    { id: 'lg-oral', name: '口语发音', keywords: ['英语口语 有声', '发音 教程 有声'] }
  ],
  'ab-philosophy': [
    { id: 'ph-west', name: '西方哲学', keywords: ['西方哲学 有声书', '哲学史 有声'] },
    { id: 'ph-china', name: '中国哲学', keywords: ['中国哲学 有声', '论语 道德经 朗读'] },
    { id: 'ph-psych', name: '心理学', keywords: ['心理学 有声书', '心理学 普及'] },
    { id: 'ph-thinking', name: '认知思维', keywords: ['认知 思维 有声书', '逻辑思维 有声'] }
  ],
  'ab-biography': [
    { id: 'bg-person', name: '人物传记', keywords: ['人物传记 有声书', '传记 完整版'] },
    { id: 'bg-memoir', name: '回忆录', keywords: ['回忆录 有声书', '回忆录 完整版'] },
    { id: 'bg-report', name: '纪实文学', keywords: ['纪实文学 有声', '非虚构 写作 有声'] },
    { id: 'bg-history', name: '历史纪实', keywords: ['历史纪实 有声书', '历史 亲历'] }
  ],
  'ab-literature': [
    { id: 'lt-chinese', name: '中国名著', keywords: ['中国名著 有声书', '四大名著 朗读'] },
    { id: 'lt-foreign', name: '外国名著', keywords: ['外国名著 有声书', '世界名著 朗读'] },
    { id: 'lt-essay', name: '散文随笔', keywords: ['散文 有声', '名家 散文 朗读'] },
    { id: 'lt-poem', name: '诗词朗诵', keywords: ['古诗词 朗诵', '诗词 朗诵 名家'] }
  ],
  'ab-knowledge': [
    { id: 'kn-science', name: '科普百科', keywords: ['科普 有声书', '百科知识 有声'] },
    { id: 'kn-health', name: '健康养生', keywords: ['健康养生 有声', '中医 养生 有声'] },
    { id: 'kn-geo', name: '地理人文', keywords: ['地理 人文 有声书', '国家地理 有声'] },
    { id: 'kn-law', name: '法律社科', keywords: ['法律 有声书', '社科 普及 有声'] }
  ]
}

const withKind = (seeds: Omit<MusicCategory, 'kind'>[], kind: ContentKind): MusicCategory[] =>
  seeds.map((seed) => ({ ...seed, kind, subcategories: SUBCATEGORIES[seed.id] }))

export const MUSIC_CATEGORIES = withKind(MUSIC_SEEDS, 'music')
export const AUDIOBOOK_CATEGORIES = withKind(AUDIOBOOK_SEEDS, 'audiobook')

/* ── 自定义分类 ───────────────────────────────────────── */

/** 自建分类的 id 前缀，界面据此决定是否允许删除 */
export const CUSTOM_ID_PREFIX = 'custom-'

/** 自建分类可用的配色，按添加顺序轮换分配 */
export const CUSTOM_ACCENTS = [
  '#f2a0c0',
  '#e0b25c',
  '#6ea8fe',
  '#67c48d',
  '#e07a5f',
  '#c58cf0',
  '#4fd1c5',
  '#f2a65a'
]

/**
 * 用户自建分类由 CacheStore 从 categories.json 载入后注入，
 * 之后所有查找 / 归类 / 搜索都走 allCategories()，两边始终一致。
 */
let customCategories: MusicCategory[] = []

export function syncCustomCategories(list: MusicCategory[]): void {
  customCategories = [...list]
}

/** 内置在前、自建在后。顺序即归类优先级，内置分类不该被自建分类抢走 */
export function allCategories(): MusicCategory[] {
  return [...MUSIC_CATEGORIES, ...AUDIOBOOK_CATEGORIES, ...customCategories]
}
