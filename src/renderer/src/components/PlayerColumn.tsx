import { useState } from 'react'
import type { Lyrics, TranscribeState } from '@shared/types'
import type { PlayerApi } from '@/hooks/usePlayer'
import { SLEEP_PRESETS, formatClock, formatRate } from '@shared/portable/playback'
import { cleanTitle, coverUrl, formatDuration } from '@/utils/format'
import { VinylStage } from './VinylStage'
import { LyricsView, useActiveLyricIndex } from './LyricsView'
import {
  LyricsIcon,
  MoonIcon,
  MuteIcon,
  NextIcon,
  ListIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  VolumeIcon
} from './icons'

interface PlayerColumnProps {
  player: PlayerApi
  lyrics: Lyrics | null
  lyricsLoading: boolean
  showLyrics: boolean
  transcribing: boolean
  transcribeState: TranscribeState | null
  onToggleView: () => void
  onReloadLyrics: () => void
  onTranscribe: () => void
  /** 打开播放列表面板 */
  onShowQueue: () => void
}

export function PlayerColumn({
  player,
  lyrics,
  lyricsLoading,
  showLyrics,
  transcribing,
  transcribeState,
  onToggleView,
  onReloadLyrics,
  onTranscribe,
  onShowQueue
}: PlayerColumnProps) {
  const track = player.current
  const cover = track ? coverUrl(track.coverName, track.thumbnail) : null
  const duration = player.duration || track?.duration || 0
  const progressPercent = duration > 0 ? (player.currentTime / duration) * 100 : 0
  const volumeValue = player.muted ? 0 : player.volume

  const activeIndex = useActiveLyricIndex(lyrics, player.currentTime)
  const activeLine = activeIndex >= 0 ? lyrics?.lines[activeIndex] : undefined
  const [sleepOpen, setSleepOpen] = useState(false)

  const RepeatGlyph = player.repeat === 'one' ? RepeatOneIcon : RepeatIcon

  // 剩余时间按当前倍速折算，听书时才知道「还能听多久」
  const remaining = Math.max(0, (duration - player.currentTime) / (player.playbackRate || 1))

  return (
    <aside className="player-column">
      <div className="stage-slot">
        {showLyrics ? (
          <LyricsView
            lyrics={lyrics}
            loading={lyricsLoading}
            currentTime={player.currentTime}
            transcribing={transcribing}
            transcribeState={transcribeState}
            onReload={onReloadLyrics}
            onTranscribe={onTranscribe}
            onToggleView={onToggleView}
          />
        ) : (
          <>
            <VinylStage cover={cover} playing={player.playing} />
            <button
              className="stage-toggle"
              onClick={onToggleView}
              title={track ? '查看歌词' : '播放后可查看歌词'}
              disabled={!lyrics?.lines.length}
            >
              <LyricsIcon size={15} />
            </button>
          </>
        )}
      </div>

      <div className={`now-playing${track ? '' : ' now-playing-empty'}`}>
        <div className="now-playing-title">
          {track ? cleanTitle(track.title) : '还没有放入唱片'}
        </div>
        <div className="now-playing-artist">
          {track ? track.artist : '搜索并缓存一首歌，让它转起来'}
        </div>
      </div>

      {player.loadState === 'waiting' ? (
        <div className="load-hint">
          <span className="load-hint-spinner" />
          <span>
            {player.buffered > 0
              ? `缓冲中 ${Math.floor(player.buffered)} / ${player.prebuffer} 秒，攒够就出声`
              : '正在解析音频流…'}
          </span>
        </div>
      ) : null}

      {player.loadState === 'error' ? (
        <div className="load-hint" data-error="true">
          <span>{player.loadError ?? '音频流获取失败'}</span>
        </div>
      ) : null}

      {!showLyrics ? (
        <button
          className="lyric-preview"
          onClick={onToggleView}
          disabled={!lyrics?.lines.length}
          title={lyrics?.lines.length ? '展开完整歌词' : '暂无歌词'}
        >
          {lyricsLoading ? (
            <span className="lyric-preview-empty">正在匹配歌词…</span>
          ) : activeLine ? (
            <>
              <span className="lyric-preview-text">{activeLine.text}</span>
              {activeLine.translation ? (
                <span className="lyric-preview-trans">{activeLine.translation}</span>
              ) : null}
            </>
          ) : (
            <span className="lyric-preview-empty">
              {lyrics?.lines.length ? '♪ 前奏' : '暂无歌词'}
            </span>
          )}
        </button>
      ) : null}

      <div className="transport">
        <input
          className="slider"
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(player.currentTime, duration || 1)}
          style={{ ['--fill' as string]: `${progressPercent}%` }}
          onChange={(event) => player.seek(Number(event.target.value))}
          disabled={!track}
          aria-label="播放进度"
        />
        <div className="transport-time">
          <span>{formatDuration(player.currentTime)}</span>
          <div className="transport-center">
            <span className="speed-tag" data-playing={player.playing}>
              <span className="chip-dot" />
              {player.loadState === 'waiting'
                ? 'BUFFERING'
                : player.playing
                  ? '33⅓ RPM'
                  : 'STOPPED'}
            </span>
            {player.sleepAt > 0 ? (
              <span className="sleep-chip" title="睡眠定时进行中">
                <span className="chip-dot" />
                {formatClock(player.sleepLeft)}
              </span>
            ) : null}
            {duration > 0 ? (
              <span className="remaining">
                还剩 {formatDuration(remaining)}
                {player.playbackRate !== 1 ? <em> · {formatRate(player.playbackRate)}</em> : null}
              </span>
            ) : null}
          </div>
          <span>{formatDuration(duration)}</span>
        </div>

        <div className="transport-controls">
          <button
            className="icon-btn"
            data-active={player.repeat !== 'off'}
            onClick={player.cycleRepeat}
            title={
              player.repeat === 'off'
                ? '循环：关闭'
                : player.repeat === 'all'
                  ? '循环：列表'
                  : '循环：单曲'
            }
          >
            <RepeatGlyph size={17} />
          </button>
          <button
            className="icon-btn"
            data-active={player.shuffle}
            onClick={player.toggleShuffle}
            title={
              player.shuffle
                ? `随机播放：开${player.repeat === 'off' ? '（播完即停）' : ''}`
                : '随机播放：关'
            }
          >
            <ShuffleIcon size={17} />
          </button>
          <button
            className="icon-btn"
            onClick={onShowQueue}
            title={`播放列表（${player.queue.length} 首）`}
          >
            <ListIcon size={17} />
          </button>
          <button className="icon-btn" onClick={player.prev} disabled={!track} title="上一首">
            <PrevIcon size={18} />
          </button>
          <button
            className="play-button"
            onClick={player.toggle}
            disabled={!track}
            title={player.loadState === 'waiting' ? '正在准备，点击可立即播放' : player.playing ? '暂停' : '播放'}
          >
            {player.loadState === 'waiting' ? (
              <span className="play-button-spinner" />
            ) : player.playing ? (
              <PauseIcon size={22} />
            ) : (
              <PlayIcon size={22} />
            )}
          </button>
          <button className="icon-btn" onClick={player.next} disabled={!track} title="下一首">
            <NextIcon size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={player.toggleMute}
            title={player.muted ? '取消静音' : '静音'}
          >
            {player.muted ? <MuteIcon size={17} /> : <VolumeIcon size={17} />}
          </button>
          <button
            className="icon-btn rate-btn"
            onClick={() => player.cyclePlaybackRate()}
            title={`倍速 ${formatRate(player.playbackRate)}，点击切换`}
          >
            {formatRate(player.playbackRate)}
          </button>
          <div className="sleep-wrap">
            <button
              className="icon-btn"
              data-active={player.sleepAt > 0}
              onClick={() => setSleepOpen((prev) => !prev)}
              title={player.sleepAt > 0 ? `睡眠定时 ${formatClock(player.sleepLeft)} 后停止` : '睡眠定时'}
            >
              <MoonIcon size={16} />
            </button>
            {sleepOpen ? (
              <div className="sleep-menu">
                {SLEEP_PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    onClick={() => {
                      player.setSleep(minutes)
                      setSleepOpen(false)
                    }}
                  >
                    {minutes} 分钟
                  </button>
                ))}
                <button
                  onClick={() => {
                    player.setSleep(null)
                    setSleepOpen(false)
                  }}
                >
                  取消定时
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="volume-row">
          <button
            className="icon-btn"
            onClick={player.toggleMute}
            title={player.muted ? '取消静音' : '静音'}
          >
            {player.muted ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeValue}
            style={{ ['--fill' as string]: `${volumeValue * 100}%` }}
            onChange={(event) => player.setVolume(Number(event.target.value))}
            aria-label="音量"
          />
          <span className="transport-time" style={{ margin: 0, minWidth: 30 }}>
            {Math.round(volumeValue * 100)}
          </span>
        </div>
      </div>
    </aside>
  )
}
