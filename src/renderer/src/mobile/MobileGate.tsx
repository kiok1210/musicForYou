import { useCallback, useEffect, useRef, useState } from 'react'
import App from '@/App'
import { createMobileApi, normalizeServer, serverBase, setServerBase } from './bridge'

/**
 * 手机端的入口闸门。
 *
 * 手机上没有 Electron 主进程，界面得先连上电脑上的配套服务才有数据。
 * 所以这里先探活：连通了才把 `window.vinyl` 换成走网络的实现并渲染主界面；
 * 连不上就停在配对页，把「地址怎么填」讲清楚——手机端最常见的问题就是这里。
 */
export function MobileGate() {
  const [base, setBase] = useState(() => serverBase())
  const [draft, setDraft] = useState(() => serverBase())
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  /** 注入只做一次：换地址要整页重来，免得半路换掉后端 */
  const injected = useRef(false)

  const connect = useCallback(async (raw: string) => {
    const target = normalizeServer(raw)
    if (!target) {
      setError('请填写电脑上显示的地址')
      return
    }
    setChecking(true)
    setError('')
    try {
      const res = await fetch(`${target}/ping`)
      const data = (await res.json()) as { app?: string }
      if (!data?.app) throw new Error('这个地址不是 VinylBox 的配套服务')
      setServerBase(target)
      if (!injected.current) {
        injected.current = true
        ;(window as unknown as Record<string, unknown>)['vinyl'] = createMobileApi(target)
      }
      setBase(target)
      setReady(true)
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes('配套服务')
          ? err.message
          : '连不上。确认手机与电脑在同一个 Wi-Fi、电脑上的 VinylBox 正开着，地址照着「设置 → 手机 App 配对」填'
      )
    } finally {
      setChecking(false)
    }
  }, [])

  // 上次填过就直接试连，省一步操作
  useEffect(() => {
    if (base) void connect(base)
    // 只在首次挂载时自动试连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (ready) return <App />

  return (
    <div className="mobile-setup">
      <div className="mobile-card">
        <h1 className="mobile-brand">VinylBox</h1>
        <p className="mobile-lead">
          手机负责界面与播放，搜索和下载由电脑上的 VinylBox 完成。
          两边连同一个 Wi-Fi，把电脑上显示的地址填在下面。
        </p>

        <label className="mobile-label" htmlFor="server">
          电脑上的地址
        </label>
        <input
          id="server"
          className="field mobile-field"
          value={draft}
          placeholder="192.168.1.5:8787"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void connect(draft)
          }}
        />

        {error ? <div className="mobile-error">{error}</div> : null}

        <button
          className="btn btn-primary mobile-connect"
          onClick={() => void connect(draft)}
          disabled={checking}
        >
          {checking ? '正在连接…' : '连接电脑'}
        </button>

        <div className="mobile-help">
          <strong>地址在哪看</strong>
          <span>电脑上打开 VinylBox →「设置」→「手机 App 配对」，里面列出的地址照抄一个即可。</span>
          <span>如果列出多个，优先选 192.168 开头的那个。</span>
        </div>
      </div>
    </div>
  )
}
