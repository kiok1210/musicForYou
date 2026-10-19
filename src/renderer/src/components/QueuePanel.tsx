import type { PlayerApi } from '@/hooks/usePlayer'
import { cleanTitle, formatDuration } from '@/utils/format'
import { CloseIcon } from './icons'

interface QueuePanelProps {
  player: PlayerApi
  onClose: () => void
}

/**
 * 播放列表面板。
 *
 * 展示的是「实际播放顺序」而不是队列原始顺序：开了随机之后，
 * 用户最想知道的是接下来会放哪几首，原始顺序反而没有参考价值。
 * 点任意一项直接跳过去播。
 */
export function QueuePanel({ player, onClose }: QueuePanelProps) {
  const list = player.orderedQueue
  const currentId = player.current?.id ?? null
  const currentAt = list.findIndex((track) => track.id === currentId)

  const modeLabel = player.shuffle
    ? '随机'
    : player.repeat === 'one'
      ? '单曲循环'
      : player.repeat === 'all'
        ? '列表循环'
        : '顺序播放'

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <section className="queue-panel">
        <header className="settings-head">
          <h3>
            播放列表 · {list.length} 首 · {modeLabel}
          </h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <CloseIcon size={15} />
          </button>
        </header>

        {list.length ? (
          <div className="queue-list">
            {list.map((track, index) => {
              const active = track.id === currentId
              return (
                <button
                  key={`${track.id}-${index}`}
                  className="queue-row"
                  data-active={active}
                  data-played={currentAt >= 0 && index < currentAt}
                  onClick={() => player.jumpTo(index)}
                  title={active ? '正在播放' : '点击播放这首'}
                >
                  <span className="queue-index">{active ? '♪' : index + 1}</span>
                  <span className="queue-body">
                    <span className="queue-title">{cleanTitle(track.title)}</span>
                    <span className="queue-artist">{track.artist || '未知艺术家'}</span>
                  </span>
                  <span className="queue-time">{formatDuration(track.duration)}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="queue-empty">队列还是空的：从曲库或搜索结果里点一首开始播放。</div>
        )}
      </section>
    </>
  )
}
