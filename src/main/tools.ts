import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import { app, net, session } from 'electron'
import type { InstallProgress, ProbeResult, ProxyMode } from '@shared/types'

export type { InstallProgress, ProbeResult, ProxyMode }

export const IS_WIN = process.platform === 'win32'
export const YTDLP_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'
export const FFMPEG_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'

/** 国内 pypi 镜像，GitHub 不可达时的可靠来源 */
const PYPI_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const PYPI_FALLBACK = 'https://pypi.org/simple'

export class ToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ProcessResult {
  stdout: string
  stderr: string
  code: number
}

interface SpawnOptions {
  env?: Record<string, string>
  onLine?: (line: string) => void
  timeoutMs?: number
}

export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...options.env }
      })
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: -1 })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let buffer = ''
    const flush = (text: string): void => {
      buffer += text
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim()) options.onLine?.(line)
        index = buffer.indexOf('\n')
      }
    }

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill()
          finish(-1)
        }, options.timeoutMs)
      : null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      flush(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      flush(chunk)
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** 静默探测：命令成功执行时返回 stdout，否则返回 null */
async function probe(
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<string | null> {
  const result = await spawnProcess(command, args, { env, timeoutMs: 15000 })
  if (result.code !== 0) return null
  const out = result.stdout.trim()
  return out.length ? out : null
}

export interface PythonCandidate {
  command: string
  prefix: string[]
  label: string
}

function pythonCandidates(): PythonCandidate[] {
  if (process.env.PYTHON_PATH) {
    return [{ command: process.env.PYTHON_PATH, prefix: [], label: 'PYTHON_PATH' }]
  }
  if (IS_WIN) {
    return [
      { command: 'python', prefix: [], label: 'python' },
      { command: 'py', prefix: ['-3'], label: 'py -3' },
      { command: 'python3', prefix: [], label: 'python3' }
    ]
  }
  return [
    { command: 'python3', prefix: [], label: 'python3' },
    { command: 'python', prefix: [], label: 'python' }
  ]
}

/** 应用私有的 Python 依赖目录，避免污染用户全局环境 */
export function pythonLibsDir(): string {
  return path.join(app.getPath('userData'), 'pylibs')
}

export function binDir(): string {
  return path.join(app.getPath('userData'), 'bin')
}

export interface YtDlpRunner {
  command: string
  prefix: string[]
  env: Record<string, string>
  label: string
}

let runnerPromise: Promise<YtDlpRunner | null> | null = null
let ffmpegPromise: Promise<string | null> | null = null

export function resetToolCache(): void {
  runnerPromise = null
  ffmpegPromise = null
}

let systemProxyCache: string | null | undefined

/**
 * 解析 PAC / 系统代理串。
 * 形如 "SOCKS5 127.0.0.1:1081;PROXY 127.0.0.1:1082"。
 * 优先取 HTTP 代理——yt-dlp 用它不需要额外依赖，SOCKS 需要 PySocks。
 */
function pickProxy(resolved: string): string | null {
  const entries = resolved
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) {
    const [scheme, address] = entry.split(/\s+/)
    if (address && /^(PROXY|HTTPS)$/i.test(scheme)) return `http://${address}`
  }
  for (const entry of entries) {
    const [scheme, address] = entry.split(/\s+/)
    if (address && /^SOCKS/i.test(scheme)) return `socks5://${address}`
  }
  return null
}

/** 读取系统级代理（Clash / v2ray 等开启系统代理或 PAC 时可直接复用） */
export async function detectSystemProxy(): Promise<string | null> {
  if (systemProxyCache !== undefined) return systemProxyCache
  try {
    const resolved = await session.defaultSession.resolveProxy('https://www.youtube.com')
    systemProxyCache = pickProxy(resolved)
  } catch {
    systemProxyCache = null
  }
  return systemProxyCache
}

export function resetSystemProxyCache(): void {
  systemProxyCache = undefined
}

/**
 * 按模式解析出 yt-dlp 的代理参数。
 * 覆盖：直连 / 系统代理 / PAC / 手动 HTTP / 手动 SOCKS。
 */
export async function resolveProxyArgs(
  mode: ProxyMode,
  manualAddress: string
): Promise<{ args: string[]; proxy: string | null }> {
  if (mode === 'off') return { args: [], proxy: null }
  if (mode === 'manual') {
    const address = (manualAddress ?? '').trim()
    return address ? { args: ['--proxy', address], proxy: address } : { args: [], proxy: null }
  }
  const auto = await detectSystemProxy()
  return auto ? { args: ['--proxy', auto], proxy: auto } : { args: [], proxy: null }
}

/** 启动时快速探测 YouTube 是否可达（5 秒内必须给出结论） */
export async function probeYouTube(
  mode: ProxyMode = 'auto',
  manualAddress = ''
): Promise<ProbeResult> {
  const { proxy } = await resolveProxyArgs(mode, manualAddress)
  const reachable = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = net.request({ url: 'https://www.youtube.com/generate_204', method: 'HEAD' })
    const timer = setTimeout(() => {
      done(false)
      try {
        request.abort()
      } catch {
        /* ignore */
      }
    }, 5000)
    request.on('response', () => {
      clearTimeout(timer)
      done(true)
    })
    request.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
    request.end()
  })
  return { reachable, proxy }
}

async function detectYtDlp(): Promise<YtDlpRunner | null> {
  const staticCandidates = [
    process.env.YTDLP_PATH,
    path.join(binDir(), YTDLP_NAME),
    path.join(process.resourcesPath ?? '', 'bin', YTDLP_NAME),
    path.join(app.getAppPath(), 'resources', 'bin', YTDLP_NAME)
  ].filter((v): v is string => Boolean(v))
  for (const candidate of staticCandidates) {
    if (!existsSync(candidate)) continue
    // 探一次版本：设置里显示「yt-dlp 2026.08.19」比只显示文件名有用得多，
    // 内置版的版本号正是判断「要不要更新」的唯一依据
    const version = await probe(candidate, ['--version'])
    return {
      command: candidate,
      prefix: [],
      env: {},
      label: version ? `yt-dlp ${version}` : path.basename(candidate)
    }
  }

  const env = { PYTHONPATH: pythonLibsDir() }
  for (const py of pythonCandidates()) {
    const version = await probe(py.command, [...py.prefix, '-m', 'yt_dlp', '--version'], env)
    if (version) {
      return {
        command: py.command,
        prefix: [...py.prefix, '-m', 'yt_dlp'],
        env,
        label: `yt-dlp ${version}`
      }
    }
  }

  const pathVersion = await probe(YTDLP_NAME, ['--version'])
  if (pathVersion) {
    return { command: YTDLP_NAME, prefix: [], env: {}, label: `yt-dlp ${pathVersion}` }
  }
  return null
}

export function getYtDlpRunner(force = false): Promise<YtDlpRunner | null> {
  if (force || !runnerPromise) runnerPromise = detectYtDlp()
  return runnerPromise
}

async function detectFfmpeg(): Promise<string | null> {
  const staticCandidates = [
    process.env.FFMPEG_PATH,
    // 用户更新过的版本优先于内置版本（与 yt-dlp 的查找顺序保持一致）
    path.join(binDir(), FFMPEG_NAME),
    // 安装包内置的那份：装上即可用，不必再联网下载
    path.join(process.resourcesPath ?? '', 'bin', FFMPEG_NAME),
    // 开发环境跑在源码目录里，此时没有 resourcesPath
    path.join(app.getAppPath(), 'resources', 'bin', FFMPEG_NAME)
  ].filter((v): v is string => Boolean(v))
  for (const candidate of staticCandidates) {
    if (existsSync(candidate)) return candidate
  }

  const env = { PYTHONPATH: pythonLibsDir() }
  for (const py of pythonCandidates()) {
    const resolved = await probe(
      py.command,
      [
        ...py.prefix,
        '-c',
        'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'
      ],
      env
    )
    if (resolved && existsSync(resolved)) return resolved
  }

  const pathVersion = await probe(FFMPEG_NAME, ['-version'])
  if (pathVersion) return FFMPEG_NAME
  return null
}

export function getFfmpegPath(force = false): Promise<string | null> {
  if (force || !ffmpegPromise) ffmpegPromise = detectFfmpeg()
  return ffmpegPromise
}

/** yt-dlp 官方发布地址；GitHub 会 302 到 CDN */
const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

/**
 * 下载通道，按顺序尝试。
 *
 * 官方地址在国内常被 RST，而不少代理节点又刚好不放行 github.com
 * （实测：同一节点 YouTube 通、GitHub 断），所以必须备一条不走代理的路。
 * 前缀式加速镜像就是干这个用的：直接把完整 URL 拼在域名后面。
 */
const YTDLP_MIRRORS = [
  // 镜像排在最前：国内直连通常几秒就能开始传，而官方地址要先等代理试到超时
  'https://ghproxy.net/',
  // 镜像域名存活情况常变，多备一个；失效也只是多花十几秒
  'https://ghfast.top/',
  // 官方地址兜底：走代理，代理放行 GitHub 的网络下这是最正式的来源
  ''
]

let assetSessionRef: Electron.Session | null = null

/**
 * 下载组件专用的会话分区。
 *
 * 代理必须显式指定：auto 模式下 Chromium 会读 PAC，而 PAC 常把 GitHub 分流成直连，
 * 直连又拿不到文件——这和扫码登录、站点会话踩的是同一个坑。
 */
async function assetSession(proxy: string | null): Promise<Electron.Session> {
  if (!assetSessionRef) assetSessionRef = session.fromPartition('vinylbox-tools')
  await assetSessionRef.setProxy(
    proxy ? { proxyRules: proxy, proxyBypassRules: '<local>' } : { mode: 'direct' }
  )
  return assetSessionRef
}

/** 网络类失败说人话：net::ERR_xxx 对用户没有意义 */
function describeDownloadError(raw: unknown, proxy: string | null): Error {
  const text = raw instanceof Error ? raw.message : String(raw)
  if (/ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_PROXY|timeout|超时/i.test(text)) {
    return new ToolError(
      'YTDLP_DOWNLOAD_NETWORK',
      proxy
        ? `连不上 GitHub（走代理 ${proxy}）。可能是代理节点拦了这个域名，换个节点，或在设置里改用手动代理再试。`
        : '连不上 GitHub，而且没检测到代理。请先打开代理软件，或在设置 → 代理里填好地址再重试。'
    )
  }
  if (/ENOSPC/i.test(text)) {
    return new ToolError('YTDLP_DISK_FULL', '磁盘空间不足，无法保存下载的文件。')
  }
  return raw instanceof Error ? raw : new Error(text)
}

/**
 * 下一个文件到内存再落盘：体积十几 MB，没必要为它引入流式管道的复杂度。
 *
 * 用 Session.fetch 而不是 net.request：GitHub 的下载地址会 302 到 CDN，
 * net.request 在跨站重定向之后容易把分区代理丢掉（表现为 ERR_CONNECTION_ABORTED），
 * 而 fetch 原生跟随重定向，代理也始终走这个分区。
 */
async function download(
  url: string,
  jar: Electron.Session,
  onRatio: (ratio: number) => void
): Promise<Buffer> {
  const controller = new AbortController()
  let lastDataAt = Date.now()
  /** 45 秒总超时 + 12 秒无数据看门狗：路不通时快点放弃，别让用户干等 */
  const timer = setTimeout(() => controller.abort(), 45_000)
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt >= 12_000) controller.abort()
  }, 2000)

  try {
    const response = await jar.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'VinylBox' }
    })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    if (!response.body) throw new Error('下载失败：响应为空')

    const total = Number(response.headers.get('content-length') ?? 0)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      received += value.length
      lastDataAt = Date.now()
      if (total > 0) onRatio(Math.min(received / total, 0.99))
    }
    return Buffer.concat(chunks)
  } finally {
    clearInterval(watchdog)
    clearTimeout(timer)
  }
}

/**
 * 直连下载（不走代理），给国内加速镜像用。
 *
 * 为什么不用 Electron 的 fetch：它的 AbortController 中止并不即时，
 * 实测每次都要等满总超时才返回，三条通道串起来就是两分多钟白等。
 * 而 https 的 setTimeout 是**空闲超时**——有数据就自动重置，一旦卡住立刻断，
 * 正是这里需要的行为。
 */
function downloadDirect(url: string, onRatio: (ratio: number) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { headers: { 'User-Agent': 'VinylBox' } }, (response) => {
      const status = response.statusCode ?? 0
      // 镜像可能再跳一次，手动跟一层就够了
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        resolve(downloadDirect(new URL(response.headers.location, url).toString(), onRatio))
        return
      }
      if (status >= 400) {
        response.resume()
        reject(new Error(`下载失败：HTTP ${status}`))
        return
      }
      const total = Number(response.headers['content-length'] ?? 0)
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        received += chunk.length
        if (total > 0) onRatio(Math.min(received / total, 0.99))
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    // 空闲 15 秒没有任何新数据就放弃
    request.setTimeout(15_000, () => request.destroy(new Error('下载停滞超过 15 秒')))
    request.on('error', reject)
  })
}

/**
 * 更新 yt-dlp 到官方最新版。
 *
 * 装到 userData/bin 而不是覆盖安装包里的那份：那个目录在检测顺序里排在
 * 内置版本之前，于是更新立刻生效，而安装包本身保持只读、升级应用也不会被覆盖掉。
 *
 * 下载完先探一次版本再落定——拿到个 HTML 或半截文件就替换，会把能用的环境弄坏。
 */
export async function updateYtDlp(
  settings: { proxyMode: ProxyMode; proxy: string },
  onProgress: (progress: InstallProgress) => void
): Promise<string> {
  const { proxy } = await resolveProxyArgs(settings.proxyMode, settings.proxy)

  /**
   * 依次尝试：官方（走代理）→ 加速镜像（走直连）。
   * 各用各的通道是有意的——镜像本来就是给直连准备的，套上代理反而更慢。
   */
  let body: Buffer | null = null
  let lastError: unknown = null
  for (const [index, prefix] of YTDLP_MIRRORS.entries()) {
    const label = prefix ? `镜像 ${new URL(prefix).host}` : '官方地址'
    const url = `${prefix}${YTDLP_RELEASE}${YTDLP_NAME}`
    const progress = (ratio: number): void =>
      onProgress({ step: `正在下载 yt-dlp（${label}）…`, ratio: ratio * 0.9 })
    try {
      // 官方地址必须走代理；镜像本身就是给直连准备的，套上代理反而更慢
      body =
        index === 0
          ? await download(url, await assetSession(proxy), progress)
          : await downloadDirect(url, progress)
      break
    } catch (err) {
      lastError = err
      onProgress({ step: `${label} 不可用，换下一条通道…`, ratio: 0 })
    }
  }
  if (!body) throw describeDownloadError(lastError, proxy)

  const target = path.join(binDir(), YTDLP_NAME)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  /**
   * 先写临时名再改名：中途失败不会留下半截的 yt-dlp.exe 让应用误以为可用。
   * 但临时名必须**保留 .exe 后缀**——Windows 执行不了没有该后缀的文件，
   * 下面校验版本的 probe 会因此一直挂住（踩过）。
   */
  const temp = path.join(binDir(), `.tmp-${YTDLP_NAME}`)
  await fsp.writeFile(temp, body)

  onProgress({ step: '正在校验…', ratio: 0.95 })
  const version = await probe(temp, ['--version'])
  if (!version) {
    await fsp.rm(temp, { force: true })
    throw new ToolError(
      'YTDLP_BAD_BINARY',
      '下载到的文件无法运行（可能被代理或网络拦截），已丢弃，原来的版本不受影响。'
    )
  }

  await fsp.rename(temp, target)
  resetToolCache()
  onProgress({ step: `已更新到 ${version}`, ratio: 1 })
  return version
}

export async function pickPython(): Promise<PythonCandidate | null> {
  for (const py of pythonCandidates()) {
    const version = await probe(py.command, [...py.prefix, '--version'])
    if (version && /^Python\s+3\./i.test(version)) return py
  }
  return null
}

/** 把依赖装进应用私有目录，装不下再回退官方源 */
export async function pipInstallPackages(
  packages: string[],
  onLine: (line: string) => void
): Promise<ProcessResult> {
  const python = await pickPython()
  if (!python) {
    throw new ToolError(
      'PYTHON_MISSING',
      '未检测到 Python 3，无法安装组件。请安装 Python 3.9+ 后重试。'
    )
  }
  await fsp.mkdir(pythonLibsDir(), { recursive: true })
  const run = (index: string): Promise<ProcessResult> =>
    spawnProcess(
      python.command,
      [
        ...python.prefix,
        '-m',
        'pip',
        'install',
        '--upgrade',
        '--target',
        pythonLibsDir(),
        '--no-warn-script-location',
        '--disable-pip-version-check',
        ...packages,
        '-i',
        index
      ],
      { onLine, timeoutMs: 20 * 60 * 1000 }
    )

  let result = await run(PYPI_INDEX)
  if (result.code !== 0) result = await run(PYPI_FALLBACK)
  return result
}

/** 安装下载核心（yt-dlp + ffmpeg）。全部落在应用私有目录，装完即可离线复用 */
export async function installToolchain(
  onProgress?: (progress: InstallProgress) => void
): Promise<void> {
  const report = (step: string, ratio: number): void => onProgress?.({ step, ratio })
  report('正在连接组件源…', 0.05)

  const result = await pipInstallPackages(['yt-dlp', 'imageio-ffmpeg', 'pysocks'], (line) => {
    if (/^(Collecting|Downloading|Installing)/i.test(line.trim())) {
      report(line.trim().replace(/\s+/g, ' ').slice(0, 70), 0.5)
    }
  })
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    throw new ToolError('PIP_FAILED', `组件安装失败：${tail || '未知错误'}`)
  }

  report('正在校验组件…', 0.95)
  resetToolCache()
  const runner = await getYtDlpRunner(true)
  if (!runner) throw new ToolError('YTDLP_MISSING', '安装完成，但 yt-dlp 未能加载')
  const ffmpeg = await getFfmpegPath(true)
  if (!ffmpeg) throw new ToolError('FFMPEG_MISSING', '安装完成，但 ffmpeg 未能加载')
  report('组件已就绪', 1)
}
