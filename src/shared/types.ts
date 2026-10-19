/** 主进程与渲染进程共享的数据结构 */

export type AudioFormat = 'm4a' | 'mp3'

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'done'
  | 'error'
  | 'canceled'

/** 从 YouTube 解析出的曲目元信息 */
export interface TrackMeta {
  id: string
  title: string
  artist: string
  duration: number
  thumbnail: string
  url: string
  /** 结果来自哪个源（MediaSource.id）。缺省时按 URL 认源；试听与下载都跟着它走 */
  sourceId?: string
  /**
   * 取流与下载时要带的来源头。
   * 有些 CDN 校验得严（抖音的 CDN 只认 douyin.com），而地址本身推不出来，
   * 只能由解析方一并给出。
   */
  referer?: string
}

/** 自动标签由程序生成，重算时会被替换；手动标签始终保留 */
export type TagKind = 'auto' | 'manual'

export interface TrackTag {
  label: string
  kind: TagKind
}

/** 标签在库中的聚合信息，用于筛选栏 */
export interface TagSummary {
  label: string
  count: number
  hasManual: boolean
}

/**
 * 音乐分类。
 * 一个分类同时承担两件事：
 * 1. keywords —— 「发现更多」拿去搜 YouTube 的查询词（seed 变化时轮换）
 * 2. markers  —— 下载后按标题 / 频道自动归类的特征词，命中即落到分类名标签
 */
/**
 * 内容大类。
 * 音乐与有声书是两套平行的体系：各有自己的分类、各自的展示区，
 * 播放侧则共享同一套播放器（有声书额外用上倍速、睡眠定时、断点续听）。
 */
export type ContentKind = 'music' | 'audiobook'

/**
 * 二级子分类：把一级分类再切细。
 * 搜索词直接来自子分类，点一下就能按这个小类去搜一批。
 */
export interface SubCategory {
  id: string
  name: string
  keywords: string[]
}

export interface MusicCategory {
  id: string
  name: string
  blurb: string
  keywords: string[]
  markers: string[]
  /** 卡片主色 */
  accent: string
  /** 所属内容大类 */
  kind: ContentKind
  /** 二级子分类，可再切细 */
  subcategories?: SubCategory[]
}

export interface CategorySummary extends MusicCategory {
  /** 已缓存到该分类的曲目数 */
  count: number
  /** 已缓存曲目的总时长（秒） */
  duration: number
  /** 用户自建分类，可删除；内置分类只读 */
  custom: boolean
}

/**
 * 用户自建分类的输入。
 * 只收最少必要信息：归类用的特征词由名称与关键词自动派生，配色也自动分配。
 */
export interface CategoryInput {
  name: string
  blurb: string
  /** 搜索关键词，多个则每点一次轮换一个 */
  keywords: string[]
  /** 建到哪个大类下，默认音乐 */
  kind?: ContentKind
}

/**
 * 内容源：一个视频 / 音频站点。
 *
 * `searchKey` 非空表示这个源支持站内搜索（对应 yt-dlp 的 _SEARCH_KEY），
 * 能进搜索框与发现页；为空表示 yt-dlp 没有该站的搜索接口，只能粘贴链接。
 */
export interface MediaSource {
  id: string
  name: string
  /** 站点域名，用于粘贴链接时认出内容来自哪里 */
  hosts: string[]
  /** yt-dlp 站内搜索前缀，如 ytsearch / bilisearch；空串表示不支持搜索 */
  searchKey: string
  home: string
  accent: string
  /** 一句话说明，显示在源选择器与源管理里 */
  note: string
  /** 用户自建的源可删除，内置源只读 */
  custom: boolean
  /** 搜索 / 取流 / 下载时额外附加的 yt-dlp 参数（如 --referer）；缺省只走通用参数 */
  extraArgs?: string[]
  /** 该站要求携带访客指纹（如 B站的 buvid3/buvid4），应用会自动领取并带上 */
  fingerprint?: boolean
  /** 登录方式：qrcode 支持应用内扫码，cookie 需要用户自备 cookies.txt；缺省不必登录 */
  auth?: 'qrcode' | 'cookie'
}

/** 自建源的输入。搜索键可留空，表示只用来粘贴链接 */
export interface SourceInput {
  name: string
  hosts: string[]
  searchKey: string
  home: string
}

/**
 * 一次「发现」的结果快照。
 *
 * 点同一个分类每点一次都会轮换关键词（避免总看到同一批），结果也就每次不同。
 * 不存下来的话上一批就永远找不回来了——所以把每批连查询词一起存成快照。
 */
export interface DiscoverBatch {
  id: string
  categoryId: string
  /** 分类名一并存：分类被删掉之后，也还能知道这批是从哪来的 */
  categoryName: string
  /** 这批实际用的查询词，回看时照着它也能重新搜一遍 */
  query: string
  sourceId: string
  sourceName: string
  createdAt: number
  tracks: TrackMeta[]
}

/** 存一批发现历史时由主进程补齐的输入部分 */
export interface DiscoverBatchInput {
  categoryId: string
  query: string
  sourceId: string
  sourceName: string
  tracks: TrackMeta[]
}

export type RepeatMode = 'off' | 'all' | 'one'

/**
 * 播放现场快照。
 * 程序被关闭后重新打开，会按这份快照把曲目、进度、音量、循环模式与队列原样还原。
 */
export interface PlaybackSnapshot {
  trackId: string | null
  /** 上次播放到的位置（秒） */
  position: number
  volume: number
  muted: boolean
  repeat: RepeatMode
  /** 随机播放：与循环模式是两个维度，可以同时开着 */
  shuffle?: boolean
  /** 播放队列的曲目 ID 顺序 */
  queueIds: string[]
  updatedAt: number
}

/** 已缓存在本地的曲目 */
export interface Track extends TrackMeta {
  fileName: string
  coverName: string | null
  size: number
  format: string
  downloadedAt: number
  favorite: boolean
  playCount: number
  lastPlayedAt: number | null
  tags: TrackTag[]
  /** 上次听到的位置（秒）。长内容靠它断点续听 */
  progress?: number
}

export interface DownloadTask {
  id: string
  meta: TrackMeta
  status: DownloadStatus
  /** 0 ~ 1 */
  progress: number
  speed: string
  eta: string
  stage: string
  error?: string
}

/**
 * 代理模式：
 * - auto   跟随系统（含 PAC 自动配置脚本、系统 HTTP/SOCKS 代理）
 * - manual 手动指定地址（http:// / socks5://）
 * - off    强制直连，不经过任何代理
 */
export type ProxyMode = 'auto' | 'manual' | 'off'

export interface AppSettings {
  audioFormat: AudioFormat
  searchLimit: number
  proxyMode: ProxyMode
  proxy: string
  cookieFile: string
  /** 非中文歌词自动附带中文翻译 */
  autoTranslate: boolean
  /** 本地语音识别使用的模型：越大越准也越慢 */
  whisperModel: 'tiny' | 'base' | 'small'
  /** 默认播放倍速：音乐保持原速，听书常调到 1.5× */
  playbackRate: number
  /** 默认内容源 id，对应 MediaSource.id */
  source: string
}

/** 本地识别的运行状态 */
export interface TranscribeState {
  active: boolean
  stage: string
  ratio: number
}

export interface LyricLine {
  /** 起始时间（秒）；-1 表示该行没有时间轴 */
  time: number
  text: string
  /** 中文翻译，无则为 null */
  translation: string | null
}

export interface Lyrics {
  /** lrclib / youtube = 在线匹配，local = 本地语音识别 */
  source: 'lrclib' | 'youtube' | 'local' | 'none'
  /** 是否带时间轴 */
  synced: boolean
  /** 检测到的歌词语言 */
  language: string | null
  lines: LyricLine[]
  /** 是否已附带中文翻译 */
  translated: boolean
  /** 命中的曲名 / 艺术家，便于用户确认匹配是否正确 */
  matchedTitle: string | null
  matchedArtist: string | null
  /** 歌词库标记为纯器乐（无人声） */
  instrumental?: boolean
  /** 失败或降级说明 */
  note?: string
  fetchedAt: number
}

export interface ToolStatus {
  ytDlpReady: boolean
  ytDlpLabel: string
  ffmpegReady: boolean
  installing: boolean
}

export interface InstallProgress {
  step: string
  ratio: number
}

export interface CacheStats {
  count: number
  bytes: number
  mediaDir: string
}

/** YouTube 连通性探测结果 */
export interface ProbeResult {
  reachable: boolean
  proxy: string | null
}

/**
 * 站点账号状态。
 * 匿名也能搜（B站靠应用自己领取的访客指纹），但会员曲目、需要登录的清晰度
 * 必须有登录态。
 */
export interface SourceAccount {
  loggedIn: boolean
  /** 站点侧的账号 id，字符串化以便各站格式不一（B站是 uid） */
  uid: string
  uname: string
  /** 头像地址 */
  avatar: string
  /** 凭证到期时间（毫秒时间戳），0 表示未知 */
  expires: number
}

export const ANONYMOUS_ACCOUNT: SourceAccount = {
  loggedIn: false,
  uid: '',
  uname: '',
  avatar: '',
  expires: 0
}

/** 一张待扫的登录二维码 */
export interface QrTicket {
  /** 轮询用的凭证 */
  key: string
  /** 二维码内容，同时也是手机要打开的授权地址 */
  url: string
  /** 现成的二维码 SVG，UI 直接渲染 */
  svg: string
}

export type QrState = 'waiting' | 'scanned' | 'success' | 'expired'

export interface QrPollResult {
  state: QrState
  account: SourceAccount | null
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

export const DEFAULT_SETTINGS: AppSettings = {
  audioFormat: 'm4a',
  searchLimit: 12,
  proxyMode: 'auto',
  proxy: '',
  cookieFile: '',
  autoTranslate: true,
  // 默认 tiny：base 在 CPU 上约为 0.4x 实时，长音频会慢到不可用
  whisperModel: 'tiny',
  // 音乐默认原速；听书时在播放器里随手调
  playbackRate: 1,
  // 默认在 YouTube 搜，换源后会被记住
  source: 'youtube'
}
