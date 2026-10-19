import { useEffect, useState } from 'react'
import type { InstallProgress, ToolStatus } from '@shared/types'
import {
  CloseIcon,
  MaximizeIcon,
  MiniIcon,
  MinimizeIcon,
  PowerIcon,
  RefreshIcon,
  RestoreIcon
} from './icons'

interface TitleBarProps {
  status: ToolStatus | null
  progress: InstallProgress | null
  onInstall: () => void
  onToggleMini: () => void
}

export function TitleBar({ status, progress, onInstall, onToggleMini }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.vinyl.window.isMaximized().then((res) => {
      if (res.ok) setMaximized(res.data)
    })
    return window.vinyl.window.onMaximizedChange(setMaximized)
  }, [])

  const ready = Boolean(status?.ytDlpReady)
  const installing = Boolean(status?.installing)
  const state = ready ? 'ok' : 'warn'
  const label = installing
    ? (progress?.step ?? '正在初始化组件…')
    : ready
      ? (status?.ytDlpLabel ?? '组件就绪')
      : '组件未安装'
  const percent = Math.round((progress?.ratio ?? 0) * 100)

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-dot" />
        Vinyl<span>Box</span>
      </div>

      <div className="titlebar-spacer" />

      <div className="titlebar-tools">
        <span className="chip" data-state={state} title={status?.ytDlpLabel ?? ''}>
          <span className="chip-dot" />
          {label}
        </span>
        {!ready || installing ? (
          <button className="btn btn-sm" onClick={onInstall} disabled={installing}>
            {installing ? (
              <RefreshIcon size={13} className="spin" />
            ) : (
              <PowerIcon size={13} />
            )}
            {installing ? `初始化 ${percent}%` : '初始化组件'}
          </button>
        ) : null}
      </div>

      <div className="window-controls">
        <button className="window-btn" onClick={onToggleMini} title="精简浮窗">
          <MiniIcon size={14} />
        </button>
        <button
          className="window-btn"
          onClick={() => void window.vinyl.window.minimize()}
          title="最小化"
        >
          <MinimizeIcon size={15} />
        </button>
        <button
          className="window-btn"
          onClick={() => void window.vinyl.window.toggleMaximize()}
          title={maximized ? '还原' : '最大化'}
        >
          {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={13} />}
        </button>
        <button
          className="window-btn"
          data-close="true"
          onClick={() => void window.vinyl.window.close()}
          title="关闭"
        >
          <CloseIcon size={15} />
        </button>
      </div>
    </header>
  )
}
