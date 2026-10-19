import { memo } from 'react'
import type { DownloadTask, TrackMeta } from '@shared/types'
import { cleanTitle } from '@/utils/format'
import { CloseIcon, DownloadIcon, PauseIcon, PlayIcon } from './icons'

interface DownloadQueueProps {
  tasks: DownloadTask[]
  /** 当前播放的曲目 ID，用于把试听按钮显示成暂停 */
  currentId: string | null
  playing: boolean
  onCancel: (id: string) => void
  onClear: () => void
  /** 边下边听：缓存还没完成也能先播放 */
  onAudition: (meta: TrackMeta) => void
}

const STATUS_LABEL: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  downloading: '下载中',
  processing: '处理中',
  done: '已完成',
  error: '失败',
  canceled: '已取消'
}

export const DownloadQueue = memo(function DownloadQueue({
  tasks,
  currentId,
  playing,
  onCancel,
  onClear,
  onAudition
}: DownloadQueueProps) {
  if (!tasks.length) {
    return (
      <div className="empty">
        <DownloadIcon size={22} />
        <strong>下载队列是空的</strong>
        <div className="empty-hint">在搜索结果里点「缓存」，任务会出现在这里。</div>
      </div>
    )
  }

  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length
  const finished = tasks.filter((t) => ['done', 'error', 'canceled'].includes(t.status)).length

  return (
    <>
      <div className="list-toolbar">
        <span className="list-toolbar-text">
          {active > 0 ? `${active} 个任务进行中` : '全部任务已结束'}
        </span>
        <button className="btn btn-sm" onClick={onClear} disabled={!finished}>
          清理已结束
        </button>
      </div>

      <div className="row-list">
        {tasks.map((task) => {
          const percent = Math.round(task.progress * 100)
          const running = task.status === 'downloading' || task.status === 'queued'
          const isCurrent = currentId === task.id
          return (
            <article className="queue-item" key={task.id} data-status={task.status}>
              <div
                className="row-cover"
                style={
                  task.meta.thumbnail
                    ? { backgroundImage: `url("${task.meta.thumbnail}")` }
                    : undefined
                }
              >
                <button
                  className="queue-audition"
                  data-active={isCurrent}
                  onClick={() => onAudition(task.meta)}
                  title={isCurrent && playing ? '暂停' : '边下边听'}
                >
                  {isCurrent && playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                </button>
              </div>
              <div className="row-main">
                <div className="row-title">{cleanTitle(task.meta.title)}</div>
                <div className="row-sub">
                  <span className="row-artist">{task.meta.artist}</span>
                  <span className="row-dot">·</span>
                  <span>{task.error ?? task.stage ?? STATUS_LABEL[task.status]}</span>
                  {task.speed ? <span className="row-speed">{task.speed}</span> : null}
                  {task.eta ? <span className="row-speed">ETA {task.eta}</span> : null}
                </div>
                {running || task.status === 'processing' ? (
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="row-actions">
                {running ? (
                  <button className="icon-btn" onClick={() => onCancel(task.id)} title="取消">
                    <CloseIcon size={15} />
                  </button>
                ) : (
                  <span className="queue-status" data-status={task.status}>
                    {task.status === 'done' ? `${percent}%` : STATUS_LABEL[task.status]}
                  </span>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </>
  )
})
