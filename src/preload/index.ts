import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  CacheStats,
  CategoryInput,
  CategorySummary,
  DiscoverBatch,
  MediaSource,
  QrPollResult,
  QrTicket,
  SourceAccount,
  SourceInput,
  DownloadTask,
  InstallProgress,
  IpcResult,
  Lyrics,
  PlaybackSnapshot,
  ProbeResult,
  TagSummary,
  ToolStatus,
  Track,
  TrackMeta
} from '@shared/types'

type Unsubscribe = () => void

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** 无载荷事件（例如退出前的刷写通知） */
function subscribeVoid(channel: string, handler: () => void): Unsubscribe {
  const listener = (): void => handler()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  tools: {
    status: (): Promise<IpcResult<ToolStatus>> => ipcRenderer.invoke('tools:status'),
    install: (): Promise<IpcResult<string>> => ipcRenderer.invoke('tools:install'),
    /** 更新 yt-dlp 到官方最新版，返回新的版本标识 */
    updateYtdlp: (): Promise<IpcResult<string>> => ipcRenderer.invoke('tools:update-ytdlp'),
    onInstallProgress: (cb: (progress: InstallProgress) => void): Unsubscribe =>
      subscribe<InstallProgress>('tools:install-progress', cb)
  },
  yt: {
    search: (
      query: string,
      limit: number,
      sourceId?: string
    ): Promise<IpcResult<TrackMeta[]>> => ipcRenderer.invoke('yt:search', query, limit, sourceId),
    resolve: (url: string): Promise<IpcResult<TrackMeta>> => ipcRenderer.invoke('yt:resolve', url)
  },
  sources: {
    list: (): Promise<IpcResult<MediaSource[]>> => ipcRenderer.invoke('sources:list'),
    add: (input: SourceInput): Promise<IpcResult<MediaSource[]>> =>
      ipcRenderer.invoke('sources:add', input),
    remove: (id: string): Promise<IpcResult<MediaSource[]>> =>
      ipcRenderer.invoke('sources:remove', id)
  },
  downloads: {
    list: (): Promise<IpcResult<DownloadTask[]>> => ipcRenderer.invoke('dl:list'),
    enqueue: (meta: TrackMeta): Promise<IpcResult<DownloadTask>> =>
      ipcRenderer.invoke('dl:enqueue', meta),
    cancel: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('dl:cancel', id),
    clear: (scope: 'finished' | 'all'): Promise<IpcResult<DownloadTask[]>> =>
      ipcRenderer.invoke('dl:clear', scope),
    onUpdate: (cb: (task: DownloadTask) => void): Unsubscribe =>
      subscribe<DownloadTask>('dl:update', cb),
    onList: (cb: (tasks: DownloadTask[]) => void): Unsubscribe =>
      subscribe<DownloadTask[]>('dl:list', cb),
    onDone: (cb: (track: Track) => void): Unsubscribe => subscribe<Track>('dl:done', cb)
  },
  library: {
    list: (): Promise<IpcResult<Track[]>> => ipcRenderer.invoke('library:list'),
    remove: (id: string, deleteFile = true): Promise<IpcResult<Track[]>> =>
      ipcRenderer.invoke('library:remove', id, deleteFile),
    toggleFavorite: (id: string): Promise<IpcResult<Track[]>> =>
      ipcRenderer.invoke('library:toggleFavorite', id),
    markPlayed: (id: string): Promise<IpcResult<Track | null>> =>
      ipcRenderer.invoke('library:markPlayed', id),
    progress: (id: string, position: number): Promise<IpcResult<Track | null>> =>
      ipcRenderer.invoke('library:progress', id, position),
    reveal: (id: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('library:reveal', id),
    onChanged: (cb: (tracks: Track[]) => void): Unsubscribe =>
      subscribe<Track[]>('library:changed', cb)
  },
  discover: {
    categories: (): Promise<IpcResult<CategorySummary[]>> =>
      ipcRenderer.invoke('discover:categories'),
    search: (
      categoryId: string,
      seed: number,
      sourceId?: string
    ): Promise<IpcResult<{ query: string; results: TrackMeta[]; batch: DiscoverBatch | null }>> =>
      ipcRenderer.invoke('discover:search', categoryId, seed, sourceId),
    history: (): Promise<IpcResult<DiscoverBatch[]>> => ipcRenderer.invoke('discover:history'),
    forget: (id?: string): Promise<IpcResult<DiscoverBatch[]>> =>
      ipcRenderer.invoke('discover:forget', id),
    addCategory: (input: CategoryInput): Promise<IpcResult<CategorySummary[]>> =>
      ipcRenderer.invoke('discover:add-category', input),
    removeCategory: (id: string): Promise<IpcResult<CategorySummary[]>> =>
      ipcRenderer.invoke('discover:remove-category', id)
  },
  tags: {
    list: (): Promise<IpcResult<TagSummary[]>> => ipcRenderer.invoke('tags:list'),
    add: (id: string, label: string): Promise<IpcResult<Track[]>> =>
      ipcRenderer.invoke('tags:add', id, label),
    remove: (id: string, label: string): Promise<IpcResult<Track[]>> =>
      ipcRenderer.invoke('tags:remove', id, label),
    retag: (): Promise<IpcResult<Track[]>> => ipcRenderer.invoke('tags:retag')
  },
  player: {
    snapshot: (): Promise<IpcResult<PlaybackSnapshot | null>> =>
      ipcRenderer.invoke('player:snapshot'),
    save: (snapshot: PlaybackSnapshot): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('player:save', snapshot),
    onFlush: (cb: () => void): Unsubscribe => subscribeVoid('player:flush', cb)
  },
  settings: {
    get: (): Promise<IpcResult<AppSettings>> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>> =>
      ipcRenderer.invoke('settings:save', patch)
  },
  net: {
    probe: (): Promise<IpcResult<ProbeResult>> => ipcRenderer.invoke('net:probe')
  },
  /** 手机端配套服务：配对信息，App 要连的就是这些地址 */
  api: {
    info: (): Promise<
      IpcResult<{ port: number; addresses: string[]; running: boolean }>
    > => ipcRenderer.invoke('api:info')
  },
  auth: {
    /** 支持扫码登录的源列表；新增源会自动出现 */
    sources: (): Promise<IpcResult<MediaSource[]>> => ipcRenderer.invoke('auth:sources'),
    /** 某个源的登录态；没登记的源恒为匿名 */
    status: (sourceId: string): Promise<IpcResult<SourceAccount>> =>
      ipcRenderer.invoke('auth:status', sourceId),
    refresh: (sourceId: string): Promise<IpcResult<SourceAccount>> =>
      ipcRenderer.invoke('auth:refresh', sourceId),
    qrcode: (sourceId: string): Promise<IpcResult<QrTicket>> =>
      ipcRenderer.invoke('auth:qrcode', sourceId),
    poll: (sourceId: string, key: string): Promise<IpcResult<QrPollResult>> =>
      ipcRenderer.invoke('auth:poll', sourceId, key),
    logout: (sourceId: string): Promise<IpcResult<SourceAccount>> =>
      ipcRenderer.invoke('auth:logout', sourceId),
    onLoginChanged: (cb: (payload: { sourceId: string; account: SourceAccount }) => void): Unsubscribe =>
      subscribe<{ sourceId: string; account: SourceAccount }>('auth:login-changed', cb)
  },
  lyrics: {
    get: (trackId: string, force = false): Promise<IpcResult<Lyrics>> =>
      ipcRenderer.invoke('lyrics:get', trackId, force),
    /** 本地语音识别：在线歌词拿不到时的离线兜底 */
    transcribe: (trackId: string): Promise<IpcResult<Lyrics>> =>
      ipcRenderer.invoke('lyrics:transcribe', trackId),
    onReady: (cb: (payload: { trackId: string; lyrics: Lyrics }) => void): Unsubscribe =>
      subscribe<{ trackId: string; lyrics: Lyrics }>('lyrics:ready', cb),
    onTranscribeProgress: (cb: (progress: { stage: string; ratio: number }) => void): Unsubscribe =>
      subscribe<{ stage: string; ratio: number }>('lyrics:transcribe-progress', cb)
  },
  cache: {
    stats: (): Promise<IpcResult<CacheStats>> => ipcRenderer.invoke('cache:stats'),
    openDir: (): Promise<IpcResult<string>> => ipcRenderer.invoke('cache:openDir'),
    clear: (): Promise<IpcResult<Track[]>> => ipcRenderer.invoke('cache:clear')
  },
  app: {
    openExternal: (url: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('app:openExternal', url),
    info: (): Promise<IpcResult<{ version: string; platform: string; userData: string }>> =>
      ipcRenderer.invoke('app:info')
  },
  window: {
    minimize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:isMaximized'),
    setMini: (enabled: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('window:mini', enabled),
    onMaximizedChange: (cb: (maximized: boolean) => void): Unsubscribe =>
      subscribe<boolean>('window:maximized', cb)
  }
}

export type VinylApi = typeof api

contextBridge.exposeInMainWorld('vinyl', api)
