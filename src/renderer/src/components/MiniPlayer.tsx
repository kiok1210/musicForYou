import { useEffect } from 'react'
import type { PlayerApi } from '@/hooks/usePlayer'
import { cleanTitle, coverUrl, formatDuration } from '@/utils/format'
import {
  CloseIcon,
  MinimizeIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RestoreIcon
} from './icons'

interface MiniPlayerProps {
  player: PlayerApi
  onExpand: () => void
}

/**
 * 精简浮窗：只留唱片、曲名与走带控制。
 * 它挂在同一个渲染进程里，播放状态直接复用，不存在跨窗口同步的问题。
 */
export function MiniPlayer({ player, onExpand }: MiniPlayerProps) {
  const track = player.current
  const cover = track ? coverUrl(track.coverName, track.thumbnail) : null
  const duration = player.duration || track?.duration || 0
  const percent = duration > 0 ? (player.currentTime / duration) * 100 : 0
  const waiting = player.loadState === 'waiting'

  // 浮窗没有菜单栏，万一展开按钮点不到，Esc 是最后的退路
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onExpand()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExpand])

  return (
    <div className="mini">
      <header className="mini-bar">
        <span className="mini-brand">VinylBox</span>
        <div className="mini-bar-tools">
          <button className="window-btn" onClick={onExpand} title="展开主界面">
            <RestoreIcon size={13} />
          </button>
          <button
            className="window-btn"
            onClick={() => void window.vinyl.window.minimize()}
            title="最小化"
          >
            <MinimizeIcon size={13} />
          </button>
          <button
            className="window-btn"
            data-close="true"
            onClick={() => void window.vinyl.window.close()}
            title="关闭"
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </header>

      <div className="mini-stage" data-spinning={player.playing}>
        <div
          className="mini-disc"
          style={cover ? { backgroundImage: `url("${cover}")` } : undefined}
        >
          <span className="mini-disc-hole" />
        </div>
      </div>

      <div className="mini-meta">
        <div className="mini-title">{track ? cleanTitle(track.title) : '还没有放入唱片'}</div>
        <div className="mini-artist">{track ? track.artist : '回到主界面挑一首'}</div>
      </div>

      <input
        className="slider mini-slider"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(player.currentTime, duration || 1)}
        style={{ ['--fill' as string]: `${percent}%` }}
        onChange={(event) => player.seek(Number(event.target.value))}
        disabled={!track}
        aria-label="播放进度"
      />

      <div className="mini-time">
        <span>{formatDuration(player.currentTime)}</span>
        <span>{waiting ? '缓冲中…' : formatDuration(duration)}</span>
      </div>

      <div className="mini-controls">
        <button className="icon-btn" onClick={player.prev} disabled={!track} title="上一首">
          <PrevIcon size={17} />
        </button>
        <button
          className="mini-play"
          onClick={player.toggle}
          disabled={!track}
          title={waiting ? '正在准备，点击可立即播放' : player.playing ? '暂停' : '播放'}
        >
          {waiting ? (
            <span className="play-button-spinner" />
          ) : player.playing ? (
            <PauseIcon size={20} />
          ) : (
            <PlayIcon size={20} />
          )}
        </button>
        <button className="icon-btn" onClick={player.next} disabled={!track} title="下一首">
          <NextIcon size={17} />
        </button>
      </div>
    </div>
  )
}
