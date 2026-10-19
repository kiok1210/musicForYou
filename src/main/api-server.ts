/**
 * 手机端配套服务。
 *
 * App 跑在手机上，而真正干活的 yt-dlp 只能在电脑上跑，所以桌面端顺手开一个
 * 局域网 HTTP 服务：手机用同一套「通道名 + 参数」调用它，与桌面窗口走 IPC 一模一样。
 *
 * 通道实现来自 index.ts 的那张表，这里只负责搬运，不含任何业务逻辑——
 * 桌面端加功能，手机端自动就有。
 *
 * 对外四个入口：
 *   POST /api/<channel>      带参数调用通道，返回 IpcResult
 *   GET  /media|cover/<file> 直接给文件（支持 Range，播放器要拖进度条）
 *   GET  /stream/<id>        边听边缓存：转发音频流
 *   GET  /events             SSE 事件流（下载进度、曲库变化、登录状态）
 */
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

export interface ApiServerOptions {
  /** 所有通道实现，与 IPC 共用一份 */
  channels: Map<string, (event: unknown, ...args: any[]) => unknown>
  mediaDir: string
  /** 手机端订阅推送事件，返回退订函数 */
  subscribe: (target: (channel: string, payload: unknown) => void) => () => void
  /** stream:// 的处理器，直接复用桌面端那一份 */
  stream: (request: Request) => Promise<Response>
  version: string
  port?: number
  /** 真正监听成功后回传端口：端口被占用时会自动换一个 */
  onReady?: (port: number) => void
}

export interface ApiServerHandle {
  close: () => void
}

/** 请求体上限：调用参数都是小对象，给 4MB 足够，顺便挡掉恶意大包 */
const MAX_BODY = 4 * 1024 * 1024

const MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.lrc': 'text/plain; charset=utf-8'
}

function cors(res: ServerResponse): void {
  // App 从 capacitor:// 或本地文件加载，跨域是必然的
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

export function startApiServer(opts: ApiServerOptions): ApiServerHandle {
  const port = opts.port ?? 8787
  /** 正在推送事件的手机端连接 */
  const listeners = new Set<ServerResponse>()

  const unsubscribe = opts.subscribe((channel, payload) => {
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const client of listeners) client.write(frame)
  })

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) cors(res)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(err instanceof Error ? err.message : 'server error')
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const segments = url.pathname.split('/').filter(Boolean)

    // 探活：App 启动时用它确认连的是自家服务
    if (segments[0] === 'ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ app: 'VinylBox', version: opts.version, ok: true }))
      return
    }

    // 事件流：下载进度、曲库变化都靠它推
    if (segments[0] === 'events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      listeners.add(res)
      // 心跳：中间隔太久会被系统或路由器掐断
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(beat)
        listeners.delete(res)
      })
      return
    }

    // 音频流：手机边听边缓存走这里
    if (segments[0] === 'stream' && segments[1]) {
      const id = decodeURIComponent(segments.slice(1).join('/'))
      const range = req.headers.range
      // 查询串必须原样带上：里面有曲目的来源与页面地址（?src=&page=&ref=），
      // 少了它就会按默认的 YouTube 去解析——B站与抖音的流会直接取不到
      const upstream = await opts.stream(
        new Request(`stream://audio/${encodeURIComponent(id)}${url.search}`, {
          headers: range ? { Range: String(range) } : {}
        })
      )
      const headers: Record<string, string> = {}
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(key)
        if (value) headers[key] = value
      }
      res.writeHead(upstream.status, headers)
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
      res.end()
      return
    }

    // 媒体与封面：文件名已带扩展名，路径穿越靠 basename 挡住
    if ((segments[0] === 'media' || segments[0] === 'cover') && segments[1]) {
      const file = path.join(opts.mediaDir, path.basename(decodeURIComponent(segments[1])))
      await serveFile(req, res, file)
      return
    }

    // 通道调用：与桌面端 IPC 完全一致的入参
    if (segments[0] === 'api' && segments[1]) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'METHOD', message: '请用 POST' }))
        return
      }
      const handler = opts.channels.get(decodeURIComponent(segments[1]))
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'NO_CHANNEL', message: '没有这个接口' }))
        return
      }
      const body = await readBody(req)
      const args = Array.isArray(body?.args) ? body.args : []
      const result = await handler(undefined, ...args)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result ?? null))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: '没有这个路径' }))
  }

  let current = port
  server.on('listening', () => {
    const address = server.address()
    const actual = typeof address === 'object' && address ? address.port : current
    console.log(`[api] 配套服务已监听 :${actual}`)
    opts.onReady?.(actual)
  })
  /**
   * 监听失败必须在这里接住：
   * 'error' 是异步事件，外面那层 try/catch 拦不到，没人管就会把主进程一起带走
   * （端口被占用时必然发生，表现为「应用一启动就退出」）。
   */
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && current < port + 10) {
      current += 1
      console.warn(`[api] 端口 ${current - 1} 被占用，改用 ${current}`)
      server.listen(current, '0.0.0.0')
      return
    }
    console.error('[api] 配套服务出错:', err.message)
  })
  server.listen(current, '0.0.0.0')

  return {
    close: () => {
      for (const client of listeners) client.end()
      listeners.clear()
      unsubscribe()
      server.close()
    }
  }
}

function readBody(req: IncomingMessage): Promise<{ args?: unknown[] } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 给文件，支持 Range：音频拖进度条全靠它 */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('文件不存在')
    return
  }
  const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''))

  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': String(end - start + 1)
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { ...base, 'Content-Length': String(stat.size) })
  createReadStream(file).pipe(res)
}
