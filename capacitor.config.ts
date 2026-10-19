import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 手机端（Android / iOS）配置。
 *
 * 界面代码与桌面端完全共用，只是「干活的那一半」换了个地方：
 * 桌面端在 Electron 主进程里，手机端在电脑上跑的配套服务里（见 api-server.ts）。
 *
 * allowMixedContent 必须开：App 页面走 https scheme，而配套服务在局域网里是
 * 明文 http，不开这个开关浏览器会直接拦掉所有请求。
 */
const config: CapacitorConfig = {
  appId: 'app.vinylbox.mobile',
  appName: 'VinylBox',
  webDir: 'out/renderer',
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true
  },
  server: {
    androidScheme: 'https'
  }
}

export default config
