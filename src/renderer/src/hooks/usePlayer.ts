import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlaybackSnapshot, RepeatMode, Track } from '@shared/types'
import {
  cycleRate as nextRate,
  nearestRate,
  resumePosition,
  sequentialOrder,
  shuffleOrder,
  sleepDeadline,
  sleepRemainingSeconds,
  stepPosition
} from '@shared/portable/playback'
import { mediaUrl, streamUrl } from '@/utils/format'

export type { RepeatMode }

/**
 * 播放准备状态。
 * 流式曲目出声前要先解析直链、再攒一段缓冲，这段时间必须让界面看得出来，
 * 否则用户只看到「在播放」却听不到声音，无从判断是不是卡住了。
 */
export type LoadState = 'idle' | 'waiting' | 'error'

/** 预缓冲目标：攒够这么多秒再出声，避开开头最容易断续的一段 */
const PREBUFFER_SECONDS = 30
/** 最长等待，超时就先播，宁可偶尔卡一下也不干等 */
const PREBUFFER_TIMEOUT = 20_000

/** 已落盘走本地协议，尚未落盘走流式协议，于是下载过程中也能播放 */
function playbackSource(track: Track): string {
  return track.fileName
    ? mediaUrl(track.fileName)
    : streamUrl(track.id, track.sourceId, track.url, track.referer)
}

/** 当前播放位置之后连续可用的缓冲秒数 */
function bufferedAhead(audio: HTMLAudioElement): number {
  const ranges = audio.buffered
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= audio.currentTime + 0.5 && ranges.end(index) > audio.currentTime) {
      return ranges.end(index) - audio.currentTime
    }
  }
  return 0
}

export interface PlayerApi {
  current: Track | null
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  repeat: RepeatMode
  /** 随机播放：与循环模式独立 */
  shuffle: boolean
  queue: Track[]
  /** 同上，但按实际播放顺序排列（随机模式下已打乱） */
  orderedQueue: Track[]
  /** 跳到播放顺序里的第几项 */
  jumpTo: (position: number) => void
  /** 出声前的准备状态，'waiting' 时界面应展示阶段与缓冲进度 */
  loadState: LoadState
  /** 已缓冲秒数 */
  buffered: number
  /** 预缓冲目标秒数 */
  prebuffer: number
  loadError: string | null
  /** 播放倍速 */
  playbackRate: number
  setPlaybackRate: (rate: number) => void
  /** 在倍速档位之间循环，供「点一下换个速度」的交互 */
  cyclePlaybackRate: (direction?: number) => void
  /** 睡眠定时的截止时间戳，0 表示未开启 */
  sleepAt: number
  /** 睡眠剩余秒数，0 表示未开启 */
  sleepLeft: number
  setSleep: (minutes: number | null) => void
  play: (track: Track, queue?: Track[]) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  cycleRepeat: () => void
  /** 开 / 关随机播放 */
  toggleShuffle: () => void
  stop: () => void
  /** 按上次的播放现场还原：曲目、进度、音量、循环模式与队列 */
  restore: (snapshot: PlaybackSnapshot, library: Track[]) => void
  /** 流式播放的曲目落盘后，无缝换成同名的本地文件 */
  adopt: (track: Track) => void
}

export function usePlayer(onPlayed?: (track: Track) => void): PlayerApi {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Track[]>([])
  const indexRef = useRef(-1)
  const repeatRef = useRef<RepeatMode>('off')
  /**
   * 播放顺序：随机模式下是打乱的索引序列，否则就是 0..n-1。
   * 走「下一首」按的是它，而不是队列原始顺序。
   */
  const orderRef = useRef<number[]>([])
  /** 当前曲目在播放顺序里的位置 */
  const orderPosRef = useRef(0)
  const shuffleRef = useRef(false)
  const playedCallback = useRef(onPlayed)
  /** 取消当前正在进行的预缓冲等待 */
  const bufferJobRef = useRef<(() => void) | null>(null)
  /** 取下一首：prepare 阶段比 step 先定义，用 ref 转一道 */
  const stepRef = useRef<(delta: number) => void>(() => undefined)
  /** 连续几条都取不到音频就停下来报错，免得整张列表一路跳过去 */
  const errorStreakRef = useRef(0)

  const [current, setCurrent] = useState<Track | null>(null)
  const [queue, setQueue] = useState<Track[]>([])
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.85)
  const [muted, setMuted] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [shuffle, setShuffle] = useState(false)
  /** 当前播放顺序的副本，供播放列表面板渲染（ref 变化不会触发重渲染） */
  const [order, setOrder] = useState<number[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [buffered, setBuffered] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [playbackRate, setRateState] = useState(1)
  const [sleepAt, setSleepAt] = useState(0)
  const [sleepLeft, setSleepLeft] = useState(0)
  /** 倍速与音量各存一份引用，回调和定时器里读到的都是最新值 */
  const rateRef = useRef(1)
  const volumeRef = useRef(0.85)

  playedCallback.current = onPlayed

  /**
   * 倍速：统一吸附到受支持的档位，避免 1.0000001 这种脏值。
   * 改完立刻作用于当前 audio，正在播的歌也会马上变速。
   */
  const setPlaybackRate = useCallback((rate: number) => {
    const next = nearestRate(rate)
    rateRef.current = next
    setRateState(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }, [])

  const cyclePlaybackRate = useCallback(
    (direction = 1) => setPlaybackRate(nextRate(rateRef.current, direction)),
    [setPlaybackRate]
  )

  const setSleep = useCallback((minutes: number | null) => {
    setSleepAt(minutes && minutes > 0 ? sleepDeadline(minutes) : 0)
  }, [])

  /**
   * 睡眠定时：到点先把音量淡出到 0 再停，不会戛然而止。
   * 淡出用的是递减 interval，停掉之后把音量还给用户。
   */
  useEffect(() => {
    if (!sleepAt) {
      setSleepLeft(0)
      return
    }
    let fadeTimer = 0
    const tick = (): void => {
      const left = sleepRemainingSeconds(sleepAt)
      if (left > 0) {
        setSleepLeft(left)
        return
      }
      setSleepAt(0)
      setSleepLeft(0)

      const audio = audioRef.current
      if (!audio) return
      let volume = audio.volume
      fadeTimer = window.setInterval(() => {
        volume = Math.max(0, volume - 0.04)
        audio.volume = volume
        if (volume > 0) return
        window.clearInterval(fadeTimer)
        audio.pause()
        audio.volume = volumeRef.current
      }, 100)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(fadeTimer)
    }
  }, [sleepAt])

  /** 攒够一段再出声；超时或出错都会放行，不把界面卡死 */
  const waitForBuffer = useCallback((audio: HTMLAudioElement, onReady: () => void) => {
    bufferJobRef.current?.()
    let settled = false
    let timer = 0

    const cleanup = (): void => {
      window.clearTimeout(timer)
      audio.removeEventListener('progress', check)
      audio.removeEventListener('loadedmetadata', check)
      audio.removeEventListener('canplaythrough', check)
      audio.removeEventListener('error', onError)
      bufferJobRef.current = null
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      errorStreakRef.current = 0
      cleanup()
      onReady()
    }

    const onError = (): void => {
      if (settled) return
      settled = true
      cleanup()
      // 这一条取不到就试下一条：网络抖动、直链过期、内容被删都常见，
      // 卡在原地等用户手动点是没必要的。连续失败超过两首才真的报错。
      errorStreakRef.current += 1
      if (errorStreakRef.current <= 2 && queueRef.current.length > 1) {
        setLoadState('idle')
        stepRef.current(1)
        return
      }
      setLoadState('error')
      setLoadError('音频流获取失败，请检查网络或代理设置')
    }

    function check(): void {
      const ahead = bufferedAhead(audio)
      const total = Number.isFinite(audio.duration) ? audio.duration : 0
      const need = total > 0 ? Math.min(PREBUFFER_SECONDS, total) : PREBUFFER_SECONDS
      setBuffered(ahead)
      // 够目标，或者整首已经拉完（短音频不硬等 30 秒）
      if (ahead >= need || (total > 0 && ahead >= total - 0.5)) finish()
    }

    timer = window.setTimeout(() => {
      check()
      finish()
    }, PREBUFFER_TIMEOUT)

    audio.addEventListener('progress', check)
    audio.addEventListener('loadedmetadata', check)
    audio.addEventListener('canplaythrough', check)
    audio.addEventListener('error', onError)
    bufferJobRef.current = cleanup
    check()
  }, [])

  const startTrack = useCallback(
    (track: Track, autoplay = true) => {
      const audio = audioRef.current
      if (!audio) return
      bufferJobRef.current?.()
      // 流式播放要主动多拉一些，不然容易播到一半断掉
      audio.preload = 'auto'
      audio.src = playbackSource(track)
      audio.currentTime = 0
      audio.playbackRate = rateRef.current
      setCurrent(track)
      setCurrentTime(0)
      setDuration(track.duration || 0)
      setBuffered(0)
      setLoadError(null)

      if (track.fileName) {
        // 本地文件随即就能播，不需要等待
        setLoadState('idle')
        if (autoplay) void audio.play().catch(() => setPlaying(false))
        return
      }

      // 流式：先解析直链再攒一段缓冲，这期间不出声
      setLoadState('waiting')
      waitForBuffer(audio, () => {
        setLoadState('idle')
        if (autoplay) void audio.play().catch(() => setPlaying(false))
      })
    },
    [waitForBuffer]
  )

  /**
   * 重建播放顺序，并把游标对准当前这首。
   * 队列变了（删歌、流式落盘换成本地文件）或切换随机模式时都要重来一次。
   */
  const syncOrder = useCallback((currentIndex: number) => {
    const total = queueRef.current.length
    const order = shuffleRef.current ? shuffleOrder(total, currentIndex) : sequentialOrder(total)
    orderRef.current = order
    orderPosRef.current = Math.max(0, order.indexOf(currentIndex))
    setOrder(order)
  }, [])

  const step = useCallback(
    (delta: number) => {
      const list = queueRef.current
      if (!list.length) return
      if (orderRef.current.length !== list.length) syncOrder(indexRef.current)
      const order = orderRef.current
      // 循环关着时走到尽头就停住；单曲循环与随机互不冲突，各管各的
      const next = stepPosition(
        order.length,
        orderPosRef.current,
        delta,
        repeatRef.current !== 'off'
      )
      if (next < 0) return
      orderPosRef.current = next
      indexRef.current = order[next]
      startTrack(list[order[next]])
    },
    [startTrack, syncOrder]
  )
  stepRef.current = step

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.volume = 0.85
    audioRef.current = audio

    const handleTime = (): void => setCurrentTime(audio.currentTime)
    const handleMeta = (): void => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration)
    }
    // 播放中不再跟踪缓冲：progress 触发频率高，会让整个界面反复重渲染
    const handlePlay = (): void => setPlaying(true)
    const handlePause = (): void => setPlaying(false)
    const handleEnded = (): void => {
      if (repeatRef.current === 'one') {
        audio.currentTime = 0
        void audio.play()
        return
      }
      // 「到头了」按播放顺序算：随机模式下它是打乱后的序列，不是队列原顺序
      const atEnd = orderPosRef.current >= orderRef.current.length - 1
      if (atEnd && repeatRef.current === 'off') {
        setPlaying(false)
        return
      }
      stepRef.current(1)
    }

    audio.addEventListener('timeupdate', handleTime)
    audio.addEventListener('loadedmetadata', handleMeta)
    audio.addEventListener('durationchange', handleMeta)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', handleTime)
      audio.removeEventListener('loadedmetadata', handleMeta)
      audio.removeEventListener('durationchange', handleMeta)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      bufferJobRef.current?.()
      audio.pause()
      audio.src = ''
    }
  }, [step])

  const play = useCallback(
    (track: Track, nextQueue?: Track[]) => {
      const list = nextQueue && nextQueue.length ? nextQueue : queueRef.current
      const resolved = list.some((t) => t.id === track.id) ? list : [track, ...list]
      queueRef.current = resolved
      setQueue(resolved)
      indexRef.current = resolved.findIndex((t) => t.id === track.id)
      // 队列换了就重排播放顺序；随机模式下把点的这首放到最前，免得刚开就跳走
      syncOrder(indexRef.current)
      startTrack(track)
      playedCallback.current?.(track)
    },
    [startTrack, syncOrder]
  )

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    if (audio.paused) {
      // 还在等缓冲的话就不等了，先把声音放出来
      bufferJobRef.current?.()
      setLoadState('idle')
      void audio.play().catch(() => undefined)
    } else {
      audio.pause()
    }
  }, [current])

  const seek = useCallback((time: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || time))
    setCurrentTime(audio.currentTime)
    setBuffered(bufferedAhead(audio))
  }, [])

  const setVolume = useCallback((value: number) => {
    const audio = audioRef.current
    const clamped = Math.max(0, Math.min(1, value))
    if (audio) {
      audio.volume = clamped
      audio.muted = clamped === 0
    }
    volumeRef.current = clamped
    setVolumeState(clamped)
    setMuted(clamped === 0)
  }, [])

  const toggleMute = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audio.muted
    setMuted(audio.muted)
  }, [])

  const cycleRepeat = useCallback(() => {
    setRepeat((prev) => {
      const order: RepeatMode[] = ['off', 'all', 'one']
      const next = order[(order.indexOf(prev) + 1) % order.length]
      repeatRef.current = next
      return next
    })
  }, [])

  /** 随机播放：与循环模式是两个维度，可以同时开着 */
  const toggleShuffle = useCallback(() => {
    setShuffle((prev) => {
      const next = !prev
      shuffleRef.current = next
      // 立刻重排，这样当前这首不会因为开了随机而被跳过
      syncOrder(indexRef.current)
      return next
    })
  }, [syncOrder])

  /** 按实际播放顺序排好的队列：随机模式下看到的就是打乱后的顺序 */
  const orderedQueue = useMemo(() => {
    if (!queue.length) return []
    const sequence = order.length === queue.length ? order : queue.map((_, index) => index)
    return sequence
      .map((index) => queue[index])
      .filter((track): track is Track => Boolean(track))
  }, [queue, order])

  /** 跳到播放顺序里的第 position 项：播放列表面板点哪首就播哪首 */
  const jumpTo = useCallback(
    (position: number) => {
      const list = queueRef.current
      if (!list.length) return
      if (orderRef.current.length !== list.length) syncOrder(indexRef.current)
      const sequence = orderRef.current
      const at = Math.max(0, Math.min(position, sequence.length - 1))
      const track = list[sequence[at]]
      if (!track) return
      orderPosRef.current = at
      indexRef.current = sequence[at]
      startTrack(track)
      playedCallback.current?.(track)
    },
    [startTrack, syncOrder]
  )

  const stop = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    bufferJobRef.current?.()
    audio.pause()
    audio.src = ''
    setCurrent(null)
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setBuffered(0)
    setLoadState('idle')
    setLoadError(null)
  }, [])

  /**
   * 边下边听期间曲目落盘了，就把数据源换成本地文件。
   * 保留当前进度与播放状态，用户几乎察觉不到这一下切换。
   */
  const adopt = useCallback((track: Track) => {
    const audio = audioRef.current
    if (!audio || !track.fileName) return
    bufferJobRef.current?.()
    setLoadState('idle')
    setBuffered(0)
    const at = audio.currentTime
    const wasPlaying = !audio.paused
    audio.src = mediaUrl(track.fileName)
    setCurrent(track)
    const apply = (): void => {
      audio.removeEventListener('loadedmetadata', apply)
      const total = audio.duration
      const next = Number.isFinite(total) ? Math.min(at, Math.max(total - 0.5, 0)) : at
      audio.currentTime = next
      setCurrentTime(next)
      if (wasPlaying) void audio.play().catch(() => undefined)
    }
    audio.addEventListener('loadedmetadata', apply)
  }, [])

  /**
   * 还原上次的播放现场。
   * 只把曲目与进度就位，保持暂停状态，避免打开程序就突然出声。
   */
  const restore = useCallback((snapshot: PlaybackSnapshot, library: Track[]) => {
    const element = audioRef.current
    if (!element || !snapshot.trackId) return
    // 固定为非空引用，避免嵌套回调里的空值告警
    const audio: HTMLAudioElement = element
    const track = library.find((item) => item.id === snapshot.trackId)
    if (!track) return

    const restored = snapshot.queueIds
      .map((id) => library.find((item) => item.id === id))
      .filter((item): item is Track => Boolean(item))
    const queueTracks = restored.some((item) => item.id === track.id)
      ? restored
      : [track, ...restored]

    queueRef.current = queueTracks
    indexRef.current = Math.max(
      0,
      queueTracks.findIndex((item) => item.id === track.id)
    )
    setQueue(queueTracks)
    syncOrder(indexRef.current)

    repeatRef.current = snapshot.repeat
    setRepeat(snapshot.repeat)
    shuffleRef.current = Boolean(snapshot.shuffle)
    setShuffle(Boolean(snapshot.shuffle))
    setVolumeState(snapshot.volume)
    setMuted(snapshot.muted)
    volumeRef.current = snapshot.volume
    audio.volume = snapshot.volume
    audio.muted = snapshot.muted
    audio.playbackRate = rateRef.current

    setCurrent(track)
    setDuration(track.duration || 0)
    setLoadState('idle')
    setLoadError(null)
    setBuffered(0)
    // 只预加载元数据时，seek 会被限制在已缓冲范围内，这里临时放开
    audio.preload = 'auto'
    audio.src = mediaUrl(track.fileName)

    // 断点续听：进度太靠前、或已经接近结尾，都视为从头开始
    const wantedBase = resumePosition(audio.duration || track.duration, snapshot.position)
    let attempts = 0
    let timer: number | null = null
    let settled = false

    const cleanup = (): void => {
      audio.removeEventListener('loadedmetadata', attempt)
      audio.removeEventListener('durationchange', attempt)
      audio.removeEventListener('canplay', attempt)
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }

    const schedule = (): void => {
      attempts += 1
      if (attempts > 12) {
        settled = true
        cleanup()
        return
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(attempt, 220)
    }

    function attempt(): void {
      if (settled) return
      const total = audio.duration
      if (!Number.isFinite(total) || total <= 0) {
        schedule()
        return
      }
      const wanted = Math.min(wantedBase, Math.max(total - 0.5, 0))
      audio.currentTime = wanted
      setCurrentTime(wanted)
      setDuration(total)
      // seek 可能被推迟到数据到位，校验一次再决定是否重试
      if (Math.abs(audio.currentTime - wanted) > 1.5) {
        schedule()
        return
      }
      settled = true
      cleanup()
      audio.preload = 'metadata'
    }

    audio.addEventListener('loadedmetadata', attempt)
    audio.addEventListener('durationchange', attempt)
    audio.addEventListener('canplay', attempt)
    schedule()
  }, [])

  return {
    current,
    playing,
    currentTime,
    duration,
    volume,
    muted,
    repeat,
    shuffle,
    queue,
    orderedQueue,
    jumpTo,
    loadState,
    buffered,
    prebuffer: PREBUFFER_SECONDS,
    loadError,
    playbackRate,
    setPlaybackRate,
    cyclePlaybackRate,
    sleepAt,
    sleepLeft,
    setSleep,
    play,
    toggle,
    next: () => step(1),
    prev: () => step(-1),
    seek,
    setVolume,
    toggleMute,
    cycleRepeat,
    toggleShuffle,
    stop,
    restore,
    adopt
  }
}
