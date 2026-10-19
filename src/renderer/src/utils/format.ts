/**
 * 渲染层格式化工具。
 *
 * 通用的部分已经提炼到 `@shared/portable/format`，这里只保留 Electron
 * 相关的 URL 组装，并把 portable 的实现按项目内的既有名字转出去。
 */
import type { Track, TrackMeta } from '@shared/types'
import { cleanMediaTitle, formatBytes, formatDuration, formatRelative } from '@shared/portable/format'
import { serverBase } from '../mobile/bridge'

export { formatBytes, formatDuration, formatRelative }

/** 项目内沿用的简短名字 */
export const cleanTitle = cleanMediaTitle

/**
 * 手机端连了电脑上的配套服务时，媒体要走它的 HTTP 地址；
 * 桌面端返回空串，保持 media:// 自定义协议不变。
 */
function remoteBase(): string {
  return serverBase()
}

export function mediaUrl(fileName: string): string {
  const base = remoteBase()
  return base
    ? `${base}/media/${encodeURIComponent(fileName)}`
    : `media://local/${encodeURIComponent(fileName)}`
}

/**
 * 尚未落盘的曲目走 stream://，由主进程取直链并转发，
 * 于是下载还在跑的时候就能播放。
 * 来源、页面地址与来源头一并带上：主进程才知道用哪个源的参数去解析直链。
 */
export function streamUrl(
  videoId: string,
  sourceId?: string,
  page?: string,
  referer?: string
): string {
  const params = new URLSearchParams()
  if (sourceId) params.set('src', sourceId)
  if (page) params.set('page', page)
  if (referer) params.set('ref', referer)
  const query = params.toString()
  const base = remoteBase()
  return base
    ? `${base}/stream/${encodeURIComponent(videoId)}${query ? `?${query}` : ''}`
    : `stream://audio/${encodeURIComponent(videoId)}${query ? `?${query}` : ''}`
}

export function coverUrl(coverName: string | null, fallback: string): string {
  if (!coverName) return fallback
  const base = remoteBase()
  return base
    ? `${base}/cover/${encodeURIComponent(coverName)}`
    : `media://cover/${encodeURIComponent(coverName)}`
}

/**
 * 把尚未落盘的曲目包成可播放对象。
 * `fileName` 留空即代表「还没有本地文件」，播放时自动走流式。
 */
export function metaToPlayable(meta: TrackMeta): Track {
  return {
    ...meta,
    fileName: '',
    coverName: null,
    size: 0,
    format: '',
    downloadedAt: Date.now(),
    favorite: false,
    playCount: 0,
    lastPlayedAt: null,
    tags: []
  }
}
