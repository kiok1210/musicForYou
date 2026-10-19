import { useEffect, useState, type FormEvent } from 'react'
import type {
  CategoryInput,
  CategorySummary,
  ContentKind,
  DiscoverBatch,
  MediaSource
} from '@shared/types'
import { formatDuration, formatRelative, cleanTitle } from '@/utils/format'
import { ChevronIcon, CloseIcon, PrevIcon, RefreshIcon, SparkIcon } from './icons'

interface DiscoverPanelProps {
  categories: CategorySummary[]
  activeId: string | null
  loading: boolean
  onDiscover: (categoryId: string) => void
  /** 每次发现的结果快照，换了关键词之后靠它找回上一批 */
  history: DiscoverBatch[]
  /** 全部源：历史批次用它的配色画出源色点，一眼认出哪批来自哪站 */
  sources: MediaSource[]
  onOpenBatch: (batch: DiscoverBatch) => void
  /** 不传 id 表示清空 */
  onForgetBatch: (id?: string) => Promise<void>
  /** 返回 true 表示建好了，表单可以收起 */
  onAddCategory: (input: CategoryInput) => Promise<boolean>
  onRemoveCategory: (categoryId: string) => void
}

/** 现成的填法示例，音乐与有声书各给两个，顺带演示「类型」怎么选 */
const PRESETS: CategoryInput[] = [
  {
    name: '粤语老歌',
    blurb: '八九十年代的港乐金曲',
    kind: 'music',
    keywords: ['粤语 经典 老歌', 'cantopop 80s 90s', '粤语金曲 合集']
  },
  {
    name: '游戏配乐',
    blurb: '战斗曲、地图 BGM 与主菜单音乐',
    kind: 'music',
    keywords: ['game ost music', '游戏原声 配乐', 'epic battle music']
  },
  {
    name: '历史故事',
    blurb: '上下五千年与人物评说',
    kind: 'audiobook',
    keywords: ['历史故事 有声', '中国历史 通史', '历史人物 评说']
  },
  {
    name: '悬疑小说',
    blurb: '推理、刑侦与心理悬疑',
    kind: 'audiobook',
    keywords: ['悬疑小说 有声', '推理小说 全集', '刑侦 有声书']
  }
]

/**
 * 分类发现：音乐与有声书分成两个大区各自平铺。
 * 每个分类既是「一键搜一批」的入口，也显示该分类已经缓存了多少
 * （分类名本身就是标签，数据来自标签统计）。
 */
export function DiscoverPanel({
  categories,
  activeId,
  loading,
  history,
  sources,
  onDiscover,
  onOpenBatch,
  onForgetBatch,
  onAddCategory,
  onRemoveCategory
}: DiscoverPanelProps) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [blurb, setBlurb] = useState('')
  const [kind, setKind] = useState<ContentKind>('music')
  /** 展开了一级分类的小类列表时的分类 id，null 表示停在分类墙 */
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 小类列表里按 Esc 也能回到分类墙，与搜索结果页的行为一致
  useEffect(() => {
    if (!expandedId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedId])

  const reset = (): void => {
    setName('')
    setKeywords('')
    setBlurb('')
    setKind('music')
    setAdding(false)
  }

  const applyPreset = (preset: CategoryInput): void => {
    setName(preset.name)
    setBlurb(preset.blurb)
    setKeywords(preset.keywords.join('，'))
    setKind(preset.kind ?? 'music')
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const list = keywords
      .split(/[\n,，、]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    const created = await onAddCategory({
      name: name.trim(),
      blurb: blurb.trim(),
      keywords: list,
      kind
    })
    if (created) reset()
  }

  const renderCards = (list: CategorySummary[]) =>
    list.map((category) => {
      const busy = activeId === category.id && loading
      return (
        <button
          key={category.id}
          className="category-card"
          data-active={activeId === category.id}
          style={{ ['--accent' as string]: category.accent }}
          onClick={() => onDiscover(category.id)}
          disabled={busy}
          title={`用「${category.keywords[0]}」等关键词搜索`}
        >
          <span className="category-head">
            <span className="category-name">{category.name}</span>
            {category.count > 0 ? (
              <span className="category-badge">{category.count}</span>
            ) : null}
            {busy ? <RefreshIcon size={12} className="spin" /> : null}
          </span>
          <span className="category-blurb">{category.blurb}</span>
          <span className="category-foot">
            {category.count > 0
              ? `已缓存 ${category.count} 首 · ${formatDuration(category.duration)}`
              : '点击发现一批'}
          </span>

          {category.subcategories?.length ? (
            <span
              className="category-expand"
              role="button"
              tabIndex={0}
              title={`展开 ${category.subcategories.length} 个小类`}
              onClick={(event) => {
                event.stopPropagation()
                setExpandedId(category.id)
              }}
            >
              <ChevronIcon size={11} />
              <em>{category.subcategories.length}</em>
            </span>
          ) : null}

          {category.custom ? (
            <span
              className="category-del"
              role="button"
              tabIndex={0}
              title="删除这个分类"
              onClick={(event) => {
                event.stopPropagation()
                if (window.confirm(`删除分类「${category.name}」？已缓存的歌不会被删除。`)) {
                  onRemoveCategory(category.id)
                }
              }}
            >
              <CloseIcon size={11} />
            </span>
          ) : null}
        </button>
      )
    })

  if (!categories.length) {
    return (
      <div className="empty">
        <SparkIcon size={22} />
        <strong>分类目录加载中…</strong>
      </div>
    )
  }

  // 展开了某个一级分类的小类列表时，整块替换成二级视图
  const expanded = expandedId
    ? categories.find((category) => category.id === expandedId)
    : undefined

  if (expanded) {
    const subs = expanded.subcategories ?? []
    return (
      <div className="category-stack">
        <div className="list-toolbar">
          <button
            className="btn btn-back"
            onClick={() => setExpandedId(null)}
            title="返回分类墙（Esc）"
          >
            <PrevIcon size={14} />
            返回分类墙
          </button>
          <span className="list-toolbar-text">
            {expanded.name} · {subs.length} 个小类
          </span>
        </div>

        {subs.length ? (
          <div className="sub-grid">
            {subs.map((sub) => (
              <button
                key={sub.id}
                className="sub-card"
                onClick={() => onDiscover(sub.id)}
                title={`用「${sub.keywords[0]}」等关键词搜索`}
              >
                <span className="sub-name">{sub.name}</span>
                <span className="sub-keywords">{sub.keywords[0]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">
            <strong>这个分类还没有小类</strong>
            <div className="empty-hint">返回分类墙看看别的。</div>
          </div>
        )}
      </div>
    )
  }

  // 用「不是有声书」来判定音乐：万一有分类缺 kind 字段，也不会两边都落空
  const music = categories.filter((category) => category.kind !== 'audiobook')
  const books = categories.filter((category) => category.kind === 'audiobook')

  return (
    <div className="category-stack">
      {history.length ? (
        <section className="category-section">
          <header className="category-section-head">
            <h3>最近发现</h3>
            <span>
              每批都存着，随时翻回来 ·{' '}
              <button className="history-clear" onClick={() => void onForgetBatch()}>
                清空
              </button>
            </span>
          </header>
          <div className="history-list">
            {history.map((batch) => (
              <div key={batch.id} className="history-row">
                <button
                  className="history-open"
                  onClick={() => onOpenBatch(batch)}
                  title={`回看这一批：${batch.query}`}
                >
                  <span className="history-main">
                    <span className="history-name">{batch.categoryName}</span>
                    <span className="history-query">{batch.query}</span>
                    {/* 内容摘要：分类、查询词、时间都一样时，靠它分清两批 */}
                    {batch.tracks.length ? (
                      <span className="history-peek">
                        {batch.tracks
                          .slice(0, 3)
                          .map((track) => cleanTitle(track.title))
                          .join(' · ')}
                        {batch.tracks.length > 3 ? ` 等 ${batch.tracks.length} 首` : ''}
                      </span>
                    ) : null}
                  </span>
                  <span className="history-meta">
                    {batch.tracks.length} 首 · {formatRelative(batch.createdAt)}
                    {batch.sourceName ? (
                      <>
                        {' · '}
                        <span
                          className="history-dot"
                          style={{
                            background:
                              sources.find((source) => source.id === batch.sourceId)?.accent ??
                              'var(--text-mute)'
                          }}
                        />
                        {batch.sourceName}
                      </>
                    ) : null}
                  </span>
                </button>
                <button
                  className="icon-btn"
                  onClick={() => void onForgetBatch(batch.id)}
                  title="删除这一批"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="category-section">
        <header className="category-section-head">
          <h3>音乐</h3>
          <span>{music.length} 个分类</span>
        </header>
        <div className="category-grid">{renderCards(music)}</div>
      </section>

      <section className="category-section">
        <header className="category-section-head">
          <h3>有声书</h3>
          <span>{books.length} 个分类 · 倍速 / 睡眠定时 / 断点续听</span>
        </header>
        <div className="category-grid">{renderCards(books)}</div>
      </section>

      {adding ? (
        <form className="category-form" onSubmit={(event) => void submit(event)}>
          <div className="category-form-head">
            <span className="category-form-title">新建分类</span>
            <div className="category-form-actions">
              <button type="button" className="btn btn-sm" onClick={reset}>
                取消
              </button>
              <button type="submit" className="btn btn-sm btn-primary">
                添加
              </button>
            </div>
          </div>

          <div className="category-form-presets">
            <span className="category-form-hint">照着填：</span>
            {PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.name}
                className="tag-chip"
                title={`填入：${preset.keywords.join(' / ')}`}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="category-form-grid">
            <label className="category-field">
              <span>名称</span>
              <input
                className="field"
                placeholder="例如：粤语老歌"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </label>

            <label className="category-field">
              <span>类型</span>
              <div className="segmented">
                {(
                  [
                    ['music', '音乐'],
                    ['audiobook', '有声书']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className="segment"
                    data-active={kind === value}
                    onClick={() => setKind(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </label>

            <label className="category-field category-field-wide">
              <span>关键词</span>
              <input
                className="field"
                placeholder="例如：粤语 经典 老歌，cantopop 80s 90s"
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
              />
            </label>

            <label className="category-field category-field-wide">
              <span>描述</span>
              <input
                className="field"
                placeholder="例如：八九十年代的港乐金曲（可留空）"
                value={blurb}
                onChange={(event) => setBlurb(event.target.value)}
              />
            </label>
          </div>

          <div className="category-form-hint">
            关键词就是拿去搜 YouTube 的查询词，逗号分隔可以填多个——每点一次「发现」轮换一个，
            避免每次都看到同一批结果。名称本身也会成为标签，缓存的曲目会按它自动归类。
          </div>
        </form>
      ) : (
        <button className="category-card category-add" onClick={() => setAdding(true)}>
          <span className="category-add-icon">
            <SparkIcon size={14} />
          </span>
          <span className="category-name">自定义分类</span>
          <span className="category-blurb">选好类型、填名称和关键词就能用</span>
        </button>
      )}
    </div>
  )
}
