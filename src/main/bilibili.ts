/**
 * B站的会话：访客指纹 + 扫码登录。
 *
 * ── 指纹 ──────────────────────────────────────────────
 * B站的搜索接口有设备风控：请求里不带 buvid3/buvid4 这对「访客身份证」就回
 * HTTP 412。它们是匿名发放的（首页 Set-Cookie + finger/spi 接口，无需登录），
 * 所以应用启动后自己领一次存成 cookies.txt，搜 B站时带给 yt-dlp。
 *
 * 两个实测出来的坑：
 *   1. 只有 buvid3 不够，412 照样出现，buvid4 必须有（它只在 spi 接口里发）；
 *   2. 风控会核对 UA 与指纹的搭配——领取和搜索必须用同一个 UA，
 *      换个 UA 拿同一份指纹照样 412。
 *
 * ── 登录 ──────────────────────────────────────────────
 * 匿名指纹只够「能搜」，会员曲目、需要登录的番剧与原唱清晰度仍会被拒。
 * 要完整可用得有登录态，而让用户出手动把手导出 cookies.txt 太笨，
 * 所以这里直接走 B站的网页扫码登录：取二维码 → 轮询 → 落 Set-Cookie。
 * 用户全程不用离开应用。
 */
import { net, session } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import {
  ANONYMOUS_ACCOUNT,
  type QrPollResult,
  type QrTicket,
  type SourceAccount,
  type TrackMeta
} from '@shared/types'
import { TaskQueue } from '@shared/portable/concurrency'
import { resolveProxyArgs } from './tools'
import type { CacheStore } from './library'

/** 与指纹绑定的 UA，领取指纹、扫码登录、yt-dlp 搜索三处共用同一个 */
export const BILIBILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 指纹有效期内不重复领取；B站指纹的实际有效期远长于此 */
const REFRESH_MS = 7 * 86_400_000

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const PASSPORT_REFERER = 'https://passport.bilibili.com/'
const SITE_REFERER = 'https://www.bilibili.com/'

/** 登录态挂在这些 cookie 上；登出时按名字剔除，其余（含指纹）保留 */
const LOGIN_COOKIES = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'refresh_token',
  'bili_ticket',
  'bili_ticket_expires'
]

interface SimpleResponse {
  body: string
  headers: Record<string, string | string[] | undefined>
}

export class BilibiliSession {
  readonly file: string
  private readonly accountFile: string
  private ok = false
  private inflight: Promise<boolean> | null = null
  private cached: SourceAccount | null = null
  private readonly store: CacheStore
  /** 会话请求专用分区：代理规则独立设置，登录 cookie 也不混进主会话 */
  private proxySession: Electron.Session | null = null

  constructor(root: string, store: CacheStore) {
    this.file = path.join(root, 'bilibili-cookies.txt')
    this.accountFile = path.join(root, 'bilibili-account.json')
    this.store = store
  }

  /**
   * 确保访客指纹文件就绪。后台调用即可：领不到也不打扰用户，
   * 没指纹只是 B站搜索会被 412，搜索侧的错误提示会解释原因。
   */
  ensure(): Promise<boolean> {
    if (this.ok) return Promise.resolve(true)
    this.inflight ??= this.grabAll()
    return this.inflight
  }

  /** B站的 yt-dlp 附加参数；没领到指纹就返回空，别硬带一份过期文件 */
  args(): string[] {
    if (!this.ok) return []
    return ['--cookies', this.file, '--user-agent', BILIBILI_UA]
  }

  account(): SourceAccount {
    return this.cached ?? ANONYMOUS_ACCOUNT
  }

  /**
   * 启动时校准登录态。
   * 本地没记录就是没登录，不必联网问——毕竟登录态只可能由我们扫码产生。
   */
  async restore(): Promise<SourceAccount> {
    const raw = await fsp.readFile(this.accountFile, 'utf-8').catch(() => '')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SourceAccount
        if (typeof parsed?.loggedIn === 'boolean') this.cached = parsed
      } catch {
        /* 记录坏了就当没登录 */
      }
    }
    if (!this.cached?.loggedIn) return ANONYMOUS_ACCOUNT
    // 有效期是我们自己抄下来的 SESSDATA 过期时间，过了就别再联网确认
    if (this.cached.expires && this.cached.expires < Date.now()) {
      this.cached = ANONYMOUS_ACCOUNT
      return ANONYMOUS_ACCOUNT
    }
    return this.refresh()
  }

  /** 复核登录态：用户在别处退出、或 SESSDATA 被服务端收回时，这里会翻出为未登录 */
  async refresh(): Promise<SourceAccount> {
    await this.ensure()
    try {
      const nav = await this.get(NAV_URL)
      const data = JSON.parse(nav.body)?.data ?? {}
      if (!data.isLogin) {
        this.cached = ANONYMOUS_ACCOUNT
        await this.saveAccount(ANONYMOUS_ACCOUNT)
        return ANONYMOUS_ACCOUNT
      }
      const next: SourceAccount = {
        loggedIn: true,
        uid: String(data.mid ?? ''),
        uname: String(data.uname ?? ''),
        avatar: String(data.face ?? ''),
        expires: await this.sessdataExpiry()
      }
      this.cached = next
      await this.saveAccount(next)
      await this.dumpCookies()
      return next
    } catch {
      // 网络不通时以本地记录为准，别把已登录的用户判成未登录
      return this.account()
    }
  }

  /**
   * 补齐搜索结果的元数据。
   *
   * yt-dlp 的 bilisearch 跑在 flat 模式下：只拿得到 ID，标题是
   * 「B站视频 av 号」这种占位，艺术家、时长、封面一概没有——
   * 没有名字的搜索结果基本没法用。所以这里再用官方 view 接口
   * 批量补齐，一次并发四五个，12 条大约两三秒。
   *
   * 单个失败（视频被删、风控）就保留占位，不让整批搜索垮掉。
   */
  async enrichEntries(entries: TrackMeta[]): Promise<TrackMeta[]> {
    if (!entries.length) return entries
    const queue = new TaskQueue(3)
    const patched = await Promise.all(
      entries.map((item) =>
        queue.push(async () => {
          let info = await this.videoInfo(item.id, item.url)
          // B站的风控是概率性的：头一次被拦就再试一次，多数情况能过
          if (!info) info = await this.videoInfo(item.id, item.url)
          return info ? { ...item, ...info } : item
        })
      )
    )
    return patched
  }

  /** 单个视频的标题 / 艺术家 / 时长 / 封面；拿不到返回 null */
  private async videoInfo(id: string, url: string): Promise<Partial<TrackMeta> | null> {
    const key = biliKeyOf(id, url)
    if (!key) return null
    try {
      const res = await this.get(
        `https://api.bilibili.com/x/web-interface/view?${key.param}=${encodeURIComponent(key.value)}`
      )
      const data = JSON.parse(res.body)?.data
      if (!data?.title) return null
      return {
        title: String(data.title),
        artist: String(data.owner?.name ?? ''),
        duration: Number(data.duration) || 0,
        thumbnail: String(data.pic ?? '')
      }
    } catch {
      // 单个视频查不动不算错：占位标题照样能下载，只是难看一点
      return null
    }
  }

  /** 取一张登录二维码；内容与样式都在这里备好，UI 直接渲染即可 */
  async startLogin(): Promise<QrTicket> {
    await this.ensure()
    const res = await this.get(QR_GENERATE, PASSPORT_REFERER)
    const data = JSON.parse(res.body)?.data ?? {}
    const key = String(data.qrcode_key ?? '')
    const url = String(data.url ?? '')
    if (!key || !url) throw new Error('B站没有返回二维码，请稍后再试')
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: 208,
      color: { dark: '#14161c', light: '#ffffff' }
    })
    return { key, url, svg }
  }

  /**
   * 轮询扫码结果。
   * B站用 data.code 表达进度：86101 未扫 / 86090 已扫待确认 / 86038 已失效 / 0 成功。
   */
  async pollLogin(key: string): Promise<QrPollResult> {
    const res = await this.get(
      `${QR_POLL}?qrcode_key=${encodeURIComponent(String(key))}`,
      PASSPORT_REFERER
    )
    const body = JSON.parse(res.body)
    const code = Number(body?.data?.code ?? body?.code ?? -1)
    if (code === 0) {
      // Set-Cookie 已经落进分区会话，把它连同指纹一起写进 yt-dlp 的 cookies.txt
      await this.dumpCookies()
      const account = await this.refresh()
      return { state: 'success', account }
    }
    if (code === 86090) return { state: 'scanned', account: null }
    if (code === 86038) return { state: 'expired', account: null }
    return { state: 'waiting', account: null }
  }

  /** 退出登录：清掉登录 cookie，但保留访客指纹——否则连搜索都会一起坏掉 */
  async logout(): Promise<SourceAccount> {
    if (this.proxySession) {
      await Promise.all(
        LOGIN_COOKIES.map((name) =>
          this.proxySession!.cookies.remove(SITE_REFERER, name).catch(() => undefined)
        )
      )
    }
    await this.dumpCookies()
    // 分区会话可能还没领过指纹（刚启动就登出的情况），重写前把指纹补回来
    if (!(await this.readLines()).some((line) => line.includes('buvid3'))) {
      await this.grabAll(true)
    }
    this.cached = ANONYMOUS_ACCOUNT
    await this.saveAccount(ANONYMOUS_ACCOUNT)
    return ANONYMOUS_ACCOUNT
  }

  // ── 内部实现 ───────────────────────────────────────────

  private async grabAll(force = false): Promise<boolean> {
    try {
      const stat = force ? null : await fsp.stat(this.file).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs < REFRESH_MS) {
        this.ok = true
        return true
      }

      // 首页发 b_nut / buvid3，spi 补 buvid4——两步都不能少
      const [home, spi] = await Promise.all([this.get(SITE_REFERER), this.get(SPI_URL)])
      const cookies = collectSetCookies(home)
      try {
        const data = JSON.parse(spi.body)?.data ?? {}
        if (data.b_3) cookies.push({ name: 'buvid3', value: String(data.b_3) })
        if (data.b_4) cookies.push({ name: 'buvid4', value: String(data.b_4) })
      } catch {
        /* spi 挂了就只靠首页那几枚，通常不够，下次启动再试 */
      }
      if (!cookies.length) return false

      // 登录后不能把 SESSDATA 洗掉：指纹与登录态写在同一份文件里
      const kept = (await this.readLines())
        .filter((line) => !line.startsWith('#'))
        .map(parseNetscapeLine)
        .filter((entry): entry is { name: string; value: string } => Boolean(entry))
        .filter((entry) => !cookies.some((c) => c.name === entry.name))

      const expires = Math.floor(Date.now() / 1000) + REFRESH_MS / 1000
      const lines = [
        '# Netscape HTTP Cookie File',
        ...[...cookies, ...kept].map((c) =>
          ['.bilibili.com', 'TRUE', '/', 'TRUE', String(expires), c.name, c.value].join('\t')
        )
      ]
      await fsp.writeFile(this.file, `${lines.join('\n')}\n`, 'utf-8')
      this.ok = true
      return true
    } catch (err) {
      // 允许下次再试；原因打到控制台便于诊断
      console.error('[bilibili] 领取访客指纹失败:', err instanceof Error ? err.message : err)
      this.inflight = null
      return false
    }
  }

  /** 把当前分区会话里的 cookie（指纹 + 可能的 SESSDATA）写成 yt-dlp 能读的 cookies.txt */
  private async dumpCookies(): Promise<void> {
    if (!this.proxySession) return
    const jar = await this.proxySession.cookies.get({ url: SITE_REFERER })
    if (!jar.length) return
    const lines = [
      '# Netscape HTTP Cookie File',
      ...jar.map((cookie) =>
        [
          cookie.domain ?? '.bilibili.com',
          'TRUE',
          cookie.path || '/',
          'TRUE',
          String(Math.floor(cookie.expirationDate ?? Date.now() / 1000 + REFRESH_MS / 1000)),
          cookie.name,
          cookie.value
        ].join('\t')
      )
    ]
    await fsp.writeFile(this.file, `${lines.join('\n')}\n`, 'utf-8')
    this.ok = true
  }

  /** SESSDATA 的到期时间决定登录能撑多久 */
  private async sessdataExpiry(): Promise<number> {
    if (!this.proxySession) return 0
    const list = await this.proxySession.cookies
      .get({ url: SITE_REFERER, name: 'SESSDATA' })
      .catch(() => [])
    const seconds = list[0]?.expirationDate ?? 0
    return seconds ? Math.floor(seconds * 1000) : 0
  }

  private async saveAccount(account: SourceAccount): Promise<void> {
    await fsp.writeFile(this.accountFile, JSON.stringify(account, null, 2), 'utf-8').catch(() => {
      /* 写不进就算了：登录态在内存里照样有效，只是重启后要重新扫码 */
    })
  }

  private async readLines(): Promise<string[]> {
    const raw = await fsp.readFile(this.file, 'utf-8').catch(() => '')
    return raw.split('\n').filter(Boolean)
  }

  /**
   * 走 Chromium 网络栈发请求。
   * 代理必须显式指定：用户开「自动」模式时系统 PAC 会把 B站分流成直连，
   * 而直连在这个环境里会被掐断（net::ERR_CONNECTION_ABORTED）；
   * yt-dlp 能通正是因为 resolveProxyArgs 给了它具体的代理地址。
   */
  private async get(url: string, referer = SITE_REFERER): Promise<SimpleResponse> {
    if (!this.proxySession) {
      this.proxySession = session.fromPartition('vinylbox-bilibili')
      const settings = this.store.getSettings()
      const { proxy } = await resolveProxyArgs(settings.proxyMode, settings.proxy)
      await this.proxySession.setProxy(
        proxy ? { proxyRules: proxy, proxyBypassRules: '<local>' } : { mode: 'direct' }
      )
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        request.abort()
        reject(new Error('bilibili request timeout'))
      }, 20_000)
      const request = net.request({ url, session: this.proxySession! })
      request.setHeader('User-Agent', BILIBILI_UA)
      request.setHeader('Referer', referer)
      const chunks: Buffer[] = []
      request.on('response', (response) => {
        response.on('data', (chunk) => chunks.push(chunk as Buffer))
        response.on('end', () => {
          clearTimeout(timer)
          resolve({ body: Buffer.concat(chunks).toString('utf-8'), headers: response.headers })
        })
      })
      request.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      request.end()
    })
  }
}

function collectSetCookies(res: SimpleResponse): { name: string; value: string }[] {
  const raw = res.headers['set-cookie'] ?? []
  const cookies: { name: string; value: string }[] = []
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const [pair] = String(item).split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) cookies.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() })
  }
  return cookies
}

/** view 接口只认 bvid / aid 两种参数，从 id 或页面地址里凑一个出来 */
function biliKeyOf(
  id: string,
  url: string
): { param: 'bvid' | 'aid'; value: string } | null {
  const fromUrl = /\/video\/(BV[\w]+|av\d+)/i.exec(url)?.[1]
  const token = (fromUrl ?? id).trim()
  if (/^bv/i.test(token)) return { param: 'bvid', value: token }
  if (/^av(\d+)$/i.test(token)) return { param: 'aid', value: token.slice(2) }
  if (/^\d+$/.test(token)) return { param: 'aid', value: token }
  return null
}

function parseNetscapeLine(line: string): { name: string; value: string } | null {
  const parts = line.split('\t')
  if (parts.length < 7) return null
  return { name: parts[5], value: parts.slice(6).join('\t') }
}
