import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ANONYMOUS_ACCOUNT,
  DEFAULT_SETTINGS,
  type AppSettings,
  type CacheStats,
  type CategoryInput,
  type CategorySummary,
  type DiscoverBatch,
  type DownloadTask,
  type InstallProgress,
  type Lyrics,
  type MediaSource,
  type PlaybackSnapshot,
  type ProbeResult,
  type SourceAccount,
  type SourceInput,
  type TagSummary,
  type ToolStatus,
  type TranscribeState,
  type Track,
  type TrackMeta
} from '@shared/types'
import { usePlayer } from '@/hooks/usePlayer'
import { useMediaSession } from '@/hooks/useMediaSession'
import { cleanTitle, formatBytes, formatRelative, metaToPlayable } from '@/utils/format'
import { TitleBar } from '@/components/TitleBar'
import { PlayerColumn } from '@/components/PlayerColumn'
import { ResultList } from '@/components/ResultList'
import { DownloadQueue } from '@/components/DownloadQueue'
import { LibraryList } from '@/components/LibraryList'
import { MiniPlayer } from '@/components/MiniPlayer'
import { SourcePicker } from '@/components/SourcePicker'
import { DiscoverPanel } from '@/components/DiscoverPanel'
import { SettingsPanel } from '@/components/SettingsPanel'
import { QrLoginModal } from '@/components/QrLoginModal'
import { QueuePanel } from '@/components/QueuePanel'
import { ToastStack, type ToastItem } from '@/components/Toast'
import {
  DiscIcon,
  DownloadIcon,
  FolderIcon,
  HeartIcon,
  PrevIcon,
  RefreshIcon,
  SearchIcon,
  BookIcon,
  SparkIcon
} from '@/components/icons'

type TabKey = 'search' | 'downloads' | 'library' | 'audiobooks'

const ACTIVE_STATUS: DownloadTask['status'][] = ['queued', 'downloading', 'processing']

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [results, setResults] = useState<TrackMeta[]>([])
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<ToolStatus | null>(null)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [stats, setStats] = useState<CacheStats | null>(null)
  const [netState, setNetState] = useState<ProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [sources, setSources] = useState<MediaSource[]>([])
  const [lyrics, setLyrics] = useState<Lyrics | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeState, setTranscribeState] = useState<TranscribeState | null>(null)

  const currentIdRef = useRef<string | null>(null)
  const [tab, setTab] = useState<TabKey>('search')
  const [keyword, setKeyword] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [discoverCategory, setDiscoverCategory] = useState<string | null>(null)
  /** 每点一次「发现」就 +1，让同一个分类轮换到下一个关键词 */
  const [discoverSeq, setDiscoverSeq] = useState(0)
  /** 每批发现结果的快照：换了关键词之后原来的结果就搜不回来了，靠它找回 */
  const [discoverHistory, setDiscoverHistory] = useState<DiscoverBatch[]>([])
  /** 正在回看的历史批次 id，null 表示当前是刚搜出来的新结果 */
  const [viewingBatchId, setViewingBatchId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 从搜索框的源菜单点「添加自定义源」进来时，设置面板直接展开添加表单 */
  const [sourceFormOpen, setSourceFormOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  /** 本地曲库是否已就位，用于区分「还没加载」与「确实没组件」 */
  const [booted, setBooted] = useState(false)
  /** 精简浮窗：同一个窗口换一套界面，窗口本身由主进程缩放并置顶 */
  const [mini, setMini] = useState(false)
  /** 源 id → 登录态；只有声明了登录方式的源才有条目 */
  const [accounts, setAccounts] = useState<Record<string, SourceAccount>>({})
  /** 扫码登录弹窗：切到需要登录的源、或用该源搜索却没登录时自动开一次 */
  const [loginSource, setLoginSource] = useState<string | null>(null)
  /** 自动弹过就不再打扰，之后用户可以从设置里自己点进来 */
  const authNagged = useRef(false)
  /** 播放列表面板 */
  const [queueOpen, setQueueOpen] = useState(false)

  const toastSeq = useRef(0)

  const pushToast = useCallback((kind: ToastItem['kind'], text: string) => {
    toastSeq.current += 1
    const id = toastSeq.current
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id))
    }, 4500)
  }, [])

  const refreshLibrary = useCallback(async () => {
    const [list, cacheStats] = await Promise.all([
      window.vinyl.library.list(),
      window.vinyl.cache.stats()
    ])
    if (list.ok) setTracks(list.data)
    if (cacheStats.ok) setStats(cacheStats.data)
  }, [])

  const refreshStatus = useCallback(async () => {
    const res = await window.vinyl.tools.status()
    if (res.ok) setStatus(res.data)
  }, [])

  /** 退出某个源的登录：结果提示统一由这里给出 */
  const logoutSource = useCallback(
    (sourceId: string) => {
      void window.vinyl.auth.logout(sourceId).then((res) => {
        if (!res.ok) {
          pushToast('error', res.message)
          return
        }
        setAccounts((prev) => ({ ...prev, [sourceId]: res.data }))
        pushToast('info', '已退出登录')
      })
    },
    [pushToast]
  )

  /** 更新 yt-dlp：进度走 tools:onInstallProgress，完成后刷新状态行 */
  const updateYtdlp = useCallback(() => {
    void window.vinyl.tools.updateYtdlp().then(async (res) => {
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      await refreshStatus()
      pushToast('success', `下载核心已更新：${res.data}`)
    })
  }, [pushToast, refreshStatus])

  // 站点登录态：主进程启动时已联网校准，这里取各源的快照；
  // 扫码成功后主进程会广播，带上源 id 才知道刷哪一行
  useEffect(() => {
    void (async () => {
      const list = await window.vinyl.auth.sources()
      if (!list.ok) return
      const snapshot: Record<string, SourceAccount> = {}
      await Promise.all(
        list.data.map(async (source) => {
          const status = await window.vinyl.auth.status(source.id)
          if (status.ok) snapshot[source.id] = status.data
        })
      )
      setAccounts(snapshot)
    })()
    return window.vinyl.auth.onLoginChanged(({ sourceId, account }) => {
      setAccounts((prev) => ({ ...prev, [sourceId]: account }))
    })
  }, [])

  /* 首次加载 + 事件订阅 */
  useEffect(() => {
    // 本地数据优先：曲库、设置、队列都是内存里的东西，先让界面填满
    void (async () => {
      const [list, config, queue, sourceList, history] = await Promise.all([
        window.vinyl.library.list(),
        window.vinyl.settings.get(),
        window.vinyl.downloads.list(),
        window.vinyl.sources.list(),
        window.vinyl.discover.history()
      ])
      if (list.ok) setTracks(list.data)
      if (config.ok) setSettings(config.data)
      if (queue.ok) setTasks(queue.data)
      if (sourceList.ok) setSources(sourceList.data)
      if (history.ok) {
        setDiscoverHistory(history.data)
        // 「换一批」的关键词从历史长度接着轮，避免重启后撞回第一批用过的词
        setDiscoverSeq(history.data.length)
      }
      setBooted(true)
    })()

    // 这几个都要等外部响应（yt-dlp 版本、目录统计、连通性），放到后台各自落地
    void (async () => {
      const toolStatus = await window.vinyl.tools.status()
      if (toolStatus.ok) setStatus(toolStatus.data)
    })()
    void (async () => {
      const cacheStats = await window.vinyl.cache.stats()
      if (cacheStats.ok) setStats(cacheStats.data)
    })()
    void (async () => {
      const probe = await window.vinyl.net.probe()
      if (probe.ok) setNetState(probe.data)
    })()

    const offUpdate = window.vinyl.downloads.onUpdate((task) => {
      setTasks((prev) => {
        const index = prev.findIndex((item) => item.id === task.id)
        if (index < 0) return [...prev, task]
        const next = [...prev]
        next[index] = task
        return next
      })
    })
    const offList = window.vinyl.downloads.onList(setTasks)
    const offLibrary = window.vinyl.library.onChanged(() => {
      void refreshLibrary()
    })
    const offDone = window.vinyl.downloads.onDone((track) => {
      pushToast('success', `已缓存《${cleanTitle(track.title)}》`)
    })
    const offProgress = window.vinyl.tools.onInstallProgress(setProgress)

    return () => {
      offUpdate()
      offList()
      offLibrary()
      offDone()
      offProgress()
    }
  }, [pushToast, refreshStatus, refreshLibrary])

  const player = usePlayer(
    useCallback((track: Track) => {
      void window.vinyl.library.markPlayed(track.id).then((res) => {
        if (res.ok && res.data) {
          const updated = res.data
          setTracks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
        }
      })
    }, [])
  )

  const loadLyrics = useCallback(async (trackId: string, force = false) => {
    setLyricsLoading(true)
    const res = await window.vinyl.lyrics.get(trackId, force)
    setLyricsLoading(false)
    if (currentIdRef.current !== trackId) return
    setLyrics(res.ok ? res.data : null)
  }, [])

  const currentId = player.current?.id ?? null

  /**
   * 手机端把播放状态交给系统媒体会话：锁屏与通知栏有控制，
   * 系统也会因此认为「这台设备正在播放媒体」，后台不容易被回收。
   * 桌面端此 hook 内部会自行跳过。
   */
  useMediaSession({
    track: player.current,
    playing: player.playing,
    duration: player.duration,
    position: player.currentTime,
    onToggle: player.toggle,
    onNext: player.next,
    onPrev: player.prev,
    onSeek: player.seek
  })

  // 换曲目就重新取歌词；标题/字幕的匹配都放在主进程完成
  useEffect(() => {
    currentIdRef.current = currentId
    if (!currentId) {
      setLyrics(null)
      return
    }
    setLyrics(null)
    void loadLyrics(currentId)
  }, [currentId, loadLyrics])

  // 下载完成后的预取结果，命中当前曲目就直接换上
  useEffect(
    () =>
      window.vinyl.lyrics.onReady((payload) => {
        if (currentIdRef.current === payload.trackId) setLyrics(payload.lyrics)
      }),
    []
  )

  /* ── 播放记忆：启动还原 + 定时落盘 ─────────────────── */

  const restoredRef = useRef(false)
  const snapshotRef = useRef<PlaybackSnapshot | null>(null)

  // 设置里的默认倍速同步给播放器；听书时在播放器里改的会立即覆盖它
  useEffect(() => {
    player.setPlaybackRate(settings.playbackRate)
  }, [player.setPlaybackRate, settings.playbackRate])

  // 曲库就绪后还原上次的播放现场（保持暂停，不会自动出声）
  useEffect(() => {
    if (restoredRef.current || !tracks.length) return
    restoredRef.current = true
    void window.vinyl.player.snapshot().then((res) => {
      if (res.ok && res.data?.trackId) player.restore(res.data, tracks)
    })
  }, [tracks, player])

  // 正在试听的曲目落盘后，无缝换成同名本地文件，进度不打断
  const adoptedRef = useRef<string | null>(null)

  useEffect(() => {
    const current = player.current
    if (!current || current.fileName) return
    if (adoptedRef.current === current.id) return
    const local = tracks.find((item) => item.id === current.id)
    if (!local) return
    adoptedRef.current = current.id
    player.adopt(local)
  }, [tracks, player])

  useEffect(() => {
    snapshotRef.current = player.current
      ? {
          trackId: player.current.id,
          position: player.currentTime,
          volume: player.volume,
          muted: player.muted,
          repeat: player.repeat,
          shuffle: player.shuffle,
          queueIds: player.queue.map((track) => track.id),
          updatedAt: Date.now()
        }
      : null
  }, [
    player.current,
    player.currentTime,
    player.volume,
    player.muted,
    player.repeat,
    player.shuffle,
    player.queue
  ])

  useEffect(() => {
    const flush = (): void => {
      const snapshot = snapshotRef.current
      if (!snapshot) return
      void window.vinyl.player.save(snapshot)
      // 长内容（有声书）另存一份进度，断点续听靠它
      if (snapshot.trackId) {
        void window.vinyl.library.progress(snapshot.trackId, snapshot.position)
      }
    }
    // 播放中定期落盘，关窗前再补一次，最多丢几秒
    const timer = window.setInterval(flush, 3000)
    const offFlush = window.vinyl.player.onFlush(flush)
    return () => {
      window.clearInterval(timer)
      offFlush()
    }
  }, [])

  /* ── 本地识别（在线歌词拿不到时的离线兜底） ────────── */

  useEffect(
    () =>
      window.vinyl.lyrics.onTranscribeProgress((progress) => {
        setTranscribeState({ active: true, ...progress })
      }),
    []
  )

  const runTranscribe = useCallback(async () => {
    if (!currentId || transcribing) return
    setTranscribing(true)
    setTranscribeState({ active: true, stage: '正在准备…', ratio: 0 })
    const res = await window.vinyl.lyrics.transcribe(currentId)
    setTranscribing(false)
    setTranscribeState(null)
    if (res.ok) {
      setLyrics(res.data)
      pushToast('success', '本地识别完成')
    } else {
      pushToast('error', res.message)
    }
  }, [currentId, pushToast, transcribing])

  /** 有声书分类的名字集合：曲目的标签里挂着分类名，命中即算有声书 */
  const audiobookNames = useMemo(
    () => new Set(categories.filter((category) => category.kind === 'audiobook').map((c) => c.name)),
    [categories]
  )
  const isAudiobookTrack = useCallback(
    (track: Track) => (track.tags ?? []).some((tag) => audiobookNames.has(tag.label)),
    [audiobookNames]
  )
  /** 两个大区各一份：唱片只放音乐，有声书单独一区，不再混在一张唱片里 */
  const musicTracks = useMemo(
    () => tracks.filter((track) => !isAudiobookTrack(track)),
    [tracks, isAudiobookTrack]
  )
  const bookTracks = useMemo(
    () => tracks.filter((track) => isAudiobookTrack(track)),
    [tracks, isAudiobookTrack]
  )
  const cachedIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks])
  const busyIds = useMemo(
    () => new Set(tasks.filter((task) => ACTIVE_STATUS.includes(task.status)).map((task) => task.id)),
    [tasks]
  )
  const activeCount = tasks.filter((task) => ACTIVE_STATUS.includes(task.status)).length

  /** 当前所在的库分区：唱片放音乐，有声书单独一区 */
  const libraryTracks = tab === 'audiobooks' ? bookTracks : musicTracks

  /** 当前分区的标签聚合，直接在本地算，省一次往返 */
  const allTags = useMemo<TagSummary[]>(() => {
    const summary = new Map<string, TagSummary>()
    for (const track of libraryTracks) {
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
  }, [libraryTracks])

  const visibleTracks = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase()
    return libraryTracks.filter((track) => {
      if (favoriteOnly && !track.favorite) return false
      if (activeTags.length) {
        const labels = new Set((track.tags ?? []).map((tag) => tag.label))
        // 多选标签取交集，便于逐步收窄
        if (!activeTags.every((label) => labels.has(label))) return false
      }
      if (!query) return true
      return (
        track.title.toLowerCase().includes(query) ||
        track.artist.toLowerCase().includes(query) ||
        cleanTitle(track.title).toLowerCase().includes(query)
      )
    })
  }, [libraryTracks, libraryQuery, favoriteOnly, activeTags])

  const runSearch = useCallback(
    async (raw?: string) => {
      const query = (raw ?? keyword).trim()
      if (!query) return
      if (!status?.ytDlpReady) {
        pushToast('error', '下载核心尚未初始化，请先点击右上角「初始化组件」')
        return
      }
      setTab('search')
      setSearching(true)
      setLastQuery(query)
      setDiscoverCategory(null)
      const res = await window.vinyl.yt.search(query, settings.searchLimit, settings.source)
      setSearching(false)
      if (res.ok) {
        setResults(res.data)
        if (!res.data.length) pushToast('info', '没有找到匹配的曲目')
      } else {
        setResults([])
        pushToast('error', res.message)
      }
      // 用的是需要登录的源却还没登录：请用户扫一次码，否则会员曲目下不了。只打扰一次
      const source = sources.find((item) => item.id === settings.source)
      if (source?.auth === 'qrcode' && !accounts[source.id]?.loggedIn && !authNagged.current) {
        authNagged.current = true
        setLoginSource(source.id)
      }
    },
    [accounts, keyword, pushToast, settings.searchLimit, settings.source, sources, status?.ytDlpReady]
  )

  /* ── 分类发现 ─────────────────────────────────────── */

  // 曲库变化时刷新各分类的已缓存数量
  useEffect(() => {
    void window.vinyl.discover.categories().then((res) => {
      if (res.ok) setCategories(res.data)
    })
  }, [tracks])

  const discover = useCallback(
    async (categoryId: string) => {
      if (!status?.ytDlpReady) {
        pushToast('error', '下载核心尚未初始化，请先点击右上角「初始化组件」')
        return
      }
      setTab('search')
      setDiscoverCategory(categoryId)
      setSearching(true)
      const res = await window.vinyl.discover.search(categoryId, discoverSeq, settings.source)
      setSearching(false)
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      setResults(res.data.results)
      setLastQuery(res.data.query)
      const batch = res.data.batch
      if (batch) setDiscoverHistory((prev) => [batch, ...prev])
      setViewingBatchId(null)
      // 下次点同一个分类时换一个查询词，避免总看到同一批结果
      setDiscoverSeq((prev) => prev + 1)
    },
    [discoverSeq, pushToast, settings.source, status?.ytDlpReady]
  )

  /** 自建源：填好域名与搜索键后，有搜索键的会立刻出现在搜索框的下拉里 */
  const addSource = useCallback(
    async (input: SourceInput): Promise<boolean> => {
      const res = await window.vinyl.sources.add(input)
      if (!res.ok) {
        pushToast('error', res.message)
        return false
      }
      setSources(res.data)
      pushToast('success', `已添加源「${input.name}」`)
      return true
    },
    [pushToast]
  )

  const removeSource = useCallback(
    async (sourceId: string) => {
      const res = await window.vinyl.sources.remove(sourceId)
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      setSources(res.data)
      pushToast('info', '已删除源')
    },
    [pushToast]
  )

  const backToCategories = useCallback(() => {
    setResults([])
    setLastQuery('')
    setDiscoverCategory(null)
    setViewingBatchId(null)
  }, [])

  /**
   * 回看某一批发现结果。
   *
   * 用的是当时存下的快照，不重新联网——重搜同一个词未必拿得回同样的结果，
   * 而且白白多等一次网络往返。
   */
  const openBatch = useCallback((batch: DiscoverBatch) => {
    setTab('search')
    // 快照记得当时的源：补回每首曲目，之后试听与下载就用回当时的源，
    // 不受「现在搜索框里换成了哪个源」影响
    setResults(
      batch.tracks.map((meta) => ({ ...meta, sourceId: meta.sourceId ?? batch.sourceId }))
    )
    setLastQuery(batch.query)
    setDiscoverCategory(batch.categoryId)
    setViewingBatchId(batch.id)
  }, [])

  const forgetBatch = useCallback(
    async (id?: string) => {
      const res = await window.vinyl.discover.forget(id)
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      setDiscoverHistory(res.data)
      // 正在回看的这批被删掉就退回分类墙，免得停在一批已不存在的结果上
      if (id && id === viewingBatchId) backToCategories()
      pushToast('info', id ? '已删除这一批' : '已清空发现历史')
    },
    [backToCategories, pushToast, viewingBatchId]
  )

  /**
   * 当前这批结果是从哪个分类 / 小类点进来的，做成面包屑。
   * 搜过一轮之后，光看搜索词是回忆不起自己从哪来的。
   */
  const discoverLabel = useMemo(() => {
    if (!discoverCategory) return null
    for (const category of categories) {
      const sub = (category.subcategories ?? []).find((item) => item.id === discoverCategory)
      if (sub) return `${category.name} › ${sub.name}`
      if (category.id === discoverCategory) return category.name
    }
    return null
  }, [categories, discoverCategory])

  // 打开应用直接回到上次的发现内容，而不是空的分类墙。
  // 只自动恢复这一次：之后主动「返回分类墙」时不会被硬拉回来。
  const discoverRestoredRef = useRef(false)
  useEffect(() => {
    if (!booted || discoverRestoredRef.current) return
    discoverRestoredRef.current = true
    if (discoverHistory.length) openBatch(discoverHistory[0])
  }, [booted, discoverHistory, openBatch])

  // Esc 是回主页最快的路径：手不用离开键盘去找那个小按钮
  useEffect(() => {
    if (!lastQuery && !discoverCategory) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') backToCategories()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [backToCategories, lastQuery, discoverCategory])

  /** 新建分类后直接把看板刷新掉，新卡片立刻可用 */
  const addCategory = useCallback(
    async (input: CategoryInput): Promise<boolean> => {
      const res = await window.vinyl.discover.addCategory(input)
      if (!res.ok) {
        pushToast('error', res.message)
        return false
      }
      setCategories(res.data)
      pushToast('success', `已添加分类「${input.name}」`)
      return true
    },
    [pushToast]
  )

  const removeCategory = useCallback(
    async (categoryId: string) => {
      const res = await window.vinyl.discover.removeCategory(categoryId)
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      setCategories(res.data)
      pushToast('info', '已删除分类')
    },
    [pushToast]
  )

  /** 入队但不切标签页，供试听静默调用 */
  const enqueueQuiet = useCallback(
    async (meta: TrackMeta): Promise<boolean> => {
      const res = await window.vinyl.downloads.enqueue(meta)
      if (!res.ok) {
        pushToast('error', res.message)
        return false
      }
      setTasks((prev) => (prev.some((item) => item.id === meta.id) ? prev : [...prev, res.data]))
      return true
    },
    [pushToast]
  )

  const enqueue = useCallback(
    async (meta: TrackMeta) => {
      await enqueueQuiet(meta)
      setTab('downloads')
    },
    [enqueueQuiet]
  )

  /* 这几个回调固定引用，好让列表组件的 memo 真正生效 */

  const cancelDownload = useCallback((id: string) => {
    void window.vinyl.downloads.cancel(id)
  }, [])

  const clearFinished = useCallback(async () => {
    const res = await window.vinyl.downloads.clear('finished')
    if (res.ok) setTasks(res.data)
  }, [])

  const openExternal = useCallback((meta: TrackMeta) => {
    void window.vinyl.app.openExternal(meta.url)
  }, [])

  const playTrack = useCallback(
    (track: Track) => {
      player.play(track, tracks)
      // 长内容续听：只对已落盘的生效，流式还没缓冲到位时 seek 会失败
      const saved = track.progress ?? 0
      const duration = track.duration ?? 0
      if (track.fileName && duration >= 600 && saved > 15 && saved < duration - 30) {
        player.seek(saved)
        pushToast(
          'info',
          `从 ${Math.floor(saved / 60)} 分 ${Math.floor(saved % 60)} 秒继续`
        )
      }
    },
    [player, tracks, pushToast]
  )

  /**
   * 边听边缓存：点封面就立刻开播，同时把这首排进下载队列。
   * 已经落盘的就直接播本地文件，不会再下一遍。
   */
  const audition = useCallback(
    async (meta: TrackMeta) => {
      const local = tracks.find((item) => item.id === meta.id)
      if (local) {
        player.play(local, tracks)
        return
      }
      if (player.current?.id === meta.id) {
        player.toggle()
        return
      }
      // 队列用整批搜索结果：这样一条播完会接着播下一条，
      // 而不是孤零零地停住。已落盘的直接拿本地那条，其余走流式。
      const batch = results.length
        ? results.map((item) => tracks.find((t) => t.id === item.id) ?? metaToPlayable(item))
        : [metaToPlayable(meta)]
      player.play(metaToPlayable(meta), batch)
      // 提示即时给出，别让用户对着静止的界面猜
      if (!tasks.some((item) => item.id === meta.id)) pushToast('info', '已开始边听边缓存')
      void enqueueQuiet(meta)
    },
    [player, tracks, results, tasks, enqueueQuiet, pushToast]
  )

  const removeTrack = useCallback(
    async (track: Track) => {
      const confirmed = window.confirm(`确定要从本地缓存中删除《${cleanTitle(track.title)}》吗？`)
      if (!confirmed) return
      const res = await window.vinyl.library.remove(track.id, true)
      if (!res.ok) {
        pushToast('error', res.message)
        return
      }
      setTracks(res.data)
      if (player.current?.id === track.id) player.stop()
      const cacheStats = await window.vinyl.cache.stats()
      if (cacheStats.ok) setStats(cacheStats.data)
      pushToast('info', '已从缓存中删除')
    },
    [player, pushToast]
  )

  const installToolchain = useCallback(async () => {
    if (status?.installing) return
    setProgress({ step: '准备安装…', ratio: 0 })
    setStatus((prev) => (prev ? { ...prev, installing: true } : prev))
    const res = await window.vinyl.tools.install()
    setProgress(null)
    await refreshStatus()
    if (res.ok) pushToast('success', `组件已就绪：${res.data}`)
    else pushToast('error', res.message)
  }, [pushToast, refreshStatus, status?.installing])

  const reprobe = useCallback(async (): Promise<boolean> => {
    setProbing(true)
    const res = await window.vinyl.net.probe()
    setProbing(false)
    if (res.ok) {
      setNetState(res.data)
      return res.data.reachable
    }
    return false
  }, [])

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => ({ ...prev, ...patch }))
      const needsProbe = 'proxy' in patch || 'proxyMode' in patch
      void window.vinyl.settings.save(patch).then(() => {
        if (needsProbe) void reprobe()
      })
    },
    [reprobe]
  )

  // 当前源被删掉后退回 YouTube，免得搜索框指向一个已经不存在的源
  useEffect(() => {
    if (!sources.length || settings.source === 'youtube') return
    if (sources.some((source) => source.id === settings.source)) return
    updateSettings({ source: 'youtube' })
  }, [sources, settings.source, updateSettings])

  const clearCache = useCallback(async () => {
    if (!window.confirm('确定要清空全部本地缓存吗？该操作会删除已下载的音频文件。')) return
    const res = await window.vinyl.cache.clear()
    if (!res.ok) {
      pushToast('error', res.message)
      return
    }
    setTracks(res.data)
    player.stop()
    const cacheStats = await window.vinyl.cache.stats()
    if (cacheStats.ok) setStats(cacheStats.data)
    pushToast('info', '缓存已清空')
  }, [player, pushToast])

  const ready = Boolean(status?.ytDlpReady)
  const activeSource = useMemo(
    () => sources.find((source) => source.id === settings.source) ?? null,
    [sources, settings.source]
  )
  const viewingBatch = useMemo(
    () => discoverHistory.find((batch) => batch.id === viewingBatchId) ?? null,
    [discoverHistory, viewingBatchId]
  )

  /** 只有主进程确认缩放成功后，界面才跟着切换，避免两边状态不一致 */
  const toggleMini = useCallback(async (enabled: boolean): Promise<void> => {
    // 先把界面切过去，再让窗口变形：万一窗口那步失败，
    // 用户也不会被锁在一个点不动的小浮窗里出不来
    setMini(enabled)
    const res = await window.vinyl.window.setMini(enabled)
    if (!res.ok) pushToast('error', res.message)
  }, [pushToast])

  if (mini) {
    return (
      <div className="app app-mini">
        <MiniPlayer player={player} onExpand={() => void toggleMini(false)} />
        <ToastStack items={toasts} />
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar
        status={status}
        progress={progress}
        onInstall={installToolchain}
        onToggleMini={() => void toggleMini(true)}
      />

      <div className="app-body">
        <PlayerColumn
          player={player}
          lyrics={lyrics}
          lyricsLoading={lyricsLoading}
          showLyrics={showLyrics}
          onToggleView={() => setShowLyrics((prev) => !prev)}
          onReloadLyrics={() => {
            if (currentId) void loadLyrics(currentId, true)
          }}
          transcribing={transcribing}
          transcribeState={transcribeState}
          onTranscribe={() => void runTranscribe()}
          onShowQueue={() => setQueueOpen(true)}
        />

        <main className="workspace">
          <div className="workspace-head">
            <div className="search-row">
              <SourcePicker
                sources={sources}
                activeId={settings.source}
                onSelect={(id) => {
                  updateSettings({ source: id })
                  // 切到需要登录的源却还没登录，直接把二维码递上去
                  const target = sources.find((source) => source.id === id)
                  if (target?.auth === 'qrcode' && !accounts[id]?.loggedIn) {
                    authNagged.current = true
                    setLoginSource(id)
                  }
                }}
                onManage={() => {
                  setSettingsOpen(true)
                  setSourceFormOpen(true)
                }}
              />
              <input
                className="field"
                placeholder={
                  activeSource
                    ? `在「${activeSource.name}」搜索，或直接粘贴任意站点的链接`
                    : '粘贴链接，或搜索「歌手 / 歌曲名」'
                }
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch()
                }}
              />
              <button className="btn btn-primary" onClick={() => void runSearch()} disabled={searching}>
                {searching ? (
                  <RefreshIcon size={15} className="spin" />
                ) : (
                  <SearchIcon size={15} />
                )}
                搜索
              </button>
              <select
                className="select"
                value={settings.audioFormat}
                onChange={(event) =>
                  updateSettings({ audioFormat: event.target.value as AppSettings['audioFormat'] })
                }
                title="缓存格式"
              >
                <option value="m4a">M4A</option>
                <option value="mp3">MP3</option>
              </select>
            </div>

            <div className="toolbar-row">
              <div className="tabs">
                <button
                  className="tab"
                  data-active={tab === 'search'}
                  onClick={() => {
                    setTab('search')
                    // 正停在分类墙上就不动，别把人硬拉回结果；
                    // 其余情况「发现」都回到最近一批（快照，不联网）
                    if (!lastQuery && !discoverCategory) return
                    if (discoverHistory.length) openBatch(discoverHistory[0])
                    else backToCategories()
                  }}
                  title="回到上次的发现内容"
                >
                  <SparkIcon size={14} />
                  发现
                </button>
                <button
                  className="tab"
                  data-active={tab === 'downloads'}
                  onClick={() => setTab('downloads')}
                >
                  <DownloadIcon size={14} />
                  下载
                  {activeCount > 0 ? <span className="tab-count">{activeCount}</span> : null}
                </button>
                <button
                  className="tab"
                  data-active={tab === 'library'}
                  onClick={() => {
                    setTab('library')
                    // 换区时清掉标签筛选：上一区选中的标签在另一区多半不存在
                    setActiveTags([])
                  }}
                >
                  <DiscIcon size={14} />
                  我的唱片
                  {musicTracks.length > 0 ? (
                    <span className="tab-count">{musicTracks.length}</span>
                  ) : null}
                </button>
                <button
                  className="tab"
                  data-active={tab === 'audiobooks'}
                  onClick={() => {
                    setTab('audiobooks')
                    setActiveTags([])
                  }}
                >
                  <BookIcon size={14} />
                  有声书
                  {bookTracks.length > 0 ? (
                    <span className="tab-count">{bookTracks.length}</span>
                  ) : null}
                </button>
              </div>

              <div className="toolbar-spacer" />

              <span className="meta-text">
                {stats ? `${stats.count} 首 · ${formatBytes(stats.bytes)}` : '缓存统计读取中'}
              </span>
              <button
                className="icon-btn"
                onClick={() => void window.vinyl.cache.openDir()}
                title="打开缓存目录"
              >
                <FolderIcon size={16} />
              </button>
              <button className="btn btn-sm" onClick={() => setSettingsOpen(true)}>
                设置
              </button>
            </div>
          </div>

          <div className="workspace-scroll">
            {netState && !netState.reachable ? (
              <div className="net-warning">
                <span className="net-warning-dot" />
                <div className="net-warning-body">
                  <strong>无法连接 YouTube</strong>
                  <span>
                    {netState.proxy
                      ? `已探测到系统代理 ${netState.proxy}，但请求仍不通，可在设置里手动指定。`
                      : '未探测到系统代理。若已开启代理软件，请在设置中填写代理地址。'}
                  </span>
                </div>
                <button className="btn btn-sm" onClick={() => void reprobe()} disabled={probing}>
                  {probing ? '检测中…' : '重新检测'}
                </button>
                <button className="btn btn-sm" onClick={() => setSettingsOpen(true)}>
                  去设置
                </button>
              </div>
            ) : null}

            {booted && !ready ? (
              <div className="setup-card">
                <div className="setup-card-icon">
                  <SparkIcon size={19} />
                </div>
                <div className="setup-card-body">
                  <div className="setup-card-title">
                    {status?.installing ? '正在初始化下载核心…' : '首次使用需要初始化下载核心'}
                  </div>
                  <div className="setup-card-text">
                    {status?.installing
                      ? (progress?.step ?? '正在准备组件…')
                      : '需要安装 yt-dlp 与 ffmpeg，约 30MB，仅需一次。组件会放进应用自己的目录，不影响系统环境。'}
                  </div>
                  {status?.installing ? (
                    <div className="setup-progress">
                      <span style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                {status?.installing ? null : (
                  <button className="btn btn-primary" onClick={installToolchain}>
                    立即初始化
                  </button>
                )}
              </div>
            ) : null}

            {tab === 'search' && !searching && !lastQuery ? (
              <DiscoverPanel
                categories={categories}
                activeId={discoverCategory}
                loading={searching}
                history={discoverHistory}
                sources={sources}
                onDiscover={discover}
                onOpenBatch={openBatch}
                onForgetBatch={forgetBatch}
                onAddCategory={addCategory}
                onRemoveCategory={removeCategory}
              />
            ) : null}

            {tab === 'search' && (searching || lastQuery) ? (
              <>
                <div className="list-toolbar">
                  <button
                    className="btn btn-back"
                    onClick={backToCategories}
                    title="回到分类墙（Esc）"
                  >
                    <PrevIcon size={14} />
                    返回分类墙
                  </button>
                  <span className="list-toolbar-text">
                    {discoverLabel ? `发现 › ${discoverLabel}` : '搜索结果'} · {lastQuery}
                    {viewingBatch
                      ? ` · 回看 ${formatRelative(viewingBatch.createdAt)}${
                          viewingBatch.sourceName ? ` · 来自${viewingBatch.sourceName}` : ''
                        }`
                      : ''}
                    {results.length ? ` · ${results.length} 条` : ''}
                  </span>
                  {discoverCategory ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => void discover(discoverCategory)}
                      disabled={searching}
                      title="换一个关键词再搜一批"
                    >
                      <RefreshIcon size={12} className={searching ? 'spin' : undefined} />
                      换一批
                    </button>
                  ) : null}
                </div>
                <ResultList
                  results={results}
                  loading={searching}
                  cachedIds={cachedIds}
                  busyIds={busyIds}
                  currentId={player.current?.id ?? null}
                  playing={player.playing}
                  keyword={lastQuery}
                  sourceName={activeSource?.name ?? ''}
                  onDownload={enqueue}
                  onAudition={audition}
                  onOpen={openExternal}
                />
              </>
            ) : null}

            {tab === 'downloads' ? (
              <DownloadQueue
                tasks={tasks}
                currentId={player.current?.id ?? null}
                playing={player.playing}
                onAudition={audition}
                onCancel={cancelDownload}
                onClear={clearFinished}
              />
            ) : null}

            {tab === 'library' || tab === 'audiobooks' ? (
              <>
                <div className="list-toolbar">
                  <input
                    className="field"
                    style={{ height: 32, maxWidth: 240 }}
                    placeholder="在缓存中筛选…"
                    value={libraryQuery}
                    onChange={(event) => setLibraryQuery(event.target.value)}
                  />
                  <button
                    className="icon-btn"
                    data-active={favoriteOnly}
                    onClick={() => setFavoriteOnly((prev) => !prev)}
                    title="只看收藏"
                  >
                    <HeartIcon size={16} filled={favoriteOnly && tracks.some((t) => t.favorite)} />
                  </button>
                  <div className="toolbar-spacer" />
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const first = visibleTracks[0]
                      if (first) playTrack(first)
                    }}
                    disabled={!visibleTracks.length}
                  >
                    播放全部
                  </button>
                </div>
                {allTags.length ? (
                  <div className="tag-bar">
                    <button
                      className="tag-chip tag-chip-all"
                      data-active={!activeTags.length}
                      onClick={() => setActiveTags([])}
                    >
                      全部
                      <span className="tag-count">{libraryTracks.length}</span>
                    </button>
                    {allTags.map((tag) => (
                      <button
                        key={tag.label}
                        className="tag-chip"
                        data-manual={tag.hasManual}
                        data-active={activeTags.includes(tag.label)}
                        title={tag.hasManual ? '含手动标签' : '自动标签'}
                        onClick={() =>
                          setActiveTags((prev) =>
                            prev.includes(tag.label)
                              ? prev.filter((item) => item !== tag.label)
                              : [...prev, tag.label]
                          )
                        }
                      >
                        {tag.label}
                        <span className="tag-count">{tag.count}</span>
                      </button>
                    ))}
                    <button
                      className="tag-chip tag-chip-action"
                      title="重新计算自动标签"
                      onClick={() => {
                        void window.vinyl.tags.retag().then((res) => {
                          if (res.ok) {
                            setTracks(res.data)
                            pushToast('success', '已重新计算自动标签')
                          }
                        })
                      }}
                    >
                      <RefreshIcon size={12} />
                    </button>
                  </div>
                ) : null}

                <LibraryList
                  tracks={visibleTracks}
                  currentId={player.current?.id ?? null}
                  playing={player.playing}
                  hasQuery={Boolean(libraryQuery.trim()) || favoriteOnly || activeTags.length > 0}
                  activeTags={activeTags}
                  onPlay={playTrack}
                  onToggleFavorite={(id) => {
                    void window.vinyl.library.toggleFavorite(id).then((res) => {
                      if (res.ok) setTracks(res.data)
                    })
                  }}
                  onRemove={removeTrack}
                  onReveal={(id) => void window.vinyl.library.reveal(id)}
                  onToggleTag={(label) =>
                    setActiveTags((prev) =>
                      prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label]
                    )
                  }
                  onRemoveTag={(trackId, label) => {
                    void window.vinyl.tags.remove(trackId, label).then((res) => {
                      if (res.ok) setTracks(res.data)
                    })
                  }}
                  onAddTag={(track) => {
                    const label = window.prompt(
                      `给《${cleanTitle(track.title)}》添加标签`,
                      ''
                    )
                    if (!label?.trim()) return
                    void window.vinyl.tags.add(track.id, label.trim()).then((res) => {
                      if (res.ok) setTracks(res.data)
                    })
                  }}
                />
              </>
            ) : null}
          </div>
        </main>
      </div>

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          stats={stats}
          status={status}
          netState={netState}
          probing={probing}
          sources={sources}
          onAddSource={addSource}
          onRemoveSource={removeSource}
          onChange={updateSettings}
          onReprobe={() => void reprobe()}
          onClose={() => {
            setSettingsOpen(false)
            setSourceFormOpen(false)
          }}
          onOpenDir={() => void window.vinyl.cache.openDir()}
          onClearCache={() => void clearCache()}
          openSourceForm={sourceFormOpen}
          accounts={accounts}
          onOpenLogin={setLoginSource}
          onLogout={logoutSource}
          progress={progress}
          onUpdateYtdlp={updateYtdlp}
        />
      ) : null}

      {queueOpen ? <QueuePanel player={player} onClose={() => setQueueOpen(false)} /> : null}

      {loginSource ? (
        <QrLoginModal
          sourceId={loginSource}
          sourceName={sources.find((source) => source.id === loginSource)?.name ?? loginSource}
          account={accounts[loginSource] ?? ANONYMOUS_ACCOUNT}
          onToast={pushToast}
          onAccountChange={(sourceId, account) =>
            setAccounts((prev) => ({ ...prev, [sourceId]: account }))
          }
          onClose={() => setLoginSource(null)}
        />
      ) : null}

      <ToastStack items={toasts} />
    </div>
  )
}
