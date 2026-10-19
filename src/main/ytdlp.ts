import { spawn, type ChildProcess } from 'node:child_process'
import type { TrackMeta } from '@shared/types'
import { friendlyYtDlpError, lastErrorLine } from '@shared/portable/ytdlp-output'
import { ToolError, getYtDlpRunner } from './tools'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

export interface RunOptions {
  onLine?: (line: string) => void
  onSpawn?: (child: ChildProcess) => void
  timeoutMs?: number
}

/**
 * 元数据请求的硬超时。
 *
 * 原来定 10 秒是按 YouTube 的响应速度来的。非 YouTube 源普遍更慢——
 * SoundCloud、NicoNico 走代理时常常要十几秒，10 秒会稳定超时，于是放宽到 25 秒。
 */
const SEARCH_TIMEOUT = 25_000
const RESOLVE_TIMEOUT = 25_000

/** socket 层 8 秒无响应即断，且不重试 */
const METADATA_ARGS = ['--socket-timeout', '8', '--retries', '0', '--extractor-retries', '0']

/** 按行切分子进程输出，避免一条日志被拆到两个 chunk */
function makeLineSplitter(emit: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim()) emit(line)
      index = buffer.indexOf('\n')
    }
  }
}

export async function spawnYtDlp(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const runner = await getYtDlpRunner()
  if (!runner) {
    throw new ToolError('YTDLP_MISSING', '未找到下载核心，请先在右上角初始化组件')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.prefix, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...runner.env }
    })
    options.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const splitOut = makeLineSplitter((line) => options.onLine?.(line))
    const splitErr = makeLineSplitter((line) => options.onLine?.(line))

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      splitOut(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      splitErr(chunk)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(new ToolError('YTDLP_SPAWN_FAILED', err.message))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1, timedOut })
    })
  })
}

interface RawEntry {
  id?: string
  title?: string
  duration?: number
  uploader?: string
  channel?: string
  artist?: string
  webpage_url?: string
  url?: string
  thumbnail?: string
  thumbnails?: { url?: string; width?: number; height?: number }[]
  entries?: RawEntry[]
}

function pickThumbnail(entry: RawEntry, id: string): string {
  if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
    const best = [...entry.thumbnails]
      .filter((t) => Boolean(t.url))
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
    if (best?.url) return best.url
  }
  if (typeof entry.thumbnail === 'string' && entry.thumbnail) return entry.thumbnail
  // 不再猜 YouTube 缩略图：换了源之后瞎猜只会拼出一个必然 404 的地址
  return ''
}

function toMeta(entry: RawEntry): TrackMeta {
  const id = String(entry.id ?? '')
  const url = String(entry.webpage_url ?? entry.url ?? '')
  // B站的搜索 extractor 在 flat 模式下只回链接不回标题，先用 av 号顶上，
  // 下载与试听都会重新解析出真标题
  const avMatch = url.match(/av(\d+)/i)
  const fallback = avMatch ? `B站视频 av${avMatch[1]}` : '未知曲目'
  return {
    id,
    title: String(entry.title ?? '').trim() || fallback,
    artist: String(entry.uploader ?? entry.channel ?? entry.artist ?? '未知艺术家'),
    duration: Number(entry.duration ?? 0) || 0,
    thumbnail: pickThumbnail(entry, id),
    // 同理，兜底不再拼 YouTube 链接——没有链接的条目会被调用方直接丢掉
    url
  }
}

/** 汇总子进程输出里最有用的一句错误，交给 portable 层翻译成中文 */
function describeFailure(stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`
  return lastErrorLine(combined) || stderr.trim().split('\n').pop() || combined
}

/**
 * 关键词搜索。
 *
 * 搜索键由源决定：YouTube 是 ytsearch，B站是 bilisearch，SoundCloud 是 scsearch。
 * yt-dlp 只给少数站点做了搜索接口，其余站点只能靠 resolveUrl 解析具体链接。
 */
export async function searchSource(
  query: string,
  limit: number,
  searchKey: string,
  extra: string[] = []
): Promise<TrackMeta[]> {
  const args = [
    `${searchKey || 'ytsearch'}${limit}:${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--skip-download',
    '--no-warnings',
    '--ignore-errors',
    ...METADATA_ARGS,
    ...extra
  ]
  const { stdout, stderr, timedOut } = await spawnYtDlp(args, { timeoutMs: SEARCH_TIMEOUT })
  if (timedOut) {
    throw new ToolError('YT_TIMEOUT', '25 秒内连不上这个源，请检查网络或在「设置」中配置代理。')
  }
  if (!stdout.trim()) {
    throw new ToolError('YT_SEARCH_FAILED', friendlyYtDlpError(describeFailure(stderr, stdout)))
  }
  let raw: RawEntry
  try {
    raw = JSON.parse(stdout) as RawEntry
  } catch {
    // 解析不出 JSON 说明拿到的是报错，把原文带上才有意义
    throw new ToolError(
      'YT_SEARCH_FAILED',
      friendlyYtDlpError(describeFailure(stderr, stdout)) || '返回数据解析失败，请重试'
    )
  }
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  // 没有可访问链接的条目直接丢掉，否则入队后必然下载失败
  const metas = entries.filter((e) => e && e.id && (e.webpage_url || e.url)).map(toMeta)
  if (!metas.length) {
    // --ignore-errors 会把单条失败吞掉继续跑，剩下的全是空 entries。
    // 这时真实原因（412 风控、连接被掐）都留在 stderr 里，
    // 直接说「没有结果」会把网络问题伪装成搜索问题，让人白白换关键词重试。
    if (/412|precondition/i.test(stderr)) {
      throw new ToolError(
        'YT_SEARCH_FAILED',
        '这个站点把搜索请求拦下了（HTTP 412 风控）。B站等站点需要登录态：导出 cookies.txt 后填到「设置 → Cookies 文件」，或换一个源试试。'
      )
    }
    if (stderr.includes('ERROR')) {
      throw new ToolError('YT_SEARCH_FAILED', friendlyYtDlpError(describeFailure(stderr, stdout)))
    }
    throw new ToolError('YT_SEARCH_EMPTY', '没有找到匹配的结果')
  }
  return metas
}

/** 解析单个视频 / 播放列表首条的音轨信息 */
export async function resolveUrl(url: string, extra: string[] = []): Promise<TrackMeta> {
  const args = [
    url,
    '--dump-single-json',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    ...METADATA_ARGS,
    ...extra
  ]
  const { stdout, stderr, timedOut } = await spawnYtDlp(args, { timeoutMs: RESOLVE_TIMEOUT })
  if (timedOut) {
    throw new ToolError('YT_TIMEOUT', '25 秒内连不上这个源，请检查网络或在「设置」中配置代理。')
  }
  if (!stdout.trim()) {
    throw new ToolError('YT_RESOLVE_FAILED', friendlyYtDlpError(describeFailure(stderr, stdout)))
  }
  try {
    return toMeta(JSON.parse(stdout) as RawEntry)
  } catch {
    throw new ToolError(
      'YT_RESOLVE_FAILED',
      friendlyYtDlpError(describeFailure(stderr, stdout)) || '返回数据解析失败，请重试'
    )
  }
}


