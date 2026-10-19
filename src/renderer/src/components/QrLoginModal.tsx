import { useCallback, useEffect, useRef, useState } from 'react'
import type { QrState, QrTicket, SourceAccount } from '@shared/types'
import { CloseIcon, RefreshIcon } from './icons'

interface QrLoginModalProps {
  /** 登录哪个源（MediaSource.id） */
  sourceId: string
  sourceName: string
  account: SourceAccount
  onToast: (kind: 'info' | 'error' | 'success', text: string) => void
  onAccountChange: (sourceId: string, account: SourceAccount) => void
  onClose: () => void
}

const STATUS_TEXT: Record<QrState, string> = {
  waiting: '用对应站点 App 扫码',
  scanned: '已扫码，请在手机上点「确认登录」',
  success: '登录成功',
  expired: '二维码已失效，正在换一张…'
}

/** 轮询间隔：二维码有效期通常 3 分钟，1.5 秒问一次足够灵敏也不至于撞风控 */
const POLL_MS = 1500

/**
 * 站点扫码登录弹窗。
 *
 * 弹窗本身不认得任何具体站点——取码、轮询、登出都按 `sourceId` 交给后端分发，
 * 于是新增一个支持扫码登录的源，这里一行都不用改。
 */
export function QrLoginModal({
  sourceId,
  sourceName,
  account,
  onToast,
  onAccountChange,
  onClose
}: QrLoginModalProps) {
  const [qr, setQr] = useState<QrTicket | null>(null)
  const [state, setState] = useState<QrState>('waiting')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 组件可能在本轮请求回来前就被关掉，回来后别再碰 state */
  const alive = useRef(true)
  /** 连续拿到「已失效」就停下：正常过期换一张就好，一直失效是被风控掐了 */
  const expiredRuns = useRef(0)

  const takeQrcode = useCallback(async () => {
    setBusy(true)
    setError('')
    setQr(null)
    setState('waiting')
    const res = await window.vinyl.auth.qrcode(sourceId)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    expiredRuns.current = 0
    setQr(res.data)
  }, [sourceId])

  useEffect(() => {
    alive.current = true
    void takeQrcode()
    return () => {
      alive.current = false
    }
  }, [takeQrcode])

  useEffect(() => {
    if (!qr) return
    const timer = window.setInterval(async () => {
      const res = await window.vinyl.auth.poll(sourceId, qr.key)
      if (!alive.current) return
      if (!res.ok) {
        // 轮询失败通常是网络抖动，下一轮继续，别急着报错吓人
        return
      }
      setState(res.data.state)
      if (res.data.state === 'expired') {
        expiredRuns.current += 1
        if (expiredRuns.current >= 3) {
          window.clearInterval(timer)
          setState('expired')
          return
        }
        void takeQrcode()
        return
      }
      if (res.data.state === 'success' && res.data.account) {
        window.clearInterval(timer)
        onAccountChange(sourceId, res.data.account)
        onToast('success', `已登录${sourceName}：${res.data.account.uname}`)
        window.setTimeout(() => {
          if (alive.current) onClose()
        }, 1200)
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [qr, sourceId, sourceName, onAccountChange, onClose, onToast, takeQrcode])

  const copyLink = useCallback(async () => {
    if (!qr) return
    await navigator.clipboard.writeText(qr.url).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => {
      if (alive.current) setCopied(false)
    }, 1600)
  }, [qr])

  const logout = useCallback(async () => {
    setBusy(true)
    const res = await window.vinyl.auth.logout(sourceId)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      onToast('error', res.message)
      return
    }
    onAccountChange(sourceId, res.data)
    onToast('info', `已退出${sourceName}登录`)
    await takeQrcode()
  }, [sourceId, sourceName, onAccountChange, onToast, takeQrcode])

  const refresh = useCallback(async () => {
    setBusy(true)
    const res = await window.vinyl.auth.refresh(sourceId)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) {
      onToast('error', res.message)
      return
    }
    onAccountChange(sourceId, res.data)
    onToast(
      'info',
      res.data.loggedIn ? `登录态有效：${res.data.uname}` : '登录态已失效，请重新扫码'
    )
  }, [sourceId, onAccountChange, onToast])

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <section className="bili-login">
        <header className="settings-head">
          <h3>登录{sourceName}</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <CloseIcon size={15} />
          </button>
        </header>

        {account.loggedIn ? (
          <div className="bili-login-body">
            <div className="bili-user">
              {account.avatar ? (
                <img
                  className="bili-face"
                  src={account.avatar}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <div className="bili-user-meta">
                <strong>{account.uname}</strong>
                <em>uid {account.uid}</em>
              </div>
            </div>
            <div className="settings-note">
              登录态已生效：会员曲目、需要登录的清晰度现在都能下载。
              {account.expires
                ? `会话有效期至 ${new Date(account.expires).toLocaleDateString()}。`
                : ''}
            </div>
            <div className="settings-actions">
              <button className="btn btn-sm" onClick={() => void refresh()} disabled={busy}>
                <RefreshIcon size={14} className={busy ? 'spin' : undefined} />
                复核登录态
              </button>
              <button className="btn btn-sm" onClick={() => void logout()} disabled={busy}>
                退出登录
              </button>
            </div>
          </div>
        ) : (
          <div className="bili-login-body">
            {qr && state !== 'expired' ? (
              <div className="bili-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
            ) : (
              <div className="bili-qr bili-qr-empty">
                {error ? (
                  <span className="bili-qr-error">{error}</span>
                ) : (
                  <span className="bili-dot spin" />
                )}
              </div>
            )}

            <div className="bili-status" data-state={state}>
              {error ? '取码失败' : STATUS_TEXT[state]}
            </div>

            <div className="settings-note">
              扫{sourceName}的登录码，凭证只写进本机配置文件，不上传任何地方。
            </div>

            <div className="settings-actions">
              <button className="btn btn-sm" onClick={() => void takeQrcode()} disabled={busy}>
                <RefreshIcon size={14} className={busy ? 'spin' : undefined} />
                换一张
              </button>
              <button className="btn btn-sm" onClick={() => void copyLink()} disabled={!qr}>
                {copied ? '已复制' : '复制链接'}
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
