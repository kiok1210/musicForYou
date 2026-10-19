import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { LyricLine, Lyrics, Track } from '@shared/types'
import { guessLanguageFromTitle } from '@shared/portable/subtitles'
import type { CacheStore } from './library'
import {
  ToolError,
  getFfmpegPath,
  pipInstallPackages,
  pickPython,
  pythonLibsDir,
  spawnProcess
} from './tools'

export type WhisperModelSize = 'tiny' | 'base' | 'small'

/** 运行期写入用户目录，省掉额外的打包配置 */
const TRANSCRIBE_SCRIPT = `"""本地语音识别：把音频转成带时间轴的歌词。"""
import json
import sys
import wave

import numpy as np


def fail(code, message):
    print(json.dumps({"error": message}, ensure_ascii=False))
    return code


def load_audio(path):
    """自己读 16kHz 单声道 wav，绕开 PyAV 的版本兼容问题。"""
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError("expected 16-bit PCM, got %d bytes per sample" % width)
    samples = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    audio = samples.astype(np.float32) / 32768.0
    if rate != 16000:
        raise ValueError("expected 16kHz audio, got %d" % rate)
    return audio


def main():
    if len(sys.argv) < 4:
        return fail(2, "usage: transcribe.py <audio> <model> <models_dir> [language]")
    audio_path, model_name, models_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    # 不指定语言时 Whisper 会把中文歌声意译成英文，所以能推断就带上提示
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        return fail(3, "MISSING_FASTER_WHISPER: %s" % exc)

    try:
        audio = load_audio(audio_path)
    except Exception as exc:
        return fail(6, "AUDIO_DECODE_FAILED: %s" % exc)

    try:
        model = WhisperModel(
            model_name, device="cpu", compute_type="int8", download_root=models_dir
        )
    except Exception as exc:
        return fail(4, "MODEL_LOAD_FAILED: %s" % exc)

    try:
        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
    except Exception as exc:
        return fail(5, "TRANSCRIBE_FAILED: %s" % exc)

    total = float(getattr(info, "duration", 0) or 0)
    collected = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            collected.append({
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            })
        sys.stderr.write("[progress] %.1f %.1f\\n" % (float(seg.end), total))
        sys.stderr.flush()

    json.dump(
        {
            "language": getattr(info, "language", None),
            "duration": total,
            "segments": collected,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
`

export interface TranscribeProgress {
  stage: string
  ratio: number
}

export interface TranscribeOptions {
  model: WhisperModelSize
  onProgress?: (progress: TranscribeProgress) => void
}

function scriptsDir(store: CacheStore): string {
  return path.join(store.root, 'scripts')
}

export function modelsDir(store: CacheStore): string {
  return path.join(store.root, 'models')
}



/** 国内直连 HuggingFace 不通，统一走镜像；Xet 存储镜像不支持，必须关掉 */
function pythonEnv(): Record<string, string> {
  return {
    PYTHONPATH: pythonLibsDir(),
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
    HF_HUB_DISABLE_XET: '1',
    HF_HUB_DOWNLOAD_TIMEOUT: '120',
    HF_HUB_DISABLE_TELEMETRY: '1'
  }
}

async function writeScript(store: CacheStore): Promise<string> {
  const dir = scriptsDir(store)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'transcribe.py')
  await fsp.writeFile(file, TRANSCRIBE_SCRIPT, 'utf8')
  return file
}

let installedCache: boolean | undefined

export async function isTranscriberInstalled(force = false): Promise<boolean> {
  if (!force && installedCache !== undefined) return installedCache
  const python = await pickPython()
  if (!python) {
    installedCache = false
    return false
  }
  const result = await spawnProcess(
    python.command,
    [...python.prefix, '-c', 'import faster_whisper'],
    { env: pythonEnv(), timeoutMs: 40_000 }
  )
  installedCache = result.code === 0
  return installedCache
}

export async function installTranscriber(onStep?: (step: string) => void): Promise<void> {
  const result = await pipInstallPackages(['faster-whisper'], (line) => {
    if (/^(Collecting|Downloading|Installing)/i.test(line.trim())) {
      onStep?.(line.trim().replace(/\s+/g, ' ').slice(0, 70))
    }
  })
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    throw new ToolError('PIP_FAILED', `识别组件安装失败：${tail || '未知错误'}`)
  }
  installedCache = undefined
  if (!(await isTranscriberInstalled(true))) {
    throw new ToolError('WHISPER_MISSING', '识别组件安装完成但未能加载')
  }
}

/** 转成 16kHz 单声道 wav —— Whisper 需要的输入格式 */
async function extractAudio(track: Track, store: CacheStore, target: string): Promise<void> {
  const ffmpeg = await getFfmpegPath()
  if (!ffmpeg) {
    throw new ToolError('FFMPEG_MISSING', '需要 ffmpeg 才能提取音频，请先初始化组件')
  }
  const result = await spawnProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.join(store.mediaDir, track.fileName),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      target
    ],
    { timeoutMs: 30 * 60 * 1000 }
  )
  if (result.code !== 0) {
    throw new ToolError('FFMPEG_FAILED', `音频提取失败：${result.stderr.slice(-200) || '未知错误'}`)
  }
}

/**
 * 本地语音识别。
 * 在线字幕拿不到时使用，完全离线，不依赖任何第三方服务。
 */
export async function transcribeTrack(
  track: Track,
  store: CacheStore,
  options: TranscribeOptions
): Promise<Lyrics> {
  const report = (stage: string, ratio: number): void =>
    options.onProgress?.({ stage, ratio })

  if (!(await isTranscriberInstalled())) {
    throw new ToolError('WHISPER_MISSING', '尚未安装本地识别组件，请先在设置中安装')
  }
  const python = await pickPython()
  if (!python) throw new ToolError('PYTHON_MISSING', '未检测到 Python 3')

  const models = modelsDir(store)
  const work = path.join(store.root, 'work')
  await fsp.mkdir(models, { recursive: true })
  await fsp.mkdir(work, { recursive: true })
  const wav = path.join(work, `${track.id}.wav`)
  const script = await writeScript(store)

  try {
    report('正在提取音频…', 0.02)
    await extractAudio(track, store, wav)

    report('正在加载识别模型…', 0.08)
    const expected = track.duration || 0
    // 不给提示时 Whisper 会把中文歌声直接意译成英文
    const hint = guessLanguageFromTitle(`${track.title} ${track.artist}`)
    const result = await spawnProcess(
      python.command,
      [...python.prefix, script, wav, options.model, models, hint ?? ''],
      {
        env: pythonEnv(),
        timeoutMs: 6 * 60 * 60 * 1000,
        onLine: (line) => {
          const match = /^\[progress\]\s+([\d.]+)\s+([\d.]+)/.exec(line)
          if (!match) return
          const done = Number(match[1])
          const total = Number(match[2]) || expected
          if (total > 0) {
            report(
              `正在识别 ${Math.floor(done)}s / ${Math.floor(total)}s`,
              0.08 + (done / total) * 0.9
            )
          }
        }
      }
    )

    if (result.code !== 0) {
      const raw = `${result.stdout}\n${result.stderr}`
      const tail = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(' ')
        .slice(0, 300)
      throw new ToolError('TRANSCRIBE_FAILED', `识别失败：${tail || '未知错误'}`)
    }

    const payload = JSON.parse(result.stdout) as {
      language?: string | null
      segments?: { start: number; text: string }[]
    }
    const lines: LyricLine[] = (payload.segments ?? [])
      .filter((segment) => Boolean(segment.text?.trim()))
      .map((segment) => ({
        time: Number(segment.start) || 0,
        text: segment.text.trim(),
        translation: null
      }))

    if (!lines.length) {
      throw new ToolError('TRANSCRIBE_EMPTY', '没有识别到人声，这首歌可能是纯音乐')
    }

    report('识别完成', 1)
    return {
      source: 'local',
      synced: true,
      language: payload.language ?? null,
      lines,
      translated: false,
      matchedTitle: null,
      matchedArtist: null,
      fetchedAt: Date.now()
    }
  } finally {
    await fsp.rm(wav, { force: true }).catch(() => undefined)
  }
}
