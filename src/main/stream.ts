/**
 * 边下边听：把音频直链包成 stream:// 协议喂给播放器。
 *
 * 为什么不把直链直接交给 <audio>：
 * 1. 不少 CDN（googlevideo、B 站的 bilivideo）会校验 Referer，页面环境发不出这个头，会直接 403
 * 2. 直链请求必须走与下载一致的代理，只有自定义协议才控得住
 *
 * 走协议转发还有个好处：Range 请求原样透传，Chromium 于是能像读本地
 * 文件那样边拉边播，拖动进度条也只取对应的那一段。
 *
 * 支持多源之后这里有两个关键变化：
 * - 取直链用的是曲目的原始页面地址，不再拼 YouTube 链接（换了源那个链接必然失效）
 * - Referer 也随源走，由页面地址推出；拿 YouTube 的 Referer 去请求 B 站 CDN 一样会被拒
 */
import { protocol, session } from 'electron'
import { friendlyYtDlpError, lastErrorLine } from '@shared/portable/ytdlp-output'
import { spawnYtDlp } from './ytdlp'
import type { CacheStore } from './library'

/** 直链本身有效期约 6 小时，这里保守缓存 25 分钟 */
const URL_TTL = 25 * 60 * 1000

const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 只透传必要的响应头，其余交给 Chromium 自行判断 */
const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control'
]

/** 各站 ID 的长度差异较大（YouTube 11 位、B 站 BV 号 12 位），放宽范围 */
const VIDEO_ID = /^[A-Za-z0-9_-]{4,40}$/

interface Entry {
  url: string
  referer: string
  at: number
}

const cache = new Map<string, Entry>()
/** 同一视频的并发解析只跑一次 yt-dlp */
const inflight = new Map<string, Promise<Entry>>()

export function clearStreamCache(): void {
  cache.clear()
}

/** 由页面地址推出该站需要的来源头；拿不到就退回 YouTube */
function refererOf(page: string): string {
  try {
    return new URL(page).origin + '/'
  } catch {
    return 'https://www.youtube.com/'
  }
}

/** 取音频直链与它需要的 Referer，失败时抛出可读的中文原因 */
export async function resolveStreamUrl(
  videoId: string,
  store: CacheStore,
  source: { id?: string; page?: string; referer?: string } = {},
  sourceArgs?: (sourceId?: string) => Promise<string[]>
): Promise<Entry> {
  const hit = cache.get(videoId)
  if (hit && Date.now() - hit.at < URL_TTL) return hit

  const running = inflight.get(videoId)
  if (running) return running

  const job = (async (): Promise<Entry> => {
    const began = Date.now()
    // 曲目自带来源时用该源的参数：回看 B站的批次试听，不因当前源切成了 YouTube 而失败
    const extras = [
      ...(await store.requestArgs()),
      ...((await sourceArgs?.(source.id)) ?? [])
    ]
    // 页面地址优先用播放器带来的（搜索结果还没落库，本地查不到）；
    // 都没有时按源拼一个回退地址——换了源，拼 YouTube 链接是取不到东西的
    const known = store.findTrack(videoId)
    const page =
      source.page ||
      known?.url ||
      (source.id === 'bilibili'
        ? `https://www.bilibili.com/video/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`)
    // 来源头：解析方明确给的优先（抖音 CDN 只认 douyin.com，推不出来）
    const referer = source.referer || known?.referer || refererOf(page)
    const { stdout, stderr, code, timedOut } = await spawnYtDlp(
      [
        page,
        '--no-playlist',
        '--no-warnings',
        '-f',
        'bestaudio[ext=m4a]/bestaudio/best',
        '--get-url',
        ...extras
      ],
      { timeoutMs: 30_000 }
    )
    if (timedOut) throw new Error('取流超时，请检查网络或代理设置')
    const url = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('http'))
    if (code !== 0 || !url) {
      throw new Error(friendlyYtDlpError(lastErrorLine(stderr) || stderr) || '无法解析音频直链')
    }
    const entry: Entry = { url, referer, at: Date.now() }
    cache.set(videoId, entry)
    console.log(`[stream] 解析直链 ${videoId} +${Date.now() - began}ms`)
    return entry
  })()

  inflight.set(videoId, job)
  try {
    return await job
  } finally {
    inflight.delete(videoId)
  }
}

interface StreamTarget {
  id: string
  /** 该曲目来自哪个源，用来挑选 yt-dlp 的附加参数 */
  sourceId: string
  /** 曲目的原始页面地址，搜索结果尚未落库时靠它取直链 */
  page: string
  /** 解析方指定的来源头；抖音 CDN 就要求它，从直链域名推不出来 */
  referer: string
}

function targetOf(raw: string): StreamTarget | null {
  try {
    const url = new URL(raw)
    if (url.hostname !== 'audio') return null
    const id = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!VIDEO_ID.test(id)) return null
    return {
      id,
      sourceId: url.searchParams.get('src') ?? '',
      page: url.searchParams.get('page') ?? '',
      referer: url.searchParams.get('ref') ?? ''
    }
  } catch {
    return null
  }
}

/** 注册 stream:// 协议，形如 stream://audio/<视频ID>?src=<源ID>&page=<页面地址> */
export function registerStreamProtocol(
  store: CacheStore,
  sourceArgs?: (sourceId?: string) => Promise<string[]>
): void {
  protocol.handle('stream', (request) => handleStreamRequest(request, store, sourceArgs))
}

/**
 * 处理一次 stream:// 请求。
 * 手机端走 HTTP 转发音频流时也调它（见 api-server.ts），逻辑只此一份。
 */
export async function handleStreamRequest(
  request: Request,
  store: CacheStore,
  sourceArgs?: (sourceId?: string) => Promise<string[]>
): Promise<Response> {
  const target = targetOf(request.url)
  if (!target) return new Response('Bad Request', { status: 400 })

    let entry: Entry
    try {
      entry = await resolveStreamUrl(
        target.id,
        store,
        { id: target.sourceId, page: target.page, referer: target.referer },
        sourceArgs
      )
    } catch (err) {
      return new Response(err instanceof Error ? err.message : '无法解析音频直链', { status: 502 })
    }

    const headers: Record<string, string> = {
      'User-Agent': UPSTREAM_UA,
      // 来源头跟着源走，B 站 CDN 认自己的，YouTube 认自己的
      Referer: entry.referer,
      Origin: entry.referer.replace(/\/$/, '')
    }
    const range = request.headers.get('Range')
    if (range) headers.Range = range

    // 记下每次取流的范围与耗时，卡顿时可以据此判断是上游慢还是分段太碎
    const began = Date.now()
    const rangeLabel = request.headers.get('Range') ?? 'full'

    let upstream: Response
    try {
      // 走 defaultSession，代理配置与下载侧保持一致
      upstream = await session.defaultSession.fetch(entry.url, { headers })
    } catch (err) {
      console.warn(`[stream] ${target.id} ${rangeLabel} 上游异常 +${Date.now() - began}ms`)
      return new Response(err instanceof Error ? err.message : '上游不可达', { status: 502 })
    }

    console.log(
      `[stream] ${target.id} ${rangeLabel} → ${upstream.status} ${upstream.headers.get('content-length') ?? '?'}B +${Date.now() - began}ms`
    )

    if (upstream.status >= 400) {
      // 直链可能已过期，丢掉缓存让下次重新解析
      cache.delete(target.id)
      return new Response(`上游返回 ${upstream.status}`, { status: upstream.status })
    }
    if (!upstream.body) return new Response('上游无数据', { status: 502 })

    const out: Record<string, string> = {}
    for (const key of FORWARD_HEADERS) {
      const value = upstream.headers.get(key)
      if (value) out[key] = value
    }
    return new Response(upstream.body, { status: upstream.status, headers: out })
}
