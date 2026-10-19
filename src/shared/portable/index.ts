/**
 * 可移植能力集合
 *
 * 这里只放与业务无关的纯逻辑，方便在多个播放器项目之间整体搬运。
 *
 * 本项目原创（VinylBox / musicForYou）
 * - subtitles.ts      字幕与歌词解析：LRC / WebVTT / 纯文本、语言检测、双语对齐
 * - ytdlp-output.ts   yt-dlp 输出解析：进度行、阶段标记、报错中文化
 * - format.ts         时长 / 体积 / 相对时间格式化，标题清洗与检索词生成
 * - concurrency.ts    并发池、去抖与节流
 * - text-rules.ts     关键词规则匹配（自动打标 / 内容过滤 / 分类归一的共同内核）
 *
 * 来自 EchoPod（bokeForYou）的回供
 * - playback.ts       倍速档位、断点续听边界处理、睡眠定时
 * - collections.ts    通用分组、文本归一化、关键词打分
 *
 * 规则：不 import electron、不 import react、不读写文件、不发请求。
 * 任何一边新增模块，把文件复制到另一边同名目录即可，不需要改构建配置。
 */
export * from './subtitles'
export * from './ytdlp-output'
export * from './format'
export * from './concurrency'
export * from './text-rules'
export * from './playback'
export * from './collections'
