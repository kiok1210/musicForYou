import { memo } from 'react'
import type { Track } from '@shared/types'
import { cleanTitle, formatBytes, formatDuration, formatRelative } from '@/utils/format'
import { FolderIcon, HeartIcon, PlayIcon, TagIcon, TrashIcon } from './icons'

interface LibraryListProps {
  tracks: Track[]
  currentId: string | null
  playing: boolean
  hasQuery: boolean
  activeTags: string[]
  onPlay: (track: Track) => void
  onToggleFavorite: (id: string) => void
  onRemove: (track: Track) => void
  onReveal: (id: string) => void
  onToggleTag: (label: string) => void
  onRemoveTag: (trackId: string, label: string) => void
  onAddTag: (track: Track) => void
}

export const LibraryList = memo(function LibraryList({
  tracks,
  currentId,
  playing,
  hasQuery,
  activeTags,
  onPlay,
  onToggleFavorite,
  onRemove,
  onReveal,
  onToggleTag,
  onRemoveTag,
  onAddTag
}: LibraryListProps) {
  if (!tracks.length) {
    return (
      <div className="empty">
        <strong>{hasQuery ? '没有匹配的缓存曲目' : '缓存还是空的'}</strong>
        <div className="empty-hint">
          {hasQuery ? '换个关键词或取消标签筛选试试。' : '缓存的音乐会出现在这里，点击即可播放。'}
        </div>
      </div>
    )
  }

  return (
    <div className="row-list">
      {tracks.map((track, index) => {
        const isCurrent = track.id === currentId
        // 续听进度只对长内容展示，短歌显示一条细线反而碍眼
        const saved = track.progress ?? 0
        const trackDuration = track.duration || 0
        const resumeRatio =
          trackDuration >= 600 && saved > 15 && saved < trackDuration - 30
            ? saved / trackDuration
            : 0
        return (
          <article className="row row-track" key={track.id} data-current={isCurrent}>
            <button
              className="row-cover row-cover-btn"
              onClick={() => onPlay(track)}
              style={
                track.thumbnail ? { backgroundImage: `url("${track.thumbnail}")` } : undefined
              }
              title="播放"
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
              <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
            </button>

            <div className="row-main" onClick={() => onPlay(track)}>
              <div className="row-title">{cleanTitle(track.title)}</div>
              <div className="row-sub">
                <span className="row-artist">{track.artist}</span>
                <span className="row-dot">·</span>
                <span className="row-time">{formatDuration(track.duration)}</span>
                <span className="row-dot">·</span>
                <span>{track.format.toUpperCase()}</span>
                <span className="row-dot">·</span>
                <span>{formatBytes(track.size)}</span>
                {track.lastPlayedAt ? (
                  <>
                    <span className="row-dot">·</span>
                    <span>{formatRelative(track.lastPlayedAt)}</span>
                  </>
                ) : null}
              </div>

              {resumeRatio > 0 ? (
                <div
                  className="row-progress"
                  title={`上次听到 ${formatDuration(saved)} / ${formatDuration(trackDuration)}`}
                >
                  <span style={{ width: `${resumeRatio * 100}%` }} />
                </div>
              ) : null}

              {track.tags?.length ? (
                <div className="tag-row">
                  {track.tags.map((tag) => (
                    <span
                      key={tag.label}
                      className="tag-chip"
                      role="button"
                      tabIndex={0}
                      data-manual={tag.kind === 'manual'}
                      data-active={activeTags.includes(tag.label)}
                      title={tag.kind === 'manual' ? '手动标签' : '自动标签'}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleTag(tag.label)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onToggleTag(tag.label)
                      }}
                    >
                      {tag.label}
                      <span
                        className="tag-remove"
                        title="移除标签"
                        onClick={(event) => {
                          event.stopPropagation()
                          onRemoveTag(track.id, tag.label)
                        }}
                      >
                        ×
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="row-actions">
              <button className="icon-btn" onClick={() => onAddTag(track)} title="添加标签">
                <TagIcon size={15} />
              </button>
              <button
                className="icon-btn"
                data-active={track.favorite}
                onClick={() => onToggleFavorite(track.id)}
                title={track.favorite ? '取消收藏' : '收藏'}
              >
                <HeartIcon size={15} filled={track.favorite} />
              </button>
              <button className="icon-btn" onClick={() => onReveal(track.id)} title="在文件夹中显示">
                <FolderIcon size={15} />
              </button>
              <button className="icon-btn" onClick={() => onRemove(track)} title="从缓存中删除">
                <TrashIcon size={15} />
              </button>
            </div>
          </article>
        )
      })}
    </div>
  )
})
