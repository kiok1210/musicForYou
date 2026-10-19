import ReactDOM from 'react-dom/client'
import App from './App'
import { MobileGate } from './mobile/MobileGate'
import './styles/global.css'
import './styles/vinyl.css'
import './styles/lyrics.css'
import './styles/library.css'

const container = document.getElementById('root')
if (container) {
  /**
   * 桌面端由 preload 注入 window.vinyl（走 IPC）；手机上没有它，
   * 得先过配对闸门连上电脑，再把 window.vinyl 换成走网络的那份。
   */
  const isMobile = typeof window !== 'undefined' && !('vinyl' in window)
  ReactDOM.createRoot(container).render(isMobile ? <MobileGate /> : <App />)
}
