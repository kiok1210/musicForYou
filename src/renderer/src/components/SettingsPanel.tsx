import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  CacheStats,
  MediaSource,
  InstallProgress,
  ProbeResult,
  SourceAccount,
  SourceInput,
  ToolStatus
} from '@shared/types'
import { formatBytes } from '@/utils/format'
import { CloseIcon, FolderIcon, RefreshIcon, TrashIcon } from './icons'

interface SettingsPanelProps {
  settings: AppSettings
  stats: CacheStats | null
  status: ToolStatus | null
  /** 组件安装/更新的进度，null 表示空闲 */
  progress: InstallProgress | null
  /** 更新 yt-dlp 到最新版；结果提示由调用方给出 */
  onUpdateYtdlp: () => void
  netState: ProbeResult | null
  probing: boolean
  sources: MediaSource[]
  /** 返回是否添加成功，供表单决定要不要收起 */
  onAddSource: (input: SourceInput) => Promise<boolean>
  onRemoveSource: (id: string) => Promise<void>
  onChange: (patch: Partial<AppSettings>) => void
  onReprobe: () => void
  onClose: () => void
  onOpenDir: () => void
  onClearCache: () => void
  /** 从搜索框的源菜单跳进来时，直接展开添加表单 */
  openSourceForm: boolean
  /** 源 id → 登录态；只有登记了登录方式的源才有条目 */
  accounts: Record<string, SourceAccount>
  /** 打开某个源的扫码登录弹窗 */
  onOpenLogin: (sourceId: string) => void
  /** 退出某个源的登录：由调用方处理结果提示 */
  onLogout: (sourceId: string) => void
}

export function SettingsPanel({
  settings,
  stats,
  status,
  netState,
  probing,
  sources,
  onAddSource,
  onRemoveSource,
  onChange,
  onReprobe,
  onClose,
  onOpenDir,
  onClearCache,
  openSourceForm,
  accounts,
  onOpenLogin,
  onLogout,
  progress,
  onUpdateYtdlp
}: SettingsPanelProps) {
  const [appInfo, setAppInfo] = useState<{ version: string; userData: string } | null>(null)
  /** 手机端配套服务：端口与局域网地址 */
  const [apiInfo, setApiInfo] = useState<{
    port: number
    addresses: string[]
    running: boolean
  } | null>(null)
  const [proxyDraft, setProxyDraft] = useState(settings.proxy)
  // 设置面板每次打开都重新挂载，初始值就够用，不必再配一个 effect
  const [addingSource, setAddingSource] = useState(openSourceForm)
  const [copied, setCopied] = useState(false)
  const [sourceDraft, setSourceDraft] = useState({ name: '', hosts: '', searchKey: '' })

  const searchableSources = sources.filter((source) => Boolean(source.searchKey))
  /** 需要登录的源在这里给出入口；声明了 auth 的源会自动出现，新增源不必改这里 */
  const authSources = sources.filter((source) => source.auth === 'qrcode')

  const submitSource = useCallback(async () => {
    const hosts = sourceDraft.hosts
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    const okAdded = await onAddSource({
      name: sourceDraft.name.trim(),
      hosts,
      searchKey: sourceDraft.searchKey.trim(),
      home: ''
    })
    if (okAdded) {
      setSourceDraft({ name: '', hosts: '', searchKey: '' })
      setAddingSource(false)
    }
  }, [onAddSource, sourceDraft])

  useEffect(() => {
    void window.vinyl.app.info().then((res) => {
      if (res.ok) setAppInfo({ version: res.data.version, userData: res.data.userData })
    })
  }, [])

  // 手机 App 配对：显示本机的局域网地址，手机用其中之一连过来
  useEffect(() => {
    void window.vinyl.api.info().then((res) => {
      if (res.ok) setApiInfo(res.data)
    })
  }, [])

  useEffect(() => {
    setProxyDraft(settings.proxy)
  }, [settings.proxy])

  // 地址输入在失焦或回车时才提交，避免每次按键都触发探测
  const commitProxy = useCallback(() => {
    if (proxyDraft !== settings.proxy) onChange({ proxy: proxyDraft })
  }, [onChange, proxyDraft, settings.proxy])

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <section className="settings-panel">
        <header className="settings-head">
          <h3>设置</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="settings-group">
          <label className="settings-label">缓存音频格式</label>
          <select
            className="select"
            style={{ width: '100%' }}
            value={settings.audioFormat}
            onChange={(event) =>
              onChange({ audioFormat: event.target.value as AppSettings['audioFormat'] })
            }
          >
            <option value="m4a">M4A · 原始音轨，速度最快</option>
            <option value="mp3">MP3 · 兼容性最好，需转码</option>
          </select>
          <div className="settings-note">
            {settings.audioFormat === 'mp3' && !status?.ffmpegReady
              ? '当前未检测到 ffmpeg，切换到 MP3 前请先初始化组件。'
              : 'M4A 直接封装原始音轨，不损失质量也不消耗转码时间。'}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">搜索结果数量</label>
          <select
            className="select"
            style={{ width: '100%' }}
            value={String(settings.searchLimit)}
            onChange={(event) => onChange({ searchLimit: Number(event.target.value) })}
          >
            {[6, 12, 18, 24].map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
        </div>

        <div className="settings-group">
          <label className="settings-label">内容源</label>
          <div className="settings-note">
            搜索时默认走哪个源。标记了搜索键的源能直接搜关键词；没有的源
            yt-dlp 没做搜索接口，粘贴链接照样能缓存。
          </div>

          <select
            className="select"
            style={{ marginTop: 9 }}
            value={settings.source}
            onChange={(event) => onChange({ source: event.target.value })}
            title="默认搜索源"
          >
            {searchableSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>

          <div className="source-list">
            {sources.map((source) => (
              <div key={source.id} className="source-row">
                <span className="source-dot" style={{ background: source.accent }} />
                <span className="source-row-body">
                  <span className="source-row-name">
                    {source.name}
                    <em data-searchable={Boolean(source.searchKey)}>
                      {source.searchKey || '仅链接'}
                    </em>
                  </span>
                  <span className="source-row-note">{source.note}</span>
                </span>
                {source.custom ? (
                  <button
                    className="icon-btn"
                    onClick={() => void onRemoveSource(source.id)}
                    title="删除这个源"
                  >
                    <TrashIcon size={14} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          {addingSource ? (
            <div className="source-form">
              <div className="category-field">
                <span>名称</span>
                <input
                  className="field"
                  placeholder="例如：网易云音乐"
                  value={sourceDraft.name}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
              </div>
              <div className="category-field">
                <span>域名</span>
                <input
                  className="field"
                  placeholder="例如：music.163.com（多个用逗号隔开）"
                  value={sourceDraft.hosts}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, hosts: event.target.value }))
                  }
                />
              </div>
              <div className="category-field">
                <span>搜索键</span>
                <input
                  className="field"
                  placeholder="可留空，例如 scsearch"
                  value={sourceDraft.searchKey}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, searchKey: event.target.value }))
                  }
                />
              </div>
              <div className="settings-note">
                搜索键是 yt-dlp 的站内搜索前缀，只有少数站点有（ytsearch / bilisearch /
                scsearch / nicosearch）。留空也能用，只是这个源只能粘贴链接。
              </div>
              <div className="category-form-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setSourceDraft({ name: '', hosts: '', searchKey: '' })
                    setAddingSource(false)
                  }}
                >
                  取消
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => void submitSource()}>
                  添加
                </button>
              </div>
            </div>
          ) : (
            <button className="source-add" onClick={() => setAddingSource(true)}>
              ＋ 添加自定义源（任意视频 / 音频站点）
            </button>
          )}
        </div>

        <div className="settings-group">
          <label className="settings-label">播放</label>
          <div className="settings-note">
            默认倍速。音乐通常保持 1×，听书常调到 1.5×；播放器右侧也可以随时改，
            改完立即覆盖这里的默认值。
          </div>
          <div className="segmented" style={{ marginTop: 9 }}>
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
              <button
                key={rate}
                className="segment"
                data-active={settings.playbackRate === rate}
                onClick={() => onChange({ playbackRate: rate })}
              >
                {rate}×
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">歌词</label>
          <label className="switch-row">
            <input
              type="checkbox"
              className="switch"
              checked={settings.autoTranslate}
              onChange={(event) => onChange({ autoTranslate: event.target.checked })}
            />
            <span>
              <strong>非中文歌词自动翻译</strong>
              <em>自动匹配歌词来源，并在原文下方显示中文翻译</em>
            </span>
          </label>
        </div>

        <div className="settings-group">
          <label className="settings-label">本地识别模型</label>
          <select
            className="select"
            style={{ width: '100%' }}
            value={settings.whisperModel}
            onChange={(event) =>
              onChange({ whisperModel: event.target.value as AppSettings['whisperModel'] })
            }
          >
            <option value="tiny">Tiny · 最快，准确度一般（约 75MB）</option>
            <option value="base">Base · 速度与准确度均衡（约 145MB）</option>
            <option value="small">Small · 最准，速度较慢（约 480MB）</option>
          </select>
          <div className="settings-note">
            在线歌词匹配不到时，可在歌词面板点「本地识别」，完全离线地从音频中提取歌词。
            首次使用会自动下载模型。注意：语音模型对「唱歌」的准确度有限，
            长音频也较耗时，建议优先使用在线匹配。
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">网络代理</label>
          <div className="segmented">
            {(
              [
                { value: 'auto', label: '跟随系统' },
                { value: 'manual', label: '手动指定' },
                { value: 'off', label: '不使用' }
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                className="segment"
                data-active={settings.proxyMode === option.value}
                onClick={() => onChange({ proxyMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>

          {settings.proxyMode === 'manual' ? (
            <input
              className="field"
              style={{ width: '100%', height: 34, marginTop: 9 }}
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
              value={proxyDraft}
              onChange={(event) => setProxyDraft(event.target.value)}
              onBlur={commitProxy}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitProxy()
              }}
            />
          ) : null}

          <div className="settings-note">
            {settings.proxyMode === 'auto'
              ? `读取 Windows 的 PAC 脚本与系统代理设置。当前解析结果：${
                  netState?.proxy ?? '直连（未检测到代理）'
                }`
              : settings.proxyMode === 'manual'
                ? '使用上方填写的地址，HTTP 与 SOCKS5 均可。'
                : '完全直连，适合本机可直接访问 YouTube 的情况。'}
          </div>

          <div className="settings-actions" style={{ marginTop: 10, paddingTop: 10 }}>
            <button className="btn btn-sm" onClick={onReprobe} disabled={probing}>
              <RefreshIcon size={14} className={probing ? 'spin' : undefined} />
              {probing ? '检测中…' : '重新检测连通性'}
            </button>
            {netState ? (
              <span className="settings-note" style={{ margin: 0, alignSelf: 'center' }}>
                {netState.reachable ? 'YouTube 可达' : 'YouTube 不可达'}
              </span>
            ) : null}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Cookies 文件（可选）</label>
          <input
            className="field"
            style={{ width: '100%', height: 34 }}
            placeholder="导出为 Netscape 格式的 cookies.txt 路径"
            value={settings.cookieFile}
            onChange={(event) => onChange({ cookieFile: event.target.value })}
          />
          <div className="settings-note">遇到「需要登录」或年龄限制的视频时使用。</div>
        </div>

        <div className="settings-group">
          <label className="settings-label">站点账号</label>
          {authSources.length ? (
            <>
              {authSources.map((source) => {
                const account = accounts[source.id]
                const loggedIn = Boolean(account?.loggedIn)
                return (
                  <div key={source.id} className="bili-row">
                    {loggedIn && account?.avatar ? (
                      <img
                        className="bili-face"
                        src={account.avatar}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                    <span className="bili-row-body">
                      <strong>{loggedIn ? account?.uname : source.name}</strong>
                      <em>
                        {loggedIn
                          ? `已登录 · uid ${account?.uid}${
                              account?.expires
                                ? ` · 至 ${new Date(account.expires).toLocaleDateString()}`
                                : ''
                            }`
                          : '未登录 · 会员内容需要登录'}
                      </em>
                    </span>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => onOpenLogin(source.id)}
                    >
                      {loggedIn ? '账号管理' : '扫码登录'}
                    </button>
                    {loggedIn ? (
                      <button className="btn btn-sm" onClick={() => onLogout(source.id)}>
                        退出
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </>
          ) : null}
          <div className="settings-note">
            声明了登录方式的站点会在这里出现登录入口；扫码得到的凭证只写进本机配置文件，
            不上传任何地方。其余站点若遇到「需要登录」的提示，可在上方填写 cookies 文件。
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">音乐存放路径</label>
          <div className="path-row">
            <code className="path-text">{stats?.mediaDir ?? '读取中…'}</code>
            <button
              className="btn btn-sm"
              disabled={!stats?.mediaDir}
              onClick={() => {
                if (!stats?.mediaDir) return
                void navigator.clipboard.writeText(stats.mediaDir).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1600)
                })
              }}
              title="复制完整路径"
            >
              {copied ? '已复制' : '复制'}
            </button>
            <button className="btn btn-sm" onClick={onOpenDir} title="在资源管理器中打开">
              <FolderIcon size={14} />
              打开
            </button>
          </div>
          <div className="settings-note">
            下载的音乐都放在这个目录里，拖进别的播放器就能直接放。文件名用的是视频 ID，
            曲目名、封面等信息记在应用里，不依赖文件名。
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">手机 App 配对</label>
          <div className="settings-note">
            {apiInfo?.running
              ? '本机已开启配对服务。手机 App 与电脑连同一个 Wi-Fi，填入下面任一地址即可（首选 192.168 开头那个）：'
              : '配对服务未开启（端口被占用时会这样）。重启应用试试。'}
          </div>
          {apiInfo?.addresses.length ? (
            <div className="api-addresses">
              {apiInfo.addresses.map((address) => (
                <code key={address} className="path-text">
                  {address}
                </code>
              ))}
            </div>
          ) : null}
        </div>

        <div className="settings-actions">
          <button className="btn btn-sm" onClick={onClearCache} disabled={!stats?.count}>
            <TrashIcon size={14} />
            清空全部缓存
          </button>
        </div>

        <div className="settings-group">
          <label className="settings-label">下载核心</label>
          <div className="bili-row">
            <span className="bili-row-body">
              <strong>{status?.ytDlpLabel ?? '未安装'}</strong>
              <em>安装包里自带一份；YouTube 常改接口，过一阵就需要更新</em>
            </span>
            <button
              className="btn btn-sm btn-primary"
              onClick={onUpdateYtdlp}
              disabled={Boolean(progress)}
            >
              {progress ? '更新中…' : '更新 yt-dlp'}
            </button>
          </div>
          {progress ? (
            <div className="settings-note">
              {progress.step}
              {progress.ratio > 0 ? ` · ${Math.round(progress.ratio * 100)}%` : ''}
            </div>
          ) : (
            <div className="settings-note">
              更新下来的版本存进本机数据目录，优先于安装包内置的那份——不动安装文件，
              升级应用也不会把它覆盖掉。
            </div>
          )}
        </div>

        <div className="settings-meta">
          已缓存 {stats?.count ?? 0} 首 · 占用 {formatBytes(stats?.bytes ?? 0)}
          <br />
          下载核心：{status?.ytDlpLabel ?? '未安装'}
          <br />
          ffmpeg：{status?.ffmpegReady ? '已就绪' : '未安装'}
          <br />
          VinylBox v{appInfo?.version ?? '0.1.0'}
          <br />
          {appInfo?.userData}
        </div>
      </section>
    </>
  )
}
