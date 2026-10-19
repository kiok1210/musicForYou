/**
 * 抖音取流：绕开接口签名，让页面自己把地址算出来。
 *
 * yt-dlp 的 Douyin extractor 走的是 web 详情接口，而那个接口现在要签名参数
 * （a_bogus 之类），只带 cookie 会被拒——实测官方测试用例三个视频全部报
 * "Fresh cookies (not necessarily logged in) are needed"，而我们领到 ttwid 也照样被拒。
 *
 * 但 PC 网页本身在匿名状态下是能播的：页面自己会带签名去请求，然后把直链填进
 * `<video>`。所以我们不自己造签名，而是开一个隐藏窗口把页面跑起来，等它把地址
 * 填好再取走。代价是要等几秒，换来的是一条稳定可用的路。
 *
 * 取到的直链带时效签名，只适合立刻下载/试听；所以解析结果里的 url 直接是直链，
 * 而 referer 单列——抖音 CDN 只认 douyin.com 的 Referer，从直链域名是推不出来的。
 */
import { BrowserWindow } from 'electron'
import type { TrackMeta } from '@shared/types'
import type { SiteSession } from './site-session'

/** 与 site-session 领取 cookie 时用的是同一个 UA，换 UA 会被当成两个人 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const REFERER = 'https://www.douyin.com/'

/** 只放行网页：页面里的「打开 App」走的是 snssdk1128:// 这类私有协议 */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 页面从加载到把直链填进 <video>，实测一两秒；给足余量，慢网络也不至于白等 */
const PLAYER_DEADLINE_MS = 18_000
const POLL_MS = 600

export interface DouyinClip {
  id: string
  title: string
  artist: string
  duration: number
  thumbnail: string
  /** 带时效签名的 CDN 直链 */
  url: string
  referer: string
}

/** 从各种抖音链接里取作品 id；返回 null 说明这不是一个作品链接 */
export function douyinIdOf(link: string): string | null {
  const match = /(?:douyin\.com|iesdouyin\.com)\/(?:video|note|share\/(?:video|note))\/(\d+)/i.exec(
    link
  )
  return match ? match[1] : null
}

interface PlayerProbe {
  src: string
  title: string
  author: string
  duration: number
  thumbnail: string
}

/**
 * 打开作品页取直链。
 * 调用前请先拦下图文作品（douyin.com/note/...）：那种页面没有 <video>，
 * 等到底也只会超时。
 */
export async function resolveDouyinClip(link: string, session: SiteSession): Promise<TrackMeta> {
  const id = douyinIdOf(link)
  if (!id) throw new Error('这条链接里找不到抖音作品 id')
  const page = `https://www.douyin.com/video/${id}`

  const jar = await session.browserSession()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { session: jar }
  })

  try {
    // 页面里的广告与「打开 App」按钮都想开新窗口或跳私有协议
    // （snssdk1128:// 之类），一放行就会弹系统的「打开方式」对话框，全部拦掉
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault()
    })
    await win.loadURL(page, { userAgent: UA })
    const probe = await waitForPlayer(win)
    if (!probe?.src) {
      throw new Error('抖音页面没有给出播放地址：内容可能已被删除，或这次访问被站点拦下了')
    }
    return {
      id,
      title: probe.title || `抖音作品 ${id}`,
      artist: probe.author,
      duration: probe.duration,
      thumbnail: probe.thumbnail,
      url: probe.src,
      referer: REFERER,
      sourceId: 'douyin'
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** 轮询页面，直到 <video> 拿到 http 直链（页面会先给空串，再换成真地址） */
async function waitForPlayer(win: BrowserWindow): Promise<PlayerProbe | null> {
  const deadline = Date.now() + PLAYER_DEADLINE_MS
  while (Date.now() < deadline) {
    const probe = await win.webContents
      .executeJavaScript(
        `(() => {
           const video = document.querySelector('video')
           const src = video ? (video.currentSrc || video.src || '') : ''
           const author = document.querySelector('[data-e2e="video-author-name"], .account-name, .author-name')
           const image = document.querySelector('meta[property="og:image"]')
           return {
             src: String(src),
             title: document.title.replace(/\\s*[-—]\\s*抖音\\s*$/, '').trim(),
             author: author ? String(author.textContent || '').trim() : '',
             duration: Number(video && video.duration) || 0,
             thumbnail: image ? String(image.getAttribute('content') || '') : ''
           }
         })()`
      )
      .catch(() => null)

    if (probe && typeof probe === 'object' && String(probe.src).startsWith('http')) {
      return {
        src: String(probe.src),
        title: String(probe.title ?? ''),
        author: String(probe.author ?? ''),
        duration: Number(probe.duration) || 0,
        thumbnail: String(probe.thumbnail ?? '')
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return null
}
