/**
 * 站点会话：按站点领取匿名 cookie，交给 yt-dlp；顺带负责短链展开。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 * 有些站把 cookie 当「你不是爬虫」的凭据。抖音的 web 详情接口就是如此：
 * 没有 s_v_web_id 直接拒绝，yt-dlp 的原话是 "Fresh cookies are needed"。
 * 麻烦的是 s_v_web_id 不在 HTTP 响应头里，而是页面脚本算出来写进浏览器的，
 * 所以只能让 Chromium 亲自开一次首页，再去会话里把 cookie 捞出来。
 *
 * ── 与 bilibili.ts 的关系 ────────────────────────────────
 * B站那套在此之外还带扫码登录，所以单独留着；只做匿名凭证的站点
 * （抖音、小红书）用这一个就够。将来 B站 的指纹部分也可以并进来。
 *
 * ── 为什么短链展开也在这里 ──────────────────────────────
 * 展开要跟着跳转跑好几跳，还得与 yt-dlp 走同一套代理；用同一个分区会话最省事。
 * 小红书的 xsec_token 就藏在跳转结果的 query 里，丢了它连笔记数据都取不到。
 */
import { BrowserWindow, net, session } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isShortLink } from '@shared/portable/platforms'
import { resolveProxyArgs } from './tools'
import type { CacheStore } from './library'

/** 报给站点的 UA：领取 cookie 与 yt-dlp 请求必须一致，否则容易被判定异常 */
const SITE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 匿名凭证的有效期：比指纹短一些，过期重领即可 */
const REFRESH_MS = 7 * 86_400_000

/** 页面脚本写 cookie 需要一点时间，加载完再等一会儿 */
const JS_SETTLE_MS = 2600

export interface SiteProfile {
  /** 站点 id：用作分区名与 cookie 文件名 */
  id: string
  /** 先直接请求的地址，能拿到响应头里的 Set-Cookie */
  urls?: string[]
  /** 需要执行页面脚本才会写入 cookie 的地址，用隐藏窗口开一次 */
  pages?: string[]
  /** cookie 写进文件时用的域 */
  cookieDomain: string
  /** 打开页面时伪造的来源页 */
  referer: string
  /** 必须拿到的 cookie 名：缺任何一个都算领取失败，好过带着半份凭证去撞墙 */
  required?: string[]
  ttl?: number
}

export class SiteSession {
  readonly file: string
  private ok = false
  private inflight: Promise<boolean> | null = null
  private proxySession: Electron.Session | null = null

  constructor(
    private readonly store: CacheStore,
    root: string,
    private readonly profile: SiteProfile
  ) {
    this.file = path.join(root, `${profile.id}-cookies.txt`)
  }

  /** 后台调用即可：领不到只是这个站用不了，不该影响别处 */
  ensure(): Promise<boolean> {
    if (this.ok) return Promise.resolve(true)
    this.inflight ??= this.grab()
    return this.inflight
  }

  /** yt-dlp 的附加参数；没领到就返回空，别硬带一份空文件 */
  args(): string[] {
    if (!this.ok) return []
    return ['--cookies', this.file, '--user-agent', SITE_UA]
  }

  /**
   * 自研解析器可以复用同一个分区：代理配置与已领的 cookie 都在这儿，
   * 自己再开一份分区只会让站点看到两张不同的脸。
   */
  browserSession(): Promise<Electron.Session> {
    return this.openSession()
  }

  private async grab(): Promise<boolean> {
    const ttl = this.profile.ttl ?? REFRESH_MS
    const stat = await fsp.stat(this.file).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs < ttl) {
      this.ok = true
      return true
    }

    try {
      const jar = await this.openSession()
      for (const url of this.profile.urls ?? []) {
        await this.visit(url, jar).catch(() => undefined)
      }
      for (const page of this.profile.pages ?? []) {
        await this.warmPage(page, jar).catch(() => undefined)
      }

      const cookies = await jar.cookies.get({ url: this.profile.referer })
      const wanted = this.profile.required ?? []
      const have = new Set(cookies.map((cookie) => cookie.name))
      const missing = wanted.filter((name) => !have.has(name))
      if (missing.length) {
        console.warn(`[site:${this.profile.id}] 没领到 cookie: ${missing.join(', ')}`)
        this.inflight = null
        return false
      }

      await this.writeFile(cookies)
      this.ok = true
      console.log(`[site:${this.profile.id}] 已领取 ${cookies.length} 枚 cookie`)
      return true
    } catch (err) {
      console.error(
        `[site:${this.profile.id}] 领取凭证失败:`,
        err instanceof Error ? err.message : err
      )
      this.inflight = null
      return false
    }
  }

  private async openSession(): Promise<Electron.Session> {
    if (!this.proxySession) {
      this.proxySession = session.fromPartition(`vinylbox-${this.profile.id}`)
      // 代理必须显式指定：跟随系统时 PAC 会把这些站分流成直连，而直连不通
      const settings = this.store.getSettings()
      const { proxy } = await resolveProxyArgs(settings.proxyMode, settings.proxy)
      await this.proxySession.setProxy(
        proxy ? { proxyRules: proxy, proxyBypassRules: '<local>' } : { mode: 'direct' }
      )
    }
    return this.proxySession
  }

  /** 直接请求一次，让响应头里的 Set-Cookie 落进分区会话 */
  private async visit(url: string, jar: Electron.Session): Promise<void> {
    const response = await jar.fetch(url, {
      headers: { 'User-Agent': SITE_UA, Referer: this.profile.referer }
    })
    // 只关心 cookie 是否落盘，内容直接丢掉
    await response.arrayBuffer()
  }

  /**
   * 用隐藏窗口开一次页面：s_v_web_id 这类凭证是页面脚本写进去的，
   * 只发 HTTP 请求永远拿不到。加载失败也继续——被挑战拦下时往往已经写了一半 cookie。
   */
  private async warmPage(url: string, jar: Electron.Session): Promise<void> {
    const win = new BrowserWindow({
      show: false,
      width: 1080,
      height: 720,
      webPreferences: { session: jar }
    })
    try {
      await win.loadURL(url, { userAgent: SITE_UA })
      await new Promise((resolve) => setTimeout(resolve, JS_SETTLE_MS))
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  /**
   * 写成 yt-dlp（其实是 Python 的 CookieJar）能读的 Netscape 格式。
   *
   * 有个坑：第二列的 domain_specified 必须与「域名是否以点开头」一致——
   * 域名带点就写 TRUE、不带点就写 FALSE。写成 TRUE 又不带点，CookieJar 会
   * 直接抛 invalid Netscape format，整份文件作废（Electron 给的域名恰好不带点）。
   */
  private async writeFile(cookies: Electron.Cookie[]): Promise<void> {
    const fallback = Math.floor((Date.now() + REFRESH_MS) / 1000)
    const lines = [
      '# Netscape HTTP Cookie File',
      ...cookies.map((cookie) => {
        const domain = cookie.domain ?? this.profile.cookieDomain
        return [
          domain,
          domain.startsWith('.') ? 'TRUE' : 'FALSE',
          cookie.path || '/',
          'TRUE',
          String(Math.floor(cookie.expirationDate ?? fallback)),
          cookie.name,
          cookie.value
        ].join('\t')
      })
    ]
    await fsp.writeFile(this.file, `${lines.join('\n')}\n`, 'utf-8')
  }
}

/**
 * 跟随短链跳到真链接。
 * 有些短链一跳就到，有些要连跳两三次，所以循环几轮；超过上限就返回当前地址，
 * 让 yt-dlp 自己去试。
 */
export async function expandShortLink(raw: string, store: CacheStore): Promise<string> {
  let url = raw.trim()
  if (!isShortLink(url)) return url

  const jar = session.fromPartition('vinylbox-shortlink')
  const settings = store.getSettings()
  const { proxy } = await resolveProxyArgs(settings.proxyMode, settings.proxy)
  await jar.setProxy(proxy ? { proxyRules: proxy, proxyBypassRules: '<local>' } : { mode: 'direct' })

  for (let hop = 0; hop < 5; hop += 1) {
    const next = await hopOnce(url, jar)
    if (!next) return url
    url = new URL(next, url).toString()
    if (!isShortLink(url)) return url
  }
  return url
}

/**
 * 跟一跳，只取 Location 不跟到底。
 * 不能用 session.fetch 的 redirect: 'manual'——Electron 会把它当成
 * 「重定向被取消」直接抛错，只能走 net.request 的 redirect 事件。
 */
function hopOnce(url: string, jar: Electron.Session): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = net.request({ url, session: jar, redirect: 'manual' })
    request.setHeader('User-Agent', SITE_UA)
    request.on('redirect', (_status, _method, redirectUrl) => {
      request.abort()
      done(redirectUrl)
    })
    request.on('response', () => {
      request.abort()
      done(null)
    })
    request.on('error', (err) => {
      console.warn('[shortlink] 展开失败:', err.message)
      done(null)
    })
    request.end()
  })
}
