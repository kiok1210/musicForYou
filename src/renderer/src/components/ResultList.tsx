import { memo } from 'react'
import type { TrackMeta } from '@shared/types'
import { cleanTitle, formatDuration } from '@/utils/format'
import { DownloadIcon, LinkIcon, PlayIcon, RefreshIcon } from './icons'

interface ResultListProps {
  results: TrackMeta[]
  loading: boolean
  cachedIds: Set<string>
  busyIds: Set<string>
  currentId: string | null
  playing: boolean
  keyword: string
  /** 当前搜索源的名字，加载提示要跟着源走，不能写死 YouTube */
  sourceName: string
  onDownload: (meta: TrackMeta) => void
  /** 试听：立刻播放，同时把这首排进下载队列 */
  onAudition: (meta: TrackMeta) => void
  onOpen: (meta: TrackMeta) => void
}

export const ResultList = memo(function ResultList({
  results,
  loading,
  cachedIds,
  busyIds,
  currentId,
  playing,
  keyword,
  sourceName,
  onDownload,
  onAudition,
  onOpen
}: ResultListProps) {
  if (loading) {
    return (
      <div className="empty">
        <RefreshIcon size={22} className="spin" />
        <strong>正在检索 {sourceName || '所选源'}…</strong>
      </div>
    )
  }

  if (!results.length) {
    return (
      <div className="empty">
        <strong>{keyword ? '没有找到匹配的曲目' : '开始你的第一张唱片'}</strong>
        <div className="empty-hint">
          在上方粘贴视频链接，或输入歌曲 / 歌手关键词。
          <br />
          点封面即可边听边缓存，音频会留在本地，断网也能继续播放。
        </div>
      </div>
    )
  }

  return (
    <div className="row-list">
      {results.map((meta) => {
        const cached = cachedIds.has(meta.id)
        const busy = busyIds.has(meta.id)
        const isCurrent = currentId === meta.id
        return (
          <article className="row row-track" key={meta.id} data-current={isCurrent}>
            <button
              className="row-cover row-cover-btn"
              onClick={() => onAudition(meta)}
              style={
                meta.thumbnail ? { backgroundImage: `url("${meta.thumbnail}")` } : undefined
              }
              title={isCurrent && playing ? '暂停' : '边听边缓存'}
            >
              <span className="row-cover-mask">
                {isCurrent && playing ? (
                  <span className="equalizer">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <PlayIcon size={17} />
                )}
              </span>
            </button>

            <div className="row-main" onClick={() => onAudition(meta)}>
              <div className="row-title">{cleanTitle(meta.title)}</div>
              <div className="row-sub">
                <span className="row-artist">{meta.artist}</span>
                <span className="row-dot">·</span>
                <span className="row-time">{formatDuration(meta.duration)}</span>
                {cached ? <span className="badge">已缓存</span> : null}
              </div>
            </div>

            <div className="row-actions">
              <button
                className="icon-btn"
                onClick={() => onOpen(meta)}
                title="在浏览器中打开"
              >
                <LinkIcon size={15} />
              </button>
              <button
                className={cached ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
                onClick={() => onDownload(meta)}
                disabled={cached || busy}
                title={cached ? '已在缓存中' : '缓存到本地'}
              >
                {busy ? <RefreshIcon size={13} className="spin" /> : <DownloadIcon size={13} />}
                {busy ? '进行中' : cached ? '已缓存' : '缓存'}
              </button>
            </div>
          </article>
        )
      })}
    </div>
  )
})
