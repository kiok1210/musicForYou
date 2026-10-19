/**
 * 内容源：可搜索的站点，或仅能粘贴链接下载的站点。
 *
 * yt-dlp 支持上千个站点，但**提供站内搜索的只有寥寥几个**——
 * 判据是源码里带 `_SEARCH_KEY` 的 extractor，实测可用的就这四个：
 *
 *   ytsearch    YouTube     曲库最大，字幕最全
 *   bilisearch  哔哩哔哩    国内直连，但搜索常被 412 风控拦截
 *   scsearch    SoundCloud  独立音乐人，需代理
 *   nicosearch  NicoNico    日系同人，需代理
 *
 * 其余站点 yt-dlp 没有搜索接口，只能解析具体链接。这类源照样列出，
 * 作用是：粘贴链接时认出内容来自哪里，并提示「这个源不支持站内搜索」。
 *
 * 于是源分两种能力：
 *   有 searchKey → 能进「发现」与关键词搜索
 *   无 searchKey → 只能粘贴链接，界面上如实标注
 */
import type { MediaSource } from '@shared/types'

export const BUILTIN_SOURCES: MediaSource[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    hosts: ['youtube.com', 'youtu.be', 'music.youtube.com', 'm.youtube.com', 'youtube-nocookie.com'],
    searchKey: 'ytsearch',
    home: 'https://www.youtube.com/',
    accent: '#e0665f',
    note: '默认源。曲库最大，歌词与字幕命中率最高',
    custom: false
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    hosts: ['bilibili.com', 'b23.tv', 'acg.tv'],
    searchKey: 'bilisearch',
    home: 'https://www.bilibili.com/',
    accent: '#6ea8fe',
    note: '国内直连最快；代理出口在境外时会被区域限制，搜索还可能撞上 412 风控',
    custom: false,
    // 搜索接口有设备风控：不带指纹就回 412；匿名指纹仍可能被概率拦下，登录后才稳
    fingerprint: true,
    auth: 'qrcode'
  },
  {
    id: 'soundcloud',
    name: 'SoundCloud',
    hosts: ['soundcloud.com', 'sndcdn.com'],
    searchKey: 'scsearch',
    home: 'https://soundcloud.com/',
    accent: '#f2a65a',
    note: '独立音乐人与 DJ 混音，国内需要代理',
    custom: false
  },
  {
    id: 'nicovideo',
    name: 'NicoNico',
    hosts: ['nicovideo.jp', 'nico.ms'],
    searchKey: 'nicosearch',
    home: 'https://www.nicovideo.jp/',
    accent: '#4fd1c5',
    note: '日系同人与 VOCALOID，需要代理',
    custom: false
  },
  {
    id: 'bandcamp',
    name: 'Bandcamp',
    hosts: ['bandcamp.com'],
    searchKey: '',
    home: 'https://bandcamp.com/',
    accent: '#67c48d',
    note: '独立音乐，仅支持粘贴专辑或单曲链接',
    custom: false
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    hosts: ['vimeo.com'],
    searchKey: '',
    home: 'https://vimeo.com/',
    accent: '#5ac8fa',
    note: '仅支持粘贴链接',
    custom: false
  },
  {
    id: 'dailymotion',
    name: 'Dailymotion',
    hosts: ['dailymotion.com', 'dai.ly'],
    searchKey: '',
    home: 'https://www.dailymotion.com/',
    accent: '#c58cf0',
    note: '仅支持粘贴链接',
    custom: false
  },
  {
    id: 'douyin',
    name: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    searchKey: '',
    home: 'https://www.douyin.com/',
    accent: '#e07a5f',
    note: '粘贴分享链接或整段分享文案即可缓存；接口要 s_v_web_id 凭证，应用会自动领取',
    custom: false,
    // 抖音 web 详情接口认 s_v_web_id，而它只由页面脚本写入，得让浏览器开一次首页
    fingerprint: true
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com', 'xhs.cn'],
    searchKey: '',
    home: 'https://www.xiaohongshu.com/',
    accent: '#f2607f',
    note: '视频笔记可缓存，分享短链会自动展开（query 里的 xsec_token 必须保留）；图文笔记没有音视频',
    custom: false,
    fingerprint: true
  },
  {
    id: 'weixin-channels',
    name: '微信视频号',
    hosts: ['channels.weixin.qq.com', 'finder.video.qq.com'],
    searchKey: '',
    home: 'https://channels.weixin.qq.com/',
    accent: '#67c48d',
    note: '仅支持粘贴链接；视频号没有公开网页接口，需要微信自己的登录态才取得流地址',
    custom: false
  },
  {
    id: 'ixigua',
    name: '西瓜视频',
    hosts: ['ixigua.com'],
    searchKey: '',
    home: 'https://www.ixigua.com/',
    accent: '#f2a0c0',
    note: '国内长视频，仅支持粘贴链接',
    custom: false
  }
]

/** 用户自建源由 CacheStore 从 sources.json 载入后注入 */
let customSources: MediaSource[] = []

export function syncCustomSources(list: MediaSource[]): void {
  customSources = [...list]
}

/** 内置在前、自建在后 */
export function allSources(): MediaSource[] {
  return [...BUILTIN_SOURCES, ...customSources]
}

export function sourceById(id: string): MediaSource | null {
  return allSources().find((source) => source.id === id) ?? null
}

/** 只有带搜索键的源才能进搜索框与发现页 */
export function searchableSources(): MediaSource[] {
  return allSources().filter((source) => Boolean(source.searchKey))
}

/**
 * 按链接判断内容来自哪个源。
 * 用「域名以某个 host 结尾」匹配，这样 m.youtube.com、www.bilibili.com
 * 这类子域都能命中，不必把每个子域都列全。
 */
export function sourceForUrl(url: string): MediaSource | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  return (
    allSources().find((source) => source.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ??
    null
  )
}
