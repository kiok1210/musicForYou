import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { DownloadTask, Track, TrackMeta } from '@shared/types'
import { TaskQueue } from '@shared/portable/concurrency'
import {
  friendlyYtDlpError,
  humanBytes,
  parseDownloadProgress,
  stageOfLine
} from '@shared/portable/ytdlp-output'
import { getFfmpegPath, getYtDlpRunner } from './tools'
import { spawnYtDlp } from './ytdlp'
import type { CacheStore } from './library'

const MAX_CONCURRENT = 2

/**
 * 站点一时的风控判定。
 * YouTube 的「Sign in to confirm you're not a bot」就是这类：实测同一个视频、
 * 同一条网络、同样的参数，隔几十分钟结果就会翻过来——它不是持续状态，而是逐请求判定。
 * 这种拒绝藏在 HTTP 200 里，yt-dlp 自己的 --retries 只管网络层，够不着它，只能自己重试。
 */
const TRANSIENT_REFUSAL = /(sign in to confirm|too many requests|\b429\b)/i
/** 瞬时失败自动重试的次数上限；间隔逐次拉长，给站点一点冷却时间 */
const TRANSIENT_RETRIES = 2

interface Job {
  task: DownloadTask
  child: ChildProcess | null
  canceled: boolean
  /** 瞬时风控已重试的次数 */
  transientRetries?: number
}

export class DownloadManager extends EventEmitter {
  private readonly jobs = new Map<string, Job>()
  /** 并发上限由可移植的 TaskQueue 负责 */
  private readonly pool = new TaskQueue(MAX_CONCURRENT)

  constructor(
    private readonly store: CacheStore,
    /** 按源附加的 yt-dlp 参数（B站要带访客指纹与绑定 UA），由主进程注入 */
    private readonly sourceArgs?: (sourceId?: string) => Promise<string[]>
  ) {
    super()
  }

  list(): DownloadTask[] {
    return [...this.jobs.values()].map((j) => ({ ...j.task }))
  }

  isBusy(id: string): boolean {
    const job = this.jobs.get(id)
    return Boolean(job && (job.task.status === 'downloading' || job.task.status === 'queued'))
  }

  private update(job: Job, patch: Partial<DownloadTask>): void {
    job.task = { ...job.task, ...patch }
    this.emit('update', { ...job.task })
  }

  private fail(job: Job, stage: string, error: string): void {
    this.update(job, { status: 'error', stage, error, speed: '', eta: '' })
  }

  enqueue(meta: TrackMeta): DownloadTask {
    const existing = this.jobs.get(meta.id)
    if (existing && existing.task.status !== 'error' && existing.task.status !== 'canceled') {
      return { ...existing.task }
    }
    const task: DownloadTask = {
      id: meta.id,
      meta,
      status: 'queued',
      progress: 0,
      speed: '',
      eta: '',
      stage: '排队中'
    }
    const job: Job = { task, child: null, canceled: false }
    this.jobs.set(meta.id, job)
    this.emit('update', { ...task })
    void this.pool.push(() => this.run(job))
    return { ...task }
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.canceled = true
    job.child?.kill()
    // 仍在排队时，run 会在启动前直接退出
    this.update(job, { status: 'canceled', stage: '已取消', speed: '', eta: '' })
  }

  clearFinished(): void {
    for (const [id, job] of [...this.jobs.entries()]) {
      if (['done', 'error', 'canceled'].includes(job.task.status)) this.jobs.delete(id)
    }
    this.emit('list', this.list())
  }

  private buildArgs(
    meta: TrackMeta,
    format: string,
    ffmpeg: string | null,
    extras: string[]
  ): string[] {
    const args = [
      meta.url,
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--no-mtime',
      // 中断后重新下载同一个链接时接着上次的 .part 续传。
      // 有声书动辄几十小时，不加这个每次都得从头再下一次。
      '--continue',
      '--write-thumbnail',
      // 顺带保存视频元数据，用于自动打标签（读取后即删除）
      '--write-info-json',
      // 下载阶段要宽容一些，避免网络抖动直接判失败
      '--socket-timeout',
      '20',
      '--retries',
      '5',
      '--fragment-retries',
      '5',
      // 给流式播放留出余量：下载跑满时会把代理带宽吃干，边听边缓存就会断续
      '--limit-rate',
      '1M',
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',
      // 文件名直接用曲目 id：直链 URL 里推不出 id（抖音的 CDN 地址就没有），
      // 用 %(id)s 会下出一批对不上号的文件
      '-o',
      path.join(this.store.mediaDir, `${meta.id}.%(ext)s`),
      ...extras
    ]
    if (format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
      if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
    }
    // 解析方指定了来源头就带上：抖音的 CDN 只认 douyin.com，直链域名推不出来
    if (meta.referer) args.push('--referer', meta.referer)
    return args
  }

  private async run(job: Job): Promise<void> {
    // 排队期间已被取消，直接跳过
    if (job.canceled) return

    const { meta } = job.task
    const format = this.store.getSettings().audioFormat
    const runner = await getYtDlpRunner()
    if (!runner) {
      this.fail(job, '缺少下载核心', '未找到 yt-dlp，请先初始化组件')
      return
    }
    const ffmpeg = await getFfmpegPath()
    if (format === 'mp3' && !ffmpeg) {
      this.fail(job, '缺少 ffmpeg', '转码为 mp3 需要 ffmpeg，可改用 m4a 格式')
      return
    }

    // 曲目自带来源时用该源的参数：回看 B站的批次下载，不因当前源切成了 YouTube 而失败
    const extras = [
      ...(await this.store.requestArgs()),
      ...((await this.sourceArgs?.(meta.sourceId)) ?? [])
    ]
    this.update(job, { status: 'downloading', stage: '解析音频流…', progress: 0, error: undefined })

    let stderrTail = ''
    const handleLine = (line: string): void => {
      const progress = parseDownloadProgress(line)
      if (progress.percent !== undefined) {
        this.update(job, {
          status: 'downloading',
          stage: '下载中',
          progress: Math.min(progress.percent, 1),
          speed: progress.speed ?? job.task.speed,
          eta: progress.eta ?? job.task.eta,
          error: undefined
        })
        return
      }
      const stage = stageOfLine(line)
      if (stage === 'transcode' || stage === 'merge') {
        this.update(job, { status: 'processing', stage: '转码中…', progress: 1, speed: '', eta: '' })
      } else if (stage === 'metadata') {
        this.update(job, { status: 'processing', stage: '写入元数据…' })
      } else if (line.startsWith('ERROR:')) {
        stderrTail = line
      }
    }

    let result: { stdout: string; stderr: string; code: number }
    try {
      result = await spawnYtDlp(this.buildArgs(meta, format, ffmpeg, extras), {
        onLine: handleLine,
        onSpawn: (child) => {
          job.child = child
        }
      })
    } catch (err) {
      this.fail(job, '启动失败', err instanceof Error ? err.message : String(err))
      return
    } finally {
      job.child = null
    }

    if (job.canceled) return

    if (result.code !== 0) {
      const fromStderr = result.stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('ERROR:'))
        .pop()
      const raw = fromStderr ?? stderrTail ?? 'yt-dlp 异常退出'

      // 瞬时风控先不报失败：隔几秒自己再来一次，很多时候就过了，
      // 免得用户看到红叉去手动点重试（而他一点就好了，反倒显得应用不稳）
      const attempt = job.transientRetries ?? 0
      if (attempt < TRANSIENT_RETRIES && TRANSIENT_REFUSAL.test(raw)) {
        job.transientRetries = attempt + 1
        const wait = (attempt + 1) * 5
        this.update(job, {
          stage: `站点要求验证，${wait} 秒后自动重试…`,
          error: undefined,
          speed: '',
          eta: ''
        })
        await new Promise((resolve) => setTimeout(resolve, wait * 1000))
        if (job.canceled) return
        return this.run(job)
      }

      this.fail(job, '下载失败', friendlyYtDlpError(raw))
      return
    }

    await this.finalize(job)
  }

  /** 读取 yt-dlp 落下的元数据，读完即清理 */
  private async readVideoInfo(id: string): Promise<{
    title: string | null
    genre: string | null
    categories: string[]
    language: string | null
  } | null> {
    const file = path.join(this.store.mediaDir, `${id}.info.json`)
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8')) as {
        title?: unknown
        genre?: unknown
        categories?: unknown
        language?: unknown
      }
      return {
        // yt-dlp 的 flat 搜索给的是占位标题（B站就是「B站视频 av 号」），
        // 下载时会把真标题写进 info.json，这里把它读出来纠正
        title: typeof data.title === 'string' ? data.title : null,
        genre: typeof data.genre === 'string' ? data.genre : null,
        categories: Array.isArray(data.categories) ? (data.categories as string[]) : [],
        language: typeof data.language === 'string' ? data.language : null
      }
    } catch {
      return null
    } finally {
      await fsp.rm(file, { force: true }).catch(() => undefined)
    }
  }

  private async finalize(job: Job): Promise<void> {
    const { meta } = job.task
    this.update(job, { status: 'processing', stage: '整理缓存文件…', progress: 1 })
    const artifact = await this.store.inspectArtifacts(meta.id)
    if (!artifact) {
      this.fail(job, '文件缺失', '下载已完成但未找到音频文件')
      return
    }
    const info = await this.readVideoInfo(meta.id)
    const track: Track = {
      ...meta,
      // 搜索阶段的占位标题在这里纠正：缓存完成，曲库里的名字就是真的
      title: info?.title || meta.title,
      fileName: artifact.fileName,
      coverName: artifact.coverName,
      size: artifact.size,
      format: path.extname(artifact.fileName).replace('.', ''),
      downloadedAt: Date.now(),
      favorite: false,
      playCount: 0,
      lastPlayedAt: null,
      tags: []
    }
    await this.store.addTrack(track)
    // 自动落标签
    await this.store.setAutoTags(meta.id, {
      genre: info?.genre ?? null,
      categories: info?.categories,
      language: info?.language ?? null
    })
    this.update(job, { status: 'done', stage: `已缓存 · ${humanBytes(artifact.size)}`, progress: 1 })
    this.emit('done', track)
  }
}
