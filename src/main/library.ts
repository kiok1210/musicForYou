import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CacheStats,
  type CategoryInput,
  type DiscoverBatch,
  type DiscoverBatchInput,
  type MediaSource,
  type MusicCategory,
  type PlaybackSnapshot,
  type SourceInput,
  type TagSummary,
  type Track,
  type TrackTag
} from '@shared/types'
import { resolveProxyArgs } from './tools'
import { deriveAutoTags, type AutoTagInput } from './tagger'
import {
  CUSTOM_ACCENTS,
  CUSTOM_ID_PREFIX,
  allCategories,
  categoryById,
  findSubCategory,
  inferCategory,
  syncCustomCategories
} from './catalog'
import { allSources, syncCustomSources } from './sources'

/** 发现历史最多留多少批：再老的基本不会回头找，留着只是占空间 */
const DISCOVER_HISTORY_LIMIT = 20

const AUDIO_EXT = new Set(['.m4a', '.mp3', '.webm', '.opus', '.ogg', '.mp4', '.aac', '.wav', '.flac'])
const COVER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/** 自建分类的数量上限，避免分类墙被塞爆 */
const MAX_CUSTOM_CATEGORIES = 20

/**
 * 由名称与关键词派生归类特征词。
 * 中文没有空格，整串本身就是一个可用的特征；英文按空格与标点切开。
 */
function deriveMarkers(name: string, keywords: string[]): string[] {
  const words = new Set<string>()
  const push = (text: string): void => {
    for (const token of text.split(/[\s,，、/|]+/)) {
      const word = token.trim().toLowerCase()
      if (word.length >= 2) words.add(word)
    }
  }
  push(name)
  for (const keyword of keywords) push(keyword)
  return [...words]
}

export class CacheStore {
  readonly root: string
  readonly mediaDir: string
  readonly coverDir: string
  readonly lyricsDir: string
  readonly subsDir: string
  private readonly libraryFile: string
  private readonly settingsFile: string
  private readonly playbackFile: string
  private readonly categoriesFile: string
  private readonly sourcesFile: string
  private readonly historyFile: string
  private discoverHistory: DiscoverBatch[] = []
  private library: Track[] = []
  private customCategories: MusicCategory[] = []
  private customSources: MediaSource[] = []
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private playback: PlaybackSnapshot | null | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.root = app.getPath('userData')
    this.mediaDir = path.join(this.root, 'media')
    this.coverDir = path.join(this.root, 'covers')
    this.lyricsDir = path.join(this.root, 'lyrics')
    this.subsDir = path.join(this.root, 'subs')
    this.libraryFile = path.join(this.root, 'library.json')
    this.settingsFile = path.join(this.root, 'settings.json')
    this.playbackFile = path.join(this.root, 'playback.json')
    this.categoriesFile = path.join(this.root, 'categories.json')
    this.sourcesFile = path.join(this.root, 'sources.json')
    this.historyFile = path.join(this.root, 'discover-history.json')
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.mediaDir, { recursive: true })
    await fsp.mkdir(this.coverDir, { recursive: true })
    await fsp.mkdir(this.lyricsDir, { recursive: true })
    await fsp.mkdir(this.subsDir, { recursive: true })
    // 兼容早期版本没有 tags 字段的索引文件
    const stored = await this.readJson<Track[]>(this.libraryFile, [])
    this.library = stored.map((track) => ({
      ...track,
      tags: Array.isArray(track.tags) ? track.tags : []
    }))
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.readJson<Partial<AppSettings>>(this.settingsFile, {})) }
    // 加大类（音乐 / 有声书）之前建的分类没有 kind 字段，补默认值。
    // 不补的话分区时会两边都匹配不上，已建的分类就凭空消失了。
    this.customCategories = (
      await this.readJson<MusicCategory[]>(this.categoriesFile, [])
    ).map((category) => ({
      ...category,
      kind: category.kind === 'audiobook' ? 'audiobook' : 'music'
    }))
    // 注入给分类目录，之后查找 / 归类 / 搜索都会带上自建分类
    syncCustomCategories(this.customCategories)
    this.customSources = await this.readJson<MediaSource[]>(this.sourcesFile, [])
    syncCustomSources(this.customSources)
    // 顺带裁掉超出上限的旧批次
    this.discoverHistory = (
      await this.readJson<DiscoverBatch[]>(this.historyFile, [])
    ).slice(0, DISCOVER_HISTORY_LIMIT)
    await this.pruneMissing()
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private persist(file: string, value: unknown): void {
    const payload = JSON.stringify(value, null, 2)
    this.writeQueue = this.writeQueue
      .then(() => fsp.writeFile(file, payload, 'utf8'))
      .catch(() => undefined)
  }

  /** 清理索引中已被用户手动删除的文件 */
  private async pruneMissing(): Promise<void> {
    const before = this.library.length
    this.library = this.library.filter((t) => existsSync(path.join(this.mediaDir, t.fileName)))
    if (this.library.length !== before) this.persist(this.libraryFile, this.library)
  }

  /**
   * 归集媒体目录里尚未入索引的音频（外部放入、或上次中断遗留）。
   * 标题先以视频 ID 占位，稍后由 hydrateMetadata 补齐。
   */
  async reconcile(): Promise<boolean> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.mediaDir)
    } catch {
      return false
    }
    const knownFiles = new Set(this.library.map((t) => t.fileName))
    const knownIds = new Set(this.library.map((t) => t.id))
    let changed = false

    for (const name of entries) {
      if (knownFiles.has(name)) continue
      if (name.includes('.part') || name.endsWith('.ytdl') || name.endsWith('.downloading')) continue
      const parsed = path.parse(name)
      const ext = parsed.ext.toLowerCase()
      if (!AUDIO_EXT.has(ext)) continue
      if (knownIds.has(parsed.name)) continue

      const full = path.join(this.mediaDir, name)
      const stat = await fsp.stat(full).catch(() => null)
      if (!stat || stat.size < 8 * 1024) continue

      let coverName: string | null = null
      const coverFile = entries.find(
        (candidate) => path.parse(candidate).name === parsed.name && COVER_EXT.has(path.extname(candidate).toLowerCase())
      )
      if (coverFile) {
        coverName = coverFile
        await fsp
          .rename(path.join(this.mediaDir, coverFile), path.join(this.coverDir, coverFile))
          .catch(() => undefined)
      }

      this.library.push({
        id: parsed.name,
        title: parsed.name,
        artist: '未知艺术家',
        duration: 0,
        thumbnail: '',
        url: `https://www.youtube.com/watch?v=${parsed.name}`,
        fileName: name,
        coverName,
        size: stat.size,
        format: ext.replace('.', ''),
        downloadedAt: stat.mtimeMs || Date.now(),
        favorite: false,
        playCount: 0,
        lastPlayedAt: null,
        tags: []
      })
      knownIds.add(parsed.name)
      changed = true
    }

    if (changed) this.persist(this.libraryFile, this.library)
    return changed
  }

  /** 标题仍是视频 ID 的条目代表元数据缺失 */
  pendingMetadata(): Track[] {
    return this.library.filter((track) => track.title === track.id)
  }

  /* ── 标签 ─────────────────────────────────────────── */

  /**
   * 重算某首歌的自动标签。
   * 手动标签始终保留，自动标签整体替换。
   */
  async setAutoTags(id: string, input: Partial<AutoTagInput> = {}): Promise<Track | null> {
    const track = this.findTrack(id)
    if (!track) return null
    const labels = deriveAutoTags({
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      language: input.language ?? null,
      instrumental: input.instrumental,
      genre: input.genre ?? null,
      categories: input.categories
    })
    // 分类归类：命中分类特征词就把分类名也补成标签，
    // 分类名本身是标签，因此筛选栏与分类看板能直接复用标签体系
    const category = inferCategory(`${track.title} ${track.artist}`)
    if (category && !labels.includes(category.name)) labels.push(category.name)

    const manual = (track.tags ?? []).filter((tag) => tag.kind === 'manual')
    const manualLabels = new Set(manual.map((tag) => tag.label))
    const auto: TrackTag[] = labels
      .filter((label) => !manualLabels.has(label))
      .map((label) => ({ label, kind: 'auto' as const }))
    return this.updateTrack(id, { tags: [...manual, ...auto] })
  }

  async addTag(id: string, label: string): Promise<Track | null> {
    const track = this.findTrack(id)
    if (!track) return null
    const clean = label.trim().slice(0, 16)
    if (!clean) return track
    if ((track.tags ?? []).some((tag) => tag.label === clean)) return track
    return this.updateTrack(id, { tags: [...(track.tags ?? []), { label: clean, kind: 'manual' }] })
  }

  async removeTag(id: string, label: string): Promise<Track | null> {
    const track = this.findTrack(id)
    if (!track) return null
    return this.updateTrack(id, {
      tags: (track.tags ?? []).filter((tag) => tag.label !== label)
    })
  }

  /** 汇总全库标签，供筛选栏使用 */
  allTags(): TagSummary[] {
    const summary = new Map<string, TagSummary>()
    for (const track of this.library) {
      for (const tag of track.tags ?? []) {
        const entry = summary.get(tag.label) ?? { label: tag.label, count: 0, hasManual: false }
        entry.count += 1
        if (tag.kind === 'manual') entry.hasManual = true
        summary.set(tag.label, entry)
      }
    }
    return [...summary.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh')
    )
  }

  /** 还没有任何标签的曲目，启动时补算一次 */
  untagged(): Track[] {
    return this.library.filter((track) => !(track.tags ?? []).length)
  }

  /* ── 播放记忆 ─────────────────────────────────────── */

  async getPlayback(): Promise<PlaybackSnapshot | null> {
    if (this.playback === undefined) {
      this.playback = await this.readJson<PlaybackSnapshot | null>(this.playbackFile, null)
    }
    return this.playback
  }

  async savePlayback(snapshot: PlaybackSnapshot): Promise<void> {
    const previous = this.playback ?? null
    this.playback = snapshot
    // 播放中每几秒就会回调一次，没有实质变化就不写盘
    if (
      previous &&
      previous.trackId === snapshot.trackId &&
      previous.muted === snapshot.muted &&
      previous.repeat === snapshot.repeat &&
      Math.abs(previous.volume - snapshot.volume) < 0.01 &&
      Math.abs(previous.position - snapshot.position) < 1 &&
      previous.queueIds.join('|') === snapshot.queueIds.join('|')
    ) {
      return
    }
    this.persist(this.playbackFile, snapshot)
  }

  getSettings(): AppSettings {
    return { ...this.settings }
  }

  /* ── 自建源 ─────────────────────────────────────── */

  listCustomSources(): MediaSource[] {
    return this.customSources.map((source) => ({ ...source }))
  }

  /**
   * 自建源。
   * 搜索键是 yt-dlp 的站内搜索前缀（ytsearch / bilisearch / scsearch …），
   * 留空表示这个站没有搜索接口，只能粘贴链接下载。
   */
  addSource(input: SourceInput): MediaSource[] {
    const name = (input?.name ?? '').trim()
    const hosts = (input?.hosts ?? [])
      .map((host) =>
        String(host)
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '')
      )
      .filter(Boolean)
    const searchKey = String(input?.searchKey ?? '')
      .trim()
      .toLowerCase()
    if (!name) throw new Error('源名称不能为空')
    if (!hosts.length) throw new Error('至少填一个域名')
    if (allSources().some((source) => source.name === name)) {
      throw new Error(`已经有一个叫「${name}」的源了`)
    }

    const source: MediaSource = {
      id: `custom-${Date.now().toString(36)}`,
      name,
      hosts,
      searchKey,
      home: (input?.home ?? '').trim() || `https://${hosts[0]}/`,
      accent: CUSTOM_ACCENTS[this.customSources.length % CUSTOM_ACCENTS.length],
      note: searchKey ? '自建源，支持站内搜索' : '自建源，仅支持粘贴链接',
      custom: true
    }
    this.customSources.push(source)
    this.persist(this.sourcesFile, this.customSources)
    syncCustomSources(this.customSources)
    return this.listCustomSources()
  }

  removeSource(id: string): MediaSource[] {
    // 内置源不可删，这里直接当作无事发生
    if (!this.customSources.some((source) => source.id === id)) return this.listCustomSources()
    this.customSources = this.customSources.filter((source) => source.id !== id)
    this.persist(this.sourcesFile, this.customSources)
    syncCustomSources(this.customSources)
    return this.listCustomSources()
  }

  /* ── 发现历史 ─────────────────────────────────────── */

  listDiscoverHistory(): DiscoverBatch[] {
    return this.discoverHistory.map((batch) => ({ ...batch }))
  }

  /**
   * 记一批发现结果。
   *
   * 不按分类去重：同一个分类每点一次会轮换到下一个关键词（这是刻意的），
   * 两批内容本就不同，各自存一批才找得回来。
   */
  rememberDiscover(input: DiscoverBatchInput): DiscoverBatch | null {
    const tracks = input?.tracks ?? []
    // 空结果没什么可回看的
    if (!tracks.length) return null

    const sub = findSubCategory(input.categoryId)
    const batch: DiscoverBatch = {
      id: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      categoryId: input.categoryId,
      categoryName: sub
        ? `${sub.parent.name} › ${sub.sub.name}`
        : (categoryById(input.categoryId)?.name ?? input.categoryId),
      query: input.query,
      sourceId: input.sourceId ?? '',
      sourceName: input.sourceName ?? '',
      createdAt: Date.now(),
      tracks
    }
    this.discoverHistory.unshift(batch)
    if (this.discoverHistory.length > DISCOVER_HISTORY_LIMIT) {
      this.discoverHistory.length = DISCOVER_HISTORY_LIMIT
    }
    this.persist(this.historyFile, this.discoverHistory)
    return batch
  }

  /** 删掉一批；不传 id 表示清空 */
  forgetDiscover(id?: string): DiscoverBatch[] {
    this.discoverHistory = id
      ? this.discoverHistory.filter((batch) => batch.id !== id)
      : []
    this.persist(this.historyFile, this.discoverHistory)
    return this.listDiscoverHistory()
  }

  /* ── 自建分类 ─────────────────────────────────────── */

  listCustomCategories(): MusicCategory[] {
    return this.customCategories.map((category) => ({ ...category }))
  }

  /**
   * 新建分类。
   * 特征词由名称与关键词自动派生——用户不必理解 markers 是什么，
   * 但归类仍然走同一套打分逻辑。
   */
  addCategory(input: CategoryInput): MusicCategory[] {
    const name = (input?.name ?? '').trim()
    const keywords = (input?.keywords ?? []).map((item) => String(item).trim()).filter(Boolean)
    if (!name) throw new Error('分类名称不能为空')
    if (!keywords.length) throw new Error('至少填一个搜索关键词')
    if (allCategories().some((category) => category.name === name)) {
      throw new Error(`已经有一个叫「${name}」的分类了`)
    }
    if (this.customCategories.length >= MAX_CUSTOM_CATEGORIES) {
      throw new Error(`自建分类最多 ${MAX_CUSTOM_CATEGORIES} 个`)
    }

    const category: MusicCategory = {
      id: `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}`,
      name,
      blurb: (input?.blurb ?? '').trim() || `用「${keywords[0]}」等关键词搜索`,
      keywords,
      markers: deriveMarkers(name, keywords),
      accent: CUSTOM_ACCENTS[this.customCategories.length % CUSTOM_ACCENTS.length],
      kind: input?.kind === 'audiobook' ? 'audiobook' : 'music'
    }
    this.customCategories.push(category)
    this.persist(this.categoriesFile, this.customCategories)
    syncCustomCategories(this.customCategories)
    return this.listCustomCategories()
  }

  removeCategory(id: string): MusicCategory[] {
    const target = this.customCategories.find((category) => category.id === id)
    // 内置分类不可删，这里直接当作无事发生
    if (!target) return this.listCustomCategories()

    this.customCategories = this.customCategories.filter((category) => category.id !== id)
    this.persist(this.categoriesFile, this.customCategories)
    syncCustomCategories(this.customCategories)

    // 分类名本身就是标签，顺手清掉自动标签，免得留下指向已删分类的孤儿
    let changed = false
    for (const track of this.library) {
      const tags = track.tags ?? []
      const next = tags.filter((tag) => !(tag.kind === 'auto' && tag.label === target.name))
      if (next.length !== tags.length) {
        track.tags = next
        changed = true
      }
    }
    if (changed) this.persist(this.libraryFile, this.library)
    return this.listCustomCategories()
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    this.persist(this.settingsFile, this.settings)
    return this.getSettings()
  }

  listTracks(): Track[] {
    return [...this.library].sort((a, b) => b.downloadedAt - a.downloadedAt)
  }

  findTrack(id: string): Track | undefined {
    return this.library.find((t) => t.id === id)
  }

  hasTrack(id: string): boolean {
    return this.library.some((t) => t.id === id)
  }

  /** 扫描下载产物，取出音频文件与封面文件 */
  async inspectArtifacts(id: string): Promise<{ fileName: string; coverName: string | null; size: number } | null> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.mediaDir)
    } catch {
      return null
    }
    let audio: string | null = null
    let cover: string | null = null
    for (const name of entries) {
      if (name.includes('.part') || name.includes('.downloading') || name.endsWith('.ytdl')) continue
      const parsed = path.parse(name)
      if (parsed.name !== id) continue
      const ext = parsed.ext.toLowerCase()
      if (AUDIO_EXT.has(ext)) audio = name
      else if (COVER_EXT.has(ext)) cover = name
    }
    if (!audio) return null
    const stat = await fsp.stat(path.join(this.mediaDir, audio))
    let coverName: string | null = null
    if (cover) {
      coverName = path.basename(cover)
      // 统一搬到 covers 目录，避免媒体目录混杂图片
      try {
        await fsp.rename(path.join(this.mediaDir, cover), path.join(this.coverDir, cover))
      } catch {
        /* 保留原位也可正常工作 */
      }
    }
    return { fileName: audio, coverName, size: stat.size }
  }

  async addTrack(track: Track): Promise<Track[]> {
    const existing = this.library.findIndex((t) => t.id === track.id)
    if (existing >= 0) this.library[existing] = { ...this.library[existing], ...track }
    else this.library.push(track)
    this.persist(this.libraryFile, this.library)
    return this.listTracks()
  }

  async updateTrack(id: string, patch: Partial<Track>): Promise<Track | null> {
    const index = this.library.findIndex((t) => t.id === id)
    if (index < 0) return null
    this.library[index] = { ...this.library[index], ...patch }
    this.persist(this.libraryFile, this.library)
    return this.library[index]
  }

  async removeTrack(id: string, deleteFile = true): Promise<Track[]> {
    const index = this.library.findIndex((t) => t.id === id)
    if (index >= 0) {
      const [track] = this.library.splice(index, 1)
      if (deleteFile) {
        await fsp.rm(path.join(this.mediaDir, track.fileName), { force: true })
        if (track.coverName) {
          await fsp.rm(path.join(this.coverDir, track.coverName), { force: true })
          await fsp.rm(path.join(this.mediaDir, track.coverName), { force: true })
        }
      }
      this.persist(this.libraryFile, this.library)
    }
    return this.listTracks()
  }

  async clearAll(): Promise<Track[]> {
    const tracks = [...this.library]
    this.library = []
    this.persist(this.libraryFile, this.library)
    for (const track of tracks) {
      await fsp.rm(path.join(this.mediaDir, track.fileName), { force: true })
    }
    await fsp.rm(this.coverDir, { recursive: true, force: true })
    await fsp.mkdir(this.coverDir, { recursive: true })
    // 目录里可能残留中断的半成品
    const leftovers = await fsp.readdir(this.mediaDir).catch(() => [] as string[])
    for (const name of leftovers) {
      await fsp.rm(path.join(this.mediaDir, name), { force: true, recursive: true })
    }
    return []
  }

  async stats(): Promise<CacheStats> {
    return { count: this.library.length, bytes: this.library.reduce((sum, t) => sum + (t.size || 0), 0), mediaDir: this.mediaDir }
  }

  /** 请求参数：按代理模式解析 + cookies */
  async requestArgs(): Promise<string[]> {
    const { args } = await resolveProxyArgs(this.settings.proxyMode, this.settings.proxy)
    const cookie = this.settings.cookieFile.trim()
    if (cookie && existsSync(cookie)) args.push('--cookies', cookie)
    return args
  }
}
