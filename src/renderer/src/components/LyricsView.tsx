import { useEffect, useMemo, useRef } from 'react'
import type { Lyrics, TranscribeState } from '@shared/types'
import { DiscIcon, RefreshIcon, SparkIcon } from './icons'

interface LyricsViewProps {
  lyrics: Lyrics | null
  loading: boolean
  currentTime: number
  transcribing: boolean
  transcribeState: TranscribeState | null
  onReload: () => void
  onTranscribe: () => void
  onToggleView: () => void
}

/** 根据播放进度算出当前行（要求歌词带时间轴） */
export function useActiveLyricIndex(lyrics: Lyrics | null, currentTime: number): number {
  return useMemo(() => {
    const lines = lyrics?.lines ?? []
    if (!lyrics?.synced || !lines.length) return -1
    let index = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time <= currentTime + 0.2) index = i
      else break
    }
    return index
  }, [lyrics, currentTime])
}

export function LyricsView({
  lyrics,
  loading,
  currentTime,
  transcribing,
  transcribeState,
  onReload,
  onTranscribe,
  onToggleView
}: LyricsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const activeIndex = useActiveLyricIndex(lyrics, currentTime)

  // 仅在当前行变化时滚动，避免进度回调把面板晃晕
  useEffect(() => {
    const node = activeRef.current
    const container = scrollRef.current
    if (!node || !container) return
    const target = node.offsetTop - container.clientHeight / 2 + node.clientHeight / 2
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [activeIndex])

  const sourceLabel = lyrics
    ? lyrics.source === 'lrclib'
      ? 'LRCLIB'
      : lyrics.source === 'youtube'
        ? 'YouTube 字幕'
        : lyrics.source === 'local'
          ? '本地识别'
          : ''
    : ''

  const renderBody = (): React.ReactNode => {
    if (loading) {
      return (
        <div className="lyrics-placeholder">
          <RefreshIcon size={20} className="spin" />
          <span>正在匹配歌词…</span>
        </div>
      )
    }

    if (transcribing) {
      return (
        <div className="lyrics-placeholder">
          <RefreshIcon size={20} className="spin" />
          <span>{transcribeState?.stage ?? '正在本地识别…'}</span>
          <div className="transcribe-progress">
            <span style={{ width: `${Math.round((transcribeState?.ratio ?? 0) * 100)}%` }} />
          </div>
          <span className="lyrics-hint">首次使用需要下载识别模型，之后可完全离线复用</span>
        </div>
      )
    }

    if (!lyrics || !lyrics.lines.length) {
      return (
        <div className="lyrics-placeholder">
          <span>暂无歌词</span>
          <span className="lyrics-hint">
            {lyrics?.note ?? '可能是纯音乐，或这首曲目还没有收录歌词'}
          </span>
          <div className="lyrics-actions">
            <button className="btn btn-sm" onClick={onReload}>
              <RefreshIcon size={13} />
              重新匹配
            </button>
            <button className="btn btn-sm btn-primary" onClick={onTranscribe}>
              <SparkIcon size={13} />
              本地识别
            </button>
          </div>
          <span className="lyrics-hint">
            本地识别完全离线，从音频中提取歌词；对歌声的准确度有限
          </span>
        </div>
      )
    }

    return (
      <>
        <div className="lyrics-scroll" ref={scrollRef}>
          <div className="lyrics-inner">
            {lyrics.lines.map((line, index) => (
              <div
                key={`${index}-${line.time}`}
                className="lyric-row"
                data-active={index === activeIndex}
                data-past={activeIndex >= 0 && index < activeIndex}
                ref={index === activeIndex ? activeRef : undefined}
              >
                <div className="lyric-text">{line.text}</div>
                {line.translation ? (
                  <div className="lyric-translation">{line.translation}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <div className="lyrics-footer">
          <span className="lyrics-source">
            {sourceLabel}
            {lyrics.translated ? ' · 中文翻译' : ''}
            {lyrics.matchedTitle ? ` · ${lyrics.matchedTitle}` : ''}
          </span>
          <button className="icon-btn" onClick={onReload} title="重新匹配歌词">
            <RefreshIcon size={13} />
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="lyrics-view">
      {renderBody()}
      <button className="stage-toggle" onClick={onToggleView} title="回到唱片">
        <DiscIcon size={15} />
      </button>
    </div>
  )
}
