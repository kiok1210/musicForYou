import { createReadStream, promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import path from 'node:path'
import { BrowserWindow, app, ipcMain, protocol, screen, session, shell } from 'electron'
import {
  ANONYMOUS_ACCOUNT,
  type CategoryInput,
  type CategorySummary,
  type IpcResult,
  type Lyrics,
  type PlaybackSnapshot,
  type ProxyMode,
  type QrPollResult,
  type QrTicket,
  type SourceAccount,
  type SourceInput,
  type Track,
  type TrackMeta
} from '@shared/types'
import { CUSTOM_ID_PREFIX, allCategories, discoverQuery } from './catalog'
import { allSources, sourceById, sourceForUrl } from './sources'
import { BilibiliSession } from './bilibili'
import { CacheStore } from './library'
import { DownloadManager } from './downloader'
import { fetchLyrics, localizeLyrics, readLyricsCache, saveLyrics } from './lyrics'
import { handleStreamRequest, registerStreamProtocol } from './stream'
import { startApiServer } from './api-server'
import { SiteSession, expandShortLink } from './site-session'
import { resolveDouyinClip } from './douyin'
import { installTranscriber, isTranscriberInstalled, transcribeTrack } from './transcriber'
import {
  ToolError,
  getFfmpegPath,
  getYtDlpRunner,
  installToolchain,
  probeYouTube,
  resetSystemProxyCache,
  updateYtDlp
} from './tools'
import { isDouyinNote, parsePastedInput } from '@shared/portable/platforms'
import { resolveUrl, searchSource } from './ytdlp'

const MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/** media 读本地缓存，stream 边下边听，两者都需要 Range 与流式响应 */
const STREAMING_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  bypassCSP: true,
  corsEnabled: true
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: STREAMING_PRIVILEGES },
  { scheme: 'stream', privileges: STREAMING_PRIVILEGES }
])

/**
 * 站点认证实现的最小接口（B站的实现见 bilibili.ts）。
 *
 * 新增支持登录的站点时：实现这个接口，登记进 AUTH_PROVIDERS，
 * 并在它的 MediaSource 上声明 auth 方式。
 */
interface SourceAuth {
  account(): SourceAccount
  refresh(): Promise<SourceAccount>
  startLogin(): Promise<QrTicket>
  pollLogin(key: string): Promise<QrPollResult>
  logout(): Promise<SourceAccount>
}

const store = new CacheStore()
/** B站会话：访客指纹 + 扫码登录，搜索 B站时必需 */
const biliSession = new BilibiliSession(store.root, store)

/**
 * 抖音：web 详情接口要一份「新鲜」的反爬凭证，而 ttwid 这类 cookie
 * 是页面脚本写进浏览器的，只发 HTTP 请求拿不到，所以必须真开一次首页。
 * （yt-dlp 报错里提的 s_v_web_id 已经不再下发，实测首页给的是 ttwid。）
 */
const douyinSession = new SiteSession(store, store.root, {
  id: 'douyin',
  pages: ['https://www.douyin.com/'],
  cookieDomain: '.douyin.com',
  referer: 'https://www.douyin.com/',
  required: ['ttwid']
})

/** 小红书：没有非拿不可的 cookie，带上只是更稳 */
const xhsSession = new SiteSession(store, store.root, {
  id: 'xiaohongshu',
  urls: ['https://www.xiaohongshu.com/'],
  cookieDomain: '.xiaohongshu.com',
  referer: 'https://www.xiaohongshu.com/'
})

/**
 * 站点认证实现登记表。
 *
 * 新增一个支持扫码登录的站点：实现下面的 SourceAuth 接口，
 * 在这里登记，并在它的 MediaSource 上写 `auth: 'qrcode'`——
 * 设置面板的登录入口、取流与下载的凭证注入就都自动生效了。
 */
const AUTH_PROVIDERS: Record<string, SourceAuth> = {
  bilibili: biliSession
}

/**
 * 访客指纹领取器登记表。
 *
 * 各站发指纹的方式没有共性，只能逐个实现；登记后，任何声明了
 * `fingerprint: true` 的源都会自动拿到对应的 cookie 与 UA。
 */
const FINGERPRINT_PROVIDERS: Record<string, () => Promise<string[]>> = {
  bilibili: async () => ((await biliSession.ensure()) ? biliSession.args() : []),
  douyin: async () => ((await douyinSession.ensure()) ? douyinSession.args() : []),
  xiaohongshu: async () => ((await xhsSession.ensure()) ? xhsSession.args() : [])
}

/**
 * 按源返回附加的 yt-dlp 参数。
 * B站的搜索、取直链、下载都得带访客指纹与绑定 UA，其余源没有额外要求。
 */
/**
 * 按源返回附加的 yt-dlp 参数。
 *
 * 判据全部来自源自己的声明（MediaSource.extraArgs / fingerprint），
 * 而不是在这里写死站点名——新增一个需要凭证的源，只要在数据里声明即可。
 */
async function sourceExtraArgs(sourceId?: string): Promise<string[]> {
  const source = sourceById(String(sourceId ?? ''))
  if (!source) return []
  const extras: string[] = [...(source.extraArgs ?? [])]
  // 需要访客指纹的站点：领取指纹，并带上与指纹绑定的 UA（两者必须成对出现）
  if (source.fingerprint) {
    const provider = FINGERPRINT_PROVIDERS[source.id]
    if (provider) extras.push(...(await provider()))
  }
  return extras
}

const downloads = new DownloadManager(store, sourceExtraArgs)
let mainWindow: BrowserWindow | null = null
let installing = false
/** 手机端配套服务的端口，启动后回填 */
let apiPort = 0

/** 本机的局域网地址：手机 App 要连的就是它 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address)
    }
  }
  return out
}

/** 浮窗模式的尺寸：刚好容下唱片与走带控制 */
const MINI_WIDTH = 344
const MINI_HEIGHT = 438
/** 离开浮窗时还原到的位置与大小（浮窗之前处于最大化则为 null） */
let normalBounds: { x: number; y: number; width: number; height: number } | null = null

/* 启动耗时打点，便于定位「打开慢」到底慢在哪一段 */
const bootAt = Date.now()
function mark(label: string): void {
  console.log(`[boot] ${label} +${Date.now() - bootAt}ms`)
}

/** 代理设置的完成信号：不阻塞首屏，但网络请求前必须已生效 */
let proxyReady: Promise<void> = Promise.resolve()

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, code, message }
}

async function guard<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    if (err instanceof ToolError) return fail(err.code, err.message)
    const message = err instanceof Error ? err.message : String(err)
    return fail('UNKNOWN', message)
  }
}

/**
 * 所有通道的实现都登记在这张表里。
 *
 * 桌面端走 IPC，手机 App 走 HTTP（见 api-server.ts）——两条路复用同一份实现，
 * 新增功能只需要写一遍。
 */
const channels = new Map<string, (event: unknown, ...args: any[]) => unknown>()

/** 注册一个通道：登记实现，同时挂到 IPC 上 */
function handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void {
  channels.set(channel, fn)
  ipcMain.handle(channel, fn)
}

/** 手机端的事件订阅（SSE）挂在这里 */
const pushTargets = new Set<(channel: string, payload: unknown) => void>()

/** 给所有客户端推事件：桌面窗口与手机 App 都要收到 */
function push(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
  for (const target of pushTargets) target(channel, payload)
}

function requestExtras(): Promise<string[]> {
  return store.requestArgs()
}

/**
 * 只放行网页链接。
 * 私有协议（snssdk1128://、bitbrowser:// 这类）一开就会弹系统的
 * 「需要使用新应用以打开此链接」对话框，用户完全摸不着头脑。
 */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 组装 yt-dlp 附加参数：通用代理与 cookies 文件，再叠加该源声明的凭证。
 * 源的特例处理一律由 sourceExtraArgs 按数据分发，这里不认具体站点。
 */
async function withSourceExtras(input: { sourceId?: string; url?: string }): Promise<string[]> {
  const extras = await requestExtras()
  const id = input.url ? sourceForUrl(input.url)?.id : input.sourceId
  return [...extras, ...(await sourceExtraArgs(id))]
}

/** 让 Electron 自身与 yt-dlp 使用同一套代理策略，保证探测结果可信 */
/**
 * 启动后归集遗留文件，并异步补齐缺失的曲目元数据。
 * 网络不通时立刻停止，不阻塞界面。
 */
async function hydrateLibrary(): Promise<void> {
  let changed = await store.reconcile()

  const pending = store.pendingMetadata()
  if (pending.length) {
    const extras = await requestExtras()
    const biliExtra = await (async () => {
      await biliSession.ensure()
      return biliSession.args()
    })()
    for (const track of pending) {
      try {
        // 用曲目的原始地址补元数据，换源之后拼 YouTube 链接是取不到东西的；
        // B站的链接要带上访客指纹，否则元数据接口也回 412
        const meta = await resolveUrl(track.url, [
          ...extras,
          ...(sourceForUrl(track.url)?.id === 'bilibili' ? biliExtra : [])
        ])
        const current = store.findTrack(track.id)
        await store.updateTrack(track.id, {
          title: meta.title,
          artist: meta.artist,
          duration: meta.duration,
          thumbnail: meta.thumbnail,
          url: meta.url || track.url
        })
        // 补齐后如果用户已经手动改过播放统计，保留原值
        if (current?.playCount) await store.updateTrack(track.id, { playCount: current.playCount })
        changed = true
      } catch {
        break
      }
    }
  }

  // 为还没有任何标签的曲目自动落标签
  const untagged = store.untagged()
  for (const track of untagged) {
    await store.setAutoTags(track.id, {})
    changed = true
  }

  if (changed) push('library:changed', store.listTracks())
}

/** 取歌词，并把「歌词语言 / 是否纯器乐」回填成标签 */
async function loadLyricsFor(track: Track, force: boolean): Promise<Lyrics> {
  const before = JSON.stringify(track.tags ?? [])
  const lyrics = await fetchLyrics(track, store, force)
  if (lyrics.lines.length) {
    await store.setAutoTags(track.id, {
      language: lyrics.language,
      instrumental: lyrics.instrumental
    })
  }
  const after = JSON.stringify(store.findTrack(track.id)?.tags ?? [])
  if (before !== after) push('library:changed', store.listTracks())
  return lyrics
}

async function applyProxy(mode: ProxyMode, proxy: string): Promise<void> {
  if (mode === 'off') {
    await session.defaultSession.setProxy({ mode: 'direct' })
    return
  }
  const target = mode === 'manual' ? (proxy ?? '').trim() : ''
  if (target) {
    await session.defaultSession.setProxy({ proxyRules: target, proxyBypassRules: '<local>' })
  } else {
    // auto：交给 Chromium 读取系统设置与 PAC 脚本
    await session.defaultSession.setProxy({ mode: 'system' })
  }
}

/** 用 media:// 自定义协议把本地缓存文件喂给播放器，并支持 Range 拖动 */
function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    const base = url.hostname === 'cover' ? store.coverDir : store.mediaDir
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const resolved = path.resolve(base, relative)
    if (!resolved.startsWith(path.resolve(base))) {
      return new Response('Forbidden', { status: 403 })
    }
    let stat = await fsp.stat(resolved).catch(() => null)
    let filePath = resolved
    if (!stat && url.hostname === 'cover') {
      // 封面兜底：可能仍留在媒体目录里
      const fallback = path.resolve(store.mediaDir, relative)
      stat = await fsp.stat(fallback).catch(() => null)
      filePath = fallback
    }
    if (!stat) return new Response('Not Found', { status: 404 })

    const total = stat.size
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const baseHeaders: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600'
    }

    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = match?.[1] ? Number(match[1]) : 0
      let end = match?.[2] ? Number(match[2]) : total - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= total) end = total - 1
      if (start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
      }
      // 边读边发：几十 MB 的文件拖动进度条时不必整份读进内存
      const slice = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(slice) as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`
        }
      })
    }

    const full = createReadStream(filePath)
    return new Response(Readable.toWeb(full) as ReadableStream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) }
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1000,
    minHeight: 660,
    // 立即显示：双击后马上出现窗口，内容稍后填充
    // 背景色与页面底色一致，因此不会有白屏闪烁
    show: true,
    frame: false,
    backgroundColor: '#08080a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mark('window shown')
  })
  mainWindow.webContents.on('did-finish-load', () => mark('renderer loaded'))

  // 关窗前先让渲染进程把播放进度落盘，避免丢掉最后几秒
  let flushed = false
  mainWindow.on('close', (event) => {
    if (flushed || !mainWindow) return
    event.preventDefault()
    flushed = true
    const win = mainWindow
    win.webContents.send('player:flush')
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy()
    }, 220)
  })
  mainWindow.on('maximize', () => push('window:maximized', true))
  mainWindow.on('unmaximize', () => push('window:maximized', false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行网页：私有协议一律拦下，别拿去麻烦系统
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function broadcastList(): void {
  push('dl:list', downloads.list())
}

function registerIpc(): void {
  downloads.on('update', (task) => push('dl:update', task))
  downloads.on('list', broadcastList)
  downloads.on('done', (track: Track) => {
    push('library:changed', store.listTracks())
    push('dl:done', track)
    // 后台预取歌词并补标签，不阻塞下载流程
    void loadLyricsFor(track, false)
      .then((lyrics) => push('lyrics:ready', { trackId: track.id, lyrics }))
      .catch(() => undefined)
  })

  handle('tools:status', () =>
    guard(async () => {
      const runner = await getYtDlpRunner()
      const ffmpeg = await getFfmpegPath()
      return {
        ytDlpReady: Boolean(runner),
        ytDlpLabel: runner?.label ?? '未安装',
        ffmpegReady: Boolean(ffmpeg),
        installing
      }
    })
  )

  handle('tools:install', () =>
    guard(async () => {
      if (installing) throw new ToolError('INSTALLING', '组件正在安装中，请稍候')
      installing = true
      try {
        await installToolchain((progress) => {
          push('tools:install-progress', progress)
        })
        const runner = await getYtDlpRunner()
        return runner?.label ?? 'ready'
      } finally {
        installing = false
      }
    })
  )

  /**
   * 更新 yt-dlp 到官方最新版。
   * 装进私有 bin 目录（检测顺序里排在安装包内置版本之前），
   * 于是升级不必动安装包，内置的那份也不会被写坏。
   */
  handle('tools:update-ytdlp', () =>
    guard(async () => {
      if (installing) throw new ToolError('INSTALLING', '组件正在安装中，请稍候')
      installing = true
      try {
        const version = await updateYtDlp(store.getSettings(), (progress) => {
          push('tools:install-progress', progress)
        })
        // 强制重新探测，让设置页立刻显示新版本而不是缓存的旧标识
        const runner = await getYtDlpRunner(true)
        return runner?.label ?? `yt-dlp ${version}`
      } finally {
        installing = false
      }
    })
  )

  handle('yt:search', (_event, query: string, limit: number, sourceId?: string) =>
    guard(async () => {
      const trimmed = String(query ?? '').trim()
      if (!trimmed) throw new ToolError('EMPTY_QUERY', '请输入关键词或链接')
      const size = Math.min(Math.max(Number(limit) || 12, 1), 30)
      // 粘贴链接时不看当前源：yt-dlp 自己认站点，换源与否都能解析。
      // 粘进来的也可能是一整段分享文案（抖音、小红书都是「文案 + 链接」混排）
      const pasted = parsePastedInput(trimmed)
      if (pasted) {
        // 短链先展开：小红书的 xsec_token 就藏在跳转结果的 query 里，丢了什么都取不到
        const link = await expandShortLink(pasted, store)
        const source = sourceForUrl(link)
        // 抖音的详情接口要签名参数，yt-dlp 取不到，只能开页面自己算（见 douyin.ts）
        if (source?.id === 'douyin') {
          if (isDouyinNote(link)) {
            throw new ToolError(
              'DOUYIN_NOTE',
              '这是抖音的图文作品（只有图片、没有音视频），缓存不了音频。换一条视频作品的链接试试。'
            )
          }
          const clip = await resolveDouyinClip(link, douyinSession)
          return [{ ...clip, sourceId: 'douyin' }]
        }
        const meta = await resolveUrl(link, await withSourceExtras({ url: link }))
        // 来源跟着曲目走：之后试听与下载都用它当初的源
        return [{ ...meta, sourceId: meta.sourceId ?? source?.id }]
      }
      const source = sourceById(String(sourceId ?? '')) ?? sourceById('youtube')
      if (!source?.searchKey) {
        throw new ToolError(
          'SOURCE_NO_SEARCH',
          `「${source?.name ?? '这个源'}」不支持站内搜索，请直接粘贴链接`
        )
      }
      const found = await searchSource(
        trimmed,
        size,
        source.searchKey,
        await withSourceExtras({ sourceId: source.id })
      )
      const tagged = found.map((item) => ({ ...item, sourceId: source.id }))
      // B站的 flat 搜索只有编号，标题是「B站视频 av 号」占位，用官方接口补齐
      if (source.id === 'bilibili') return biliSession.enrichEntries(tagged)
      return tagged
    })
  )

  /**
   * 取某个源的登录实现。
   * 没登记的源一律返回 null——它们不需要登录，走通用参数即可，
   * 于是「新增源」不必改动任何登录相关的代码。
   */
  function authOf(sourceId: unknown): SourceAuth | null {
    return AUTH_PROVIDERS[String(sourceId ?? '')] ?? null
  }

  handle('auth:status', (_event, sourceId: string) => {
    const provider = authOf(sourceId)
    return ok(provider ? provider.account() : ANONYMOUS_ACCOUNT)
  })

  /** 联网复核一次：用户在别处退出、或凭证被收回时这里会翻回未登录 */
  handle('auth:refresh', (_event, sourceId: string) => {
    const provider = authOf(sourceId)
    return provider ? guard(() => provider.refresh()) : ok(ANONYMOUS_ACCOUNT)
  })

  /** 支持扫码登录的源列表：设置面板据此渲染登录入口，新增源会自动出现 */
  handle('auth:sources', () =>
    ok(allSources().filter((source) => source.auth === 'qrcode'))
  )

  handle('auth:qrcode', (_event, sourceId: string) => {
    const provider = authOf(sourceId)
    if (!provider) return Promise.resolve(fail('AUTH_UNSUPPORTED', '这个源不支持应用内扫码登录'))
    return guard(() => provider.startLogin())
  })

  handle('auth:poll', async (_event, sourceId: string, key: string) => {
    const provider = authOf(sourceId)
    if (!provider) return fail('AUTH_UNSUPPORTED', '这个源不支持应用内扫码登录')
    const result = await guard(() => provider.pollLogin(String(key)))
    if (result.ok && result.data.state === 'success' && result.data.account) {
      // 登录成功后广播：带上源，UI 才知道刷哪一行账号
      push('auth:login-changed', {
        sourceId: String(sourceId),
        account: result.data.account
      })
    }
    return result
  })

  handle('auth:logout', (_event, sourceId: string) => {
    const provider = authOf(sourceId)
    if (!provider) return Promise.resolve(ok(ANONYMOUS_ACCOUNT))
    return guard(async () => {
      const account = await provider.logout()
      push('auth:login-changed', {
        sourceId: String(sourceId),
        account
      })
      return account
    })
  })

  handle('sources:list', () => ok(allSources()))

  handle('sources:add', (_event, input: SourceInput) =>
    guard(() => {
      store.addSource(input ?? { name: '', hosts: [], searchKey: '', home: '' })
      return allSources()
    })
  )

  handle('sources:remove', (_event, id: string) =>
    guard(() => {
      store.removeSource(String(id))
      return allSources()
    })
  )

  handle('yt:resolve', (_event, url: string) => {
    const trimmed = String(url).trim()
    return guard(async () => resolveUrl(trimmed, await withSourceExtras({ url: trimmed })))
  })

  handle('net:probe', () =>
    guard(async () => {
      await proxyReady
      // 每次探测都重新解析，避免 PAC 脚本内容变化后拿到陈旧结果
      resetSystemProxyCache()
      const current = store.getSettings()
      return probeYouTube(current.proxyMode, current.proxy)
    })
  )

  handle('dl:list', () => ok(downloads.list()))
  handle('dl:enqueue', (_event, meta: TrackMeta) => guard(() => downloads.enqueue(meta)))
  handle('dl:cancel', (_event, id: string) =>
    guard(() => {
      downloads.cancel(String(id))
      return true
    })
  )
  handle('dl:clear', (_event, scope: 'finished' | 'all') =>
    guard(() => {
      if (scope === 'all') {
        for (const task of downloads.list()) {
          if (task.status === 'downloading' || task.status === 'queued') downloads.cancel(task.id)
        }
      }
      downloads.clearFinished()
      return downloads.list()
    })
  )

  handle('library:list', () => ok(store.listTracks()))
  handle('library:remove', (_event, id: string, deleteFile: boolean) =>
    guard(() => store.removeTrack(String(id), deleteFile !== false))
  )
  handle('library:toggleFavorite', (_event, id: string) =>
    guard(async () => {
      const track = store.findTrack(String(id))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      await store.updateTrack(track.id, { favorite: !track.favorite })
      return store.listTracks()
    })
  )
  handle('library:markPlayed', (_event, id: string) =>
    guard(async () => {
      const track = store.findTrack(String(id))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      return store.updateTrack(track.id, {
        playCount: track.playCount + 1,
        lastPlayedAt: Date.now()
      })
    })
  )

  /** 记录播放位置。长内容（有声书）靠它断点续听 */
  handle('library:progress', (_event, id: string, position: number) =>
    guard(async () => {
      const track = store.findTrack(String(id))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      const seconds = Number(position)
      // 上限用时长兜底，避免元数据缺失时存进异常大的值
      const ceiling = track.duration > 0 ? track.duration : seconds
      const safe = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, ceiling)) : 0
      return store.updateTrack(track.id, { progress: safe })
    })
  )
  handle('library:reveal', (_event, id: string) =>
    guard(async () => {
      const track = store.findTrack(String(id))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      shell.showItemInFolder(path.join(store.mediaDir, track.fileName))
      return true
    })
  )

  handle('lyrics:get', (_event, trackId: string, force: boolean) =>
    guard(async () => {
      const track = store.findTrack(String(trackId))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      return loadLyricsFor(track, Boolean(force))
    })
  )

  /** 深度兜底：本地语音识别，完全离线，不依赖任何在线歌词源 */
  handle('lyrics:transcribe', (_event, trackId: string) =>
    guard(async () => {
      const track = store.findTrack(String(trackId))
      if (!track) throw new ToolError('NOT_FOUND', '曲目不存在')
      const settings = store.getSettings()
      const notify = (progress: { stage: string; ratio: number }): void => {
        push('lyrics:transcribe-progress', progress)
      }

      if (!(await isTranscriberInstalled())) {
        notify({ stage: '正在安装本地识别组件…', ratio: 0.02 })
        await installTranscriber((step) => notify({ stage: step, ratio: 0.04 }))
      }

      const recognized = await transcribeTrack(track, store, {
        model: settings.whisperModel,
        onProgress: notify
      })
      const lyrics = await localizeLyrics(recognized, store)
      await saveLyrics(store, track.id, lyrics)
      await store.setAutoTags(track.id, { language: lyrics.language })
      push('library:changed', store.listTracks())
      push('lyrics:ready', { trackId: track.id, lyrics })
      return lyrics
    })
  )

  /** 分类看板：每个分类已缓存多少首、总时长多少 */
  function categorySummaries(): CategorySummary[] {
    const tracks = store.listTracks()
    return allCategories().map((category) => {
      const matched = tracks.filter((track) =>
        (track.tags ?? []).some((tag) => tag.label === category.name)
      )
      return {
        ...category,
        count: matched.length,
        duration: matched.reduce((sum, track) => sum + (track.duration || 0), 0),
        custom: category.id.startsWith(CUSTOM_ID_PREFIX)
      }
    })
  }

  handle('discover:categories', () => ok(categorySummaries()))

  /** 自建分类：只收名称与关键词，归类特征词由主进程派生 */
  handle('discover:add-category', (_event, input: CategoryInput) =>
    guard(() => {
      store.addCategory(input ?? { name: '', blurb: '', keywords: [] })
      return categorySummaries()
    })
  )

  handle('discover:remove-category', (_event, id: string) =>
    guard(() => {
      store.removeCategory(String(id))
      // 该分类名对应的自动标签可能被一并清掉，曲库要跟着刷新
      push('library:changed', store.listTracks())
      return categorySummaries()
    })
  )

  /** 「发现更多」：用分类的关键词轮换查询，返回结果供直接缓存 */
  handle('discover:search', (_event, categoryId: string, seed: number, sourceId?: string) =>
    guard(async () => {
      const query = discoverQuery(String(categoryId), Number(seed) || 0)
      const settings = store.getSettings()
      const source = sourceById(String(sourceId ?? '')) ?? sourceById('youtube')
      const found = await searchSource(
        query,
        settings.searchLimit,
        source?.searchKey ?? 'ytsearch',
        await withSourceExtras({ sourceId: source?.id })
      )
      // 快照里的每首都带上当时的源：回看后试听与下载不用再猜
      const results = found.map((item) => ({ ...item, sourceId: source?.id }))
      // B站的 flat 搜索只有编号，标题是「B站视频 av 号」占位，用官方接口补齐
      const enriched =
        source?.id === 'bilibili' ? await biliSession.enrichEntries(results) : results
      // 存成快照，之后在发现页能原样翻回来
      const batch = store.rememberDiscover({
        categoryId: String(categoryId),
        query,
        sourceId: source?.id ?? '',
        sourceName: source?.name ?? '',
        tracks: enriched
      })
      return { query, results: enriched, batch }
    })
  )

  handle('discover:history', () => ok(store.listDiscoverHistory()))

  handle('discover:forget', (_event, id?: string) =>
    guard(() => store.forgetDiscover(id ? String(id) : undefined))
  )

  handle('tags:list', () => ok(store.allTags()))
  handle('tags:add', (_event, id: string, label: string) =>
    guard(async () => {
      await store.addTag(String(id), String(label))
      return store.listTracks()
    })
  )
  handle('tags:remove', (_event, id: string, label: string) =>
    guard(async () => {
      await store.removeTag(String(id), String(label))
      return store.listTracks()
    })
  )
  handle('tags:retag', () =>
    guard(async () => {
      for (const track of store.listTracks()) {
        const lyrics = await readLyricsCache(store, track.id)
        await store.setAutoTags(track.id, {
          language: lyrics?.language ?? null,
          instrumental: lyrics?.instrumental
        })
      }
      return store.listTracks()
    })
  )

  handle('player:snapshot', () => guard(() => store.getPlayback()))
  handle('player:save', (_event, snapshot: PlaybackSnapshot) =>
    guard(async () => {
      await store.savePlayback(snapshot)
      return true
    })
  )

  handle('settings:get', () => ok(store.getSettings()))
  handle('settings:save', (_event, patch) =>
    guard(async () => {
      const next = await store.saveSettings(patch ?? {})
      // 代理相关变更后重新解析并同步给 Electron 自身
      if (patch && ('proxy' in patch || 'proxyMode' in patch)) {
        resetSystemProxyCache()
        await applyProxy(next.proxyMode, next.proxy)
      }
      return next
    })
  )

  handle('cache:stats', () => guard(() => store.stats()))
  handle('cache:openDir', () =>
    guard(async () => {
      await shell.openPath(store.mediaDir)
      return store.mediaDir
    })
  )
  handle('cache:clear', () => guard(() => store.clearAll()))

  /** 手机端配对信息：在设置里显示，扫码或手输都行 */
  handle('api:info', () =>
    ok({
      port: apiPort,
      addresses: lanAddresses().map((address) => `http://${address}:${apiPort}`),
      running: apiPort > 0
    })
  )

  handle('app:openExternal', (_event, url: string) =>
    guard(async () => {
      const target = String(url)
      // 只打开网页：私有协议会弹系统的「打开方式」对话框
      if (!isWebUrl(target)) throw new ToolError('BAD_URL', '只能打开 http / https 链接')
      await shell.openExternal(target)
      return true
    })
  )
  handle('app:info', () =>
    ok({
      version: app.getVersion(),
      platform: process.platform,
      userData: store.root
    })
  )

  handle('window:minimize', () => {
    mainWindow?.minimize()
    return ok(true)
  })
  handle('window:toggleMaximize', () => {
    if (!mainWindow) return ok(false)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return ok(mainWindow.isMaximized())
  })
  handle('window:close', () => {
    mainWindow?.close()
    return ok(true)
  })
  handle('window:isMaximized', () => ok(mainWindow?.isMaximized() ?? false))

  /**
   * 精简浮窗：让主窗口自己缩成播放器大小并置顶。
   * 不另开窗口是因为播放引擎在渲染进程里，另开一个就得同步两边的播放状态，
   * 变形方案没有这层通信，行为也更可预期。
   */
  handle('window:mini', (_event, enabled: boolean) =>
    guard(() => {
      const win = mainWindow
      if (!win || win.isDestroyed()) return false

      if (enabled) {
        // 记住原来的位置与大小，展开时原样还回去
        normalBounds = win.isMaximized() ? null : win.getBounds()
        if (win.isMaximized()) win.unmaximize()
        // 主窗口默认最小 1000×660，不先放开就缩不到浮窗尺寸
        win.setMinimumSize(240, 320)
        win.setAlwaysOnTop(true, 'floating')
        win.setSize(MINI_WIDTH, MINI_HEIGHT)

        const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        win.setPosition(
          Math.round(workArea.x + workArea.width - MINI_WIDTH - 22),
          Math.round(workArea.y + workArea.height - MINI_HEIGHT - 22)
        )
        // 尺寸调完再锁住：反过来在部分 Windows 环境下会把窗口钉在原大小
        win.setResizable(false)
        console.log(
          `[mini] 进入浮窗 bounds=${JSON.stringify(win.getBounds())} 目标=${MINI_WIDTH}x${MINI_HEIGHT}`
        )
        return true
      }

      win.setResizable(true)
      win.setAlwaysOnTop(false)
      win.setMinimumSize(1000, 660)
      if (normalBounds) win.setBounds(normalBounds)
      else {
        win.setSize(1240, 800)
        win.center()
      }
      console.log(`[mini] 退出浮窗 bounds=${JSON.stringify(win.getBounds())}`)
      return true
    })
  )
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    mark('app ready')
    await store.init()
    mark('store ready')
    registerMediaProtocol()
    registerStreamProtocol(store, sourceExtraArgs)
    registerIpc()

    // 手机端配套服务：App 用同一套通道调用电脑上的 yt-dlp，
    // 这里只负责搬运，业务逻辑与桌面端共用一份（见 api-server.ts）
    try {
      startApiServer({
        channels,
        mediaDir: store.mediaDir,
        version: app.getVersion(),
        subscribe: (target) => {
          pushTargets.add(target)
          return () => pushTargets.delete(target)
        },
        stream: (request) => handleStreamRequest(request, store, sourceExtraArgs),
        onReady: (port) => {
          apiPort = port
          mark(`api server on :${port}`)
        }
      })
    } catch (err) {
      console.error('[api] 配套服务启动失败:', err instanceof Error ? err.message : err)
    }

    createWindow()
    mark('window created')

    // 代理设置可能触发 PAC 解析，放到窗口之后再跑，不拖首屏
    const initial = store.getSettings()
    proxyReady = applyProxy(initial.proxyMode, initial.proxy).then(() => mark('proxy ready'))

    // 归集缓存、补齐元数据、打标签都放到窗口稳定之后
    setTimeout(() => void hydrateLibrary(), 3000)

    // B站会话后台就绪：先领访客指纹，再复核登录态，都不阻塞首屏
    void (async () => {
      const okBili = await biliSession.ensure()
      mark(okBili ? 'bilibili fingerprint ready' : 'bilibili fingerprint unavailable')
      const account = await biliSession.restore()
      mark(account.loggedIn ? `bilibili logged in: ${account.uname}` : 'bilibili anonymous')
      if (account.loggedIn) {
        push('auth:login-changed', { sourceId: 'bilibili', account })
      }
    })()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
