/**
 * 可移植模块 · 平台链接识别、分享文案提取与归一化
 *
 * 各站的分享链接有好几种形态，而 yt-dlp 的 extractor 只认最「正规」的那一种：
 *
 *   - 短链：v.douyin.com/xxx、xhslink.com/xxx、b23.tv/xxx——本身不含内容 id，
 *     必须先跟随跳转拿到真链接（小红书的 xsec_token 就藏在跳转结果的 query 里，
 *     丢了它连笔记数据都取不到）
 *   - 分享文案：抖音 / 小红书复制出来的是「一段文案 + 链接」，整段粘贴时要能把链接揪出来
 *   - 官方分享域名：iesdouyin.com/share/video/<id> 这类，要翻译成 extractor 认的形式
 *
 * 纯字符串处理，不依赖 electron / node / react；两个项目共用同一份。
 */

export type PlatformId = 'bilibili' | 'douyin' | 'xiaohongshu' | 'weixin-channels'

/** 平台 → 它可能出现的域名，与内置源的 hosts 声明一致 */
const PLATFORM_HOSTS: Record<PlatformId, string[]> = {
  bilibili: ['bilibili.com', 'b23.tv', 'acg.tv'],
  douyin: ['douyin.com', 'iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhs.cn'],
  'weixin-channels': ['channels.weixin.qq.com', 'finder.video.qq.com']
}

/** 短链域名：只负责跳转，展开后才是真链接 */
const SHORT_LINK_HOSTS = ['v.douyin.com', 'xhslink.com', 'xhs.cn', 'b23.tv']

/** 分享文案里的链接：到空白或中文标点为止 */
const URL_IN_TEXT = /https?:\/\/[^\s，。、；：！？（）【】《》"'<>]+/i

/** 链接结尾常粘上标点或右括号，削掉 */
const TRAILING_JUNK = /[.,;:!?)\]}'"、）】》]+$/

export function hostOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** 这个链接属于哪个平台；不认识的返回 null */
export function platformOfUrl(raw: string): PlatformId | null {
  const host = hostOf(raw)
  if (!host) return null
  for (const [id, hosts] of Object.entries(PLATFORM_HOSTS) as [PlatformId, string[]][]) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return id
  }
  return null
}

/** 是否需要先展开：短链不展开，yt-dlp 认不出里面是什么 */
export function isShortLink(raw: string): boolean {
  const host = hostOf(raw)
  if (!host) return false
  return SHORT_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * 从整段分享文案里揪出链接。
 * 抖音的分享是「7.34 复制打开抖音，看看… https://v.douyin.com/xxxx/ 复制此链接」，
 * 小红书的也类似——用户多半直接整段粘贴，这里负责把链接摘出来。
 */
export function extractShareUrl(text: string): string | null {
  const raw = text.trim()
  const match = URL_IN_TEXT.exec(raw)
  if (!match) return null
  const cleaned = match[0].replace(TRAILING_JUNK, '')
  return isHttpUrl(cleaned) ? cleaned : null
}

/** 整段文本是否「就是一个链接」（粘贴链接与粘贴文案要走同一条路） */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 把各平台的各种链接形式归一成 yt-dlp extractor 认的那种。
 *
 * 注意小红书必须保留 query：`xsec_token` 是取笔记数据的凭据，删了就什么都拿不到。
 * 认不出来的链接原样返回，交给 yt-dlp 自己判断。
 */
export function normalizePlatformUrl(raw: string): string {
  const url = raw.trim()

  // 抖音：App 分享出来的是 iesdouyin.com/share/(video|note)/<id>，网页版是 douyin.com/<video|note>/<id>
  const douyin =
    /^https?:\/\/(?:www\.)?(?:iesdouyin\.com\/share\/(video|note)|douyin\.com\/(?:share\/)?(video|note))\/(\d+)/i.exec(
      url
    )
  if (douyin) {
    const kind = (douyin[1] ?? douyin[2]).toLowerCase()
    return `https://www.douyin.com/${kind}/${douyin[3]}`
  }

  // 小红书：extractor 只认带 www 的 /explore|/discovery/item/ 形式，query 原样保留
  const xhs = /^https?:\/\/(?:www\.)?xiaohongshu\.com\/((?:explore|discovery\/item)\/[\da-f]+[^\s]*)/i.exec(
    url
  )
  if (xhs) return `https://www.xiaohongshu.com/${xhs[1]}`

  return url
}

/**
 * 抖音的图文作品。
 * 链接形如 douyin.com/note/<id>，里面只有图片、没有音视频，
 * 所以「只听」的场景无从下手——要在交给解析器之前就拦下来，给一句人话。
 */
export function isDouyinNote(raw: string): boolean {
  return /(?:douyin\.com|iesdouyin\.com)\/(?:note|share\/note)\//i.test(raw)
}

/**
 * 粘贴框的统一入口：把用户粘进来的一段话变成「一个干净的链接」。
 * 返回 null 表示这不是链接（交给搜索流程）。
 */
export function parsePastedInput(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const url = isHttpUrl(raw) ? raw.replace(TRAILING_JUNK, '') : extractShareUrl(raw)
  if (!url) return null
  return normalizePlatformUrl(url)
}
