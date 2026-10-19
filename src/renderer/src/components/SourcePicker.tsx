/**
 * 搜索框旁的源选择器。
 *
 * 只列支持站内搜索的源：yt-dlp 给上千个站点做了下载支持，但真正有搜索
 * 接口的只有寥寥几个（判据是 yt-dlp 里的 _SEARCH_KEY）。把不能搜的源放进
 * 这个下拉里，用户点了只会收到一句报错。
 *
 * 不支持搜索的站点照样能用——粘贴链接即可，只是不出现在这里。
 */
import { useEffect, useRef, useState } from 'react'
import type { MediaSource } from '@shared/types'

interface SourcePickerProps {
  sources: MediaSource[]
  activeId: string
  onSelect: (id: string) => void
  /** 打开「设置 → 内容源」并直接展开添加表单 */
  onManage: () => void
}

export function SourcePicker({ sources, activeId, onSelect, onManage }: SourcePickerProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const searchable = sources.filter((source) => Boolean(source.searchKey))
  const active = searchable.find((source) => source.id === activeId) ?? searchable[0]

  // 点外面或按 Esc 收起；不处理的话菜单会一直挂着
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!active) return null

  return (
    <div className="source-wrap" ref={wrapRef}>
      <button
        className="source-btn"
        onClick={() => setOpen((prev) => !prev)}
        title={`当前源：${active.name}\n${active.note}`}
      >
        <span className="source-dot" style={{ background: active.accent }} />
        <span className="source-name">{active.name}</span>
        <span className="source-caret" />
      </button>

      {open ? (
        <div className="source-menu">
          <div className="source-menu-head">搜索源</div>
          {searchable.map((source) => (
            <button
              key={source.id}
              className="source-option"
              data-active={source.id === active.id}
              onClick={() => {
                onSelect(source.id)
                setOpen(false)
              }}
            >
              <span className="source-dot" style={{ background: source.accent }} />
              <span className="source-option-body">
                <span className="source-option-name">{source.name}</span>
                <span className="source-option-note">{source.note}</span>
              </span>
            </button>
          ))}
          <button
            className="source-menu-action"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            ＋ 添加自定义源
          </button>
          <div className="source-menu-foot">
            这里只列支持站内搜索的源。其余站点直接粘贴链接也能缓存；
            自建的源填了搜索键就会出现在上面。
          </div>
        </div>
      ) : null}
    </div>
  )
}
