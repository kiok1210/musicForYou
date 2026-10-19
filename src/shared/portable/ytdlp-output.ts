/**
 * 可移植模块 · yt-dlp 输出解析
 *
 * 把子进程输出转成结构化进度，把英文报错转成用户能照做的中文提示。
 * 任何用 yt-dlp 做下载的项目都会需要这两件事，不依赖 electron / react / node。
 */

export interface DownloadProgress {
  /** 0 ~ 1；无该字段表示这一行不是进度行 */
  percent?: number
  speed?: string
  eta?: string
}

const PERCENT = /\[download\]\s+([\d.]+)%/
const SPEED = /\bat\s+(.+?\/s)/
const ETA = /ETA\s+([\d:]+)/

/** 解析 yt-dlp 的 `--newline` 进度行，非进度行返回空对象 */
export function parseDownloadProgress(line: string): DownloadProgress {
  if (!line.startsWith('[download]')) return {}
  const info: DownloadProgress = {}
  const percent = PERCENT.exec(line)
  if (percent) info.percent = Number(percent[1]) / 100
  const speed = SPEED.exec(line)
  if (speed) info.speed = speed[1].trim()
  const eta = ETA.exec(line)
  if (eta) info.eta = eta[1]
  return info
}

/** 后处理阶段的标志行：用来把「下载中」切成「转码中 / 写元数据」 */
export function stageOfLine(line: string): 'transcode' | 'metadata' | 'merge' | null {
  if (line.startsWith('[ExtractAudio]')) return 'transcode'
  if (line.startsWith('[Merger]')) return 'merge'
  if (line.startsWith('[Metadata]') || line.startsWith('[EmbedThumbnail]')) return 'metadata'
  return null
}

const RATE_LIMIT = /(\b429\b|too many requests)/i
const NETWORK_ERROR =
  /(failed to resolve|getaddrinfo|name or service not known|temporary failure in name resolution|network is unreachable|no route to host|connection refused|connection reset|connection timed out|unable to connect|unable to download webpage|read timed out|http error 5\d\d|failed to establish|ssl error|certificate)/i
const AUTH_ERROR = /(login required|private video|members-only|age-restricted|this video requires login)/i
/**
 * YouTube 的机器人校验。
 * 它的原文是 `Sign in to confirm you're not a bot`，字面上像「要登录」，
 * 实则是在质疑请求方是不是脚本——多为代理出口 IP 被标记所致。
 * 若与 AUTH_ERROR 混在一起报「内容需要登录」，用户会去查内容权限，方向就错了。
 */
const BOT_CHECK = /sign in to confirm/i
const GONE_ERROR = /(video unavailable|has been removed|does not exist|not available in your country)/i
/** 平台侧的匿名凭证问题：抖音要的那份反爬 cookie 就属这一类 */
const FRESH_COOKIE = /fresh cookies.*needed/i
/** 抖音的详情接口没给数据：凭证过期或内容不可用，得分开说 */
const DOUYIN_DETAIL = /failed to download web detail json/i
/** 页面里没有音视频：小红书的图文笔记就是这样 */
const NO_FORMATS = /no video formats found/i

/**
 * 把 yt-dlp 的英文报错翻译成可执行的中文提示。
 * 这不是翻译，而是「告诉用户下一步该做什么」。
 */
export function friendlyYtDlpError(raw: string): string {
  const text = raw.trim()
  if (!text) return '未知错误'
  if (RATE_LIMIT.test(text)) return '请求过于频繁（HTTP 429），稍后再试'
  if (NETWORK_ERROR.test(text)) {
    // 不写死站点名：这条路径上 YouTube、B站、抖音都会走，写死会把 B站的网络问题
    // 说成「无法连接 YouTube」，让人查错方向
    return '连不上目标站点：检查网络，或在「设置」中填写代理地址（例如 http://127.0.0.1:7890）。'
  }
  if (FRESH_COOKIE.test(text)) {
    return '这个站点要求一份新鲜的匿名凭证，应用会自动领取；若反复失败，多半是这次请求被站点的验证挡下了，稍后再试或换个网络。'
  }
  if (DOUYIN_DETAIL.test(text)) {
    return '抖音的详情接口没有返回数据：可能是凭证过期（重开应用会自动重领），也可能是这条内容已被删除或需要登录。'
  }
  if (NO_FORMATS.test(text)) return '这条内容里没有可下载的音视频（例如小红书的图文笔记）。'
  if (BOT_CHECK.test(text)) {
    return 'YouTube 要你先证明「不是机器人」：多半是当前代理出口 IP 被它标记了。给它一份登录态 cookies（设置里指定 cookies.txt）最稳，或换一个代理节点。'
  }
  if (AUTH_ERROR.test(text)) return '该内容需要登录验证。可在「设置」中指定 cookies.txt 后重试。'
  if (GONE_ERROR.test(text)) return '内容不可用或已被删除。'
  return text.replace(/^ERROR:\s*/i, '').slice(0, 220)
}

/** 从多行输出里取出最后一条 ERROR（yt-dlp 会把关键错误放在末尾） */
export function lastErrorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR:'))
  return lines.length ? lines[lines.length - 1] : ''
}

/** 是否属于「重试可能有效」的临时故障，用于决定要不要写缓存 */
export function isTransientFailure(raw: string): boolean {
  return RATE_LIMIT.test(raw) || /(read timed out|connection reset|connection timed out)/i.test(raw)
}

/** 判断输入是链接还是搜索词 */
/**
 * 判断输入是不是链接。
 *
 * 只认 YouTube 域名是不够的：支持多源之后，粘贴 B 站、SoundCloud 的链接
 * 会被当成关键词拿去搜索，结果必然是空。所以按「域名 + 路径」的通用形状判断。
 *
 * 不带协议时也认（b23.tv/xxx、music.163.com），但不带点的普通关键词
 * 与「歌手 - 歌名」这类搜索词都不会误判。
 */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text) return false
  if (/^https?:\/\//i.test(text)) return true
  return /^(www\.|m\.|music\.)?[\w-]+(\.[\w-]+)+(\/|$)/i.test(text)
}

/** 判断是否是频道 / 播放列表链接（这类链接要展开成多条） */
export function looksLikeCollection(input: string): boolean {
  return /[?&]list=|\/playlist|[?&]channel=|\/channel\/|\/@|\/c\/|\/user\//i.test(input)
}

/** 人类可读的体积，用于「已缓存 · 12.3 MB」这类文案 */
export function humanBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
