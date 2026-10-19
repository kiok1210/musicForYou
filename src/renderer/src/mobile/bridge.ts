/**
 * 手机端适配层。
 *
 * 桌面端的能力都在 Electron 主进程里，由 preload 暴露成 `window.vinyl`；
 * 手机上「干活的那一半」在电脑上（见 main/api-server.ts）。这里用**同一套方法名**，
 * 底下换成 HTTP 调用 + SSE 事件流，于是渲染层代码一行都不用改：
 * `window.vinyl.library.list()` 在两边写法完全一致。
 *
 * 通道名也与桌面端 IPC 完全一致（`library:list`、`yt:search`…），
 * 服务端直接复用同一份实现，不存在「手机版缺功能」这种事。
 */

/** 服务器地址存在本地：下次打开就不必再填 */
const SERVER_KEY = 'vinylbox.server'

/**
 * 事件方法名 → 服务端推送通道。
 * 事件只有这些，直接列出来比猜命名规则可靠（`onChanged` 与 `library:changed`
 * 之间并没有统一规律）。
 */
const EVENT_CHANNELS: Record<string, string> = {
  'tools:onInstallProgress': 'tools:install-progress',
  'downloads:onUpdate': 'dl:update',
  'downloads:onList': 'dl:list',
  'downloads:onDone': 'dl:done',
  'library:onChanged': 'library:changed',
  'auth:onLoginChanged': 'auth:login-changed',
  'lyrics:onReady': 'lyrics:ready',
  'lyrics:onTranscribeProgress': 'lyrics:transcribe-progress',
  'window:onMaximizedChange': 'window:maximized'
}

/**
 * 手机上不存在的桌面能力：给个不痛不痒的结果，别让界面卡在等待里。
 * 窗口控制、打开文件夹这些在手机上没有对应物。
 */
const LOCAL_ONLY: Record<string, unknown> = {
  'window:close': true,
  'window:minimize': true,
  'window:setMini': true,
  'window:toggleMaximize': false,
  'window:isMaximized': false,
  'cache:openDir': '',
  'library:reveal': true
}

export function serverBase(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setServerBase(url: string): void {
  const clean = url.trim().replace(/\/+$/, '')
  try {
    localStorage.setItem(SERVER_KEY, clean)
  } catch {
    /* 隐私模式下写不进去也无妨，本次会话照样能用 */
  }
}

/** 当前是不是「没有 Electron 主进程」的环境（即手机 App） */
export function isMobileRuntime(): boolean {
  return typeof window !== 'undefined' && !('vinyl' in window)
}

/** 把用户填的地址补成完整 URL：允许只写 192.168.1.5:8787 */
export function normalizeServer(input: string): string {
  const text = input.trim().replace(/\/+$/, '')
  if (!text) return ''
  return /^https?:\/\//i.test(text) ? text : `http://${text}`
}

type Listener = (payload: unknown) => void

/** 打开事件流并按通道分发；断线重连由 EventSource 自己负责 */
function openEventStream(base: string, listeners: Map<string, Set<Listener>>): EventSource {
  const stream = new EventSource(`${base}/events`)
  stream.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data) as { channel: string; payload: unknown }
      const set = listeners.get(frame.channel)
      if (!set) return
      for (const listener of set) listener(frame.payload)
    } catch {
      /* 心跳或半截数据，忽略 */
    }
  }
  return stream
}

async function callChannel(base: string, channel: string, args: unknown[]): Promise<unknown> {
  if (channel in LOCAL_ONLY) return { ok: true, data: LOCAL_ONLY[channel] }
  // 打开外部链接在手机上是浏览器的事，不走服务端
  if (channel === 'app:openExternal') {
    window.open(String(args[0] ?? ''), '_blank')
    return { ok: true, data: true }
  }
  try {
    const res = await fetch(`${base}/api/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    })
    if (!res.ok) {
      return { ok: false, code: `HTTP_${res.status}`, message: `服务返回 ${res.status}` }
    }
    return await res.json()
  } catch {
    return {
      ok: false,
      code: 'OFFLINE',
      message: '连不上电脑上的 VinylBox：确认手机与电脑在同一个 Wi-Fi，且电脑上应用开着'
    }
  }
}

/**
 * 造一个 `window.vinyl` 的替身：两层 Proxy 把所有方法自动映射到服务端通道，
 * 于是新增通道不必在这里登记（与服务端那套「通道表」是同一个思路）。
 */
export function createMobileApi(base: string): unknown {
  const listeners = new Map<string, Set<Listener>>()
  const stream = openEventStream(base, listeners)
  window.addEventListener('pagehide', () => stream.close())

  return new Proxy(
    {},
    {
      get: (_target, group: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => {
              const key = `${String(group)}:${String(method)}`
              const eventChannel = EVENT_CHANNELS[key]
              if (eventChannel) {
                return (cb: Listener): (() => void) => {
                  const set = listeners.get(eventChannel) ?? new Set<Listener>()
                  set.add(cb)
                  listeners.set(eventChannel, set)
                  return () => set.delete(cb)
                }
              }
              return (...args: unknown[]): Promise<unknown> => callChannel(base, key, args)
            }
          }
        )
    }
  )
}
