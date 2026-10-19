import { useEffect, useRef } from 'react'
import type { Track } from '@shared/types'
import { coverUrl } from '@/utils/format'
import { isMobileRuntime } from '@/mobile/bridge'

interface MediaSessionOptions {
  track: Track | null
  playing: boolean
  duration: number
  position: number
  onToggle: () => void
  onNext: () => void
  onPrev: () => void
  onSeek: (time: number) => void
}

/** 手机上才用系统媒体会话；桌面端交给 Electron 自己的窗口与媒体键 */
function usable(): boolean {
  return isMobileRuntime() && typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

/**
 * 把播放状态交给系统媒体会话（锁屏卡片、通知栏、耳机线控）。
 *
 * 这不只是为了好看：WebView 里的音频一旦被系统认定为「正在播放的媒体」，
 * 进程优先级会随之上调，切到后台或锁屏时才不至于被直接掐掉——
 * 这是手机端「后台还能听」的关键一步。
 *
 * 旁挂式设计：只读播放器的状态、只调它的动作，播放器本身不必知道手机的存在。
 */
export function useMediaSession(opts: MediaSessionOptions): void {
  const { track, playing, duration, position } = opts

  /**
   * 动作放 ref 里：调用方给的多半是内联函数（每次渲染都是新的），
   * 直接进依赖数组会让按钮反复解绑重绑，锁屏按下时正好撞上就失灵。
   */
  const actions = useRef({
    onToggle: opts.onToggle,
    onNext: opts.onNext,
    onPrev: opts.onPrev,
    onSeek: opts.onSeek
  })
  actions.current = {
    onToggle: opts.onToggle,
    onNext: opts.onNext,
    onPrev: opts.onPrev,
    onSeek: opts.onSeek
  }

  // 换曲目就换锁屏上的信息；封面用曲目自带的（没有就退回缩略图）
  useEffect(() => {
    if (!usable() || !track) return
    const art = track.coverName || track.thumbnail
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: 'VinylBox',
        artwork: art
          ? [{ src: coverUrl(track.coverName, track.thumbnail), sizes: '512x512' }]
          : []
      })
    } catch {
      /* 封面加载不了不该影响播放 */
    }
  }, [track])

  // 锁屏与通知栏上的按钮
  useEffect(() => {
    if (!usable()) return
    const session = navigator.mediaSession
    const bindings: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => actions.current.onToggle()],
      ['pause', () => actions.current.onToggle()],
      ['nexttrack', () => actions.current.onNext()],
      ['previoustrack', () => actions.current.onPrev()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') actions.current.onSeek(details.seekTime)
        }
      ]
    ]
    for (const [action, handler] of bindings) {
      // 个别动作系统可能不支持，抛错就跳过，不能因此中断整批注册
      try {
        session.setActionHandler(action, handler)
      } catch {
        /* 忽略不支持的动作 */
      }
    }
    return () => {
      for (const [action] of bindings) {
        try {
          session.setActionHandler(action, null)
        } catch {
          /* 同上 */
        }
      }
    }
    // 只注册一次：回调走 ref，不必因调用方给了新函数就重绑
  }, [])

  // 播放状态与进度：锁屏卡片的进度条据此刷新
  useEffect(() => {
    if (!usable()) return
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    if (!playing || !duration || !Number.isFinite(duration) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(position, duration)),
        playbackRate: 1
      })
    } catch {
      /* 位置状态只是提示，给不了就算了 */
    }
  }, [playing, duration, position])
}
