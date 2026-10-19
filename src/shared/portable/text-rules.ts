/**
 * 可移植模块 · 关键词规则匹配
 *
 * 「给一批带标签的正则，问文本命中哪些」——自动打标、内容过滤、分类归一
 * 本质是同一件事。EchoPod 的 `inferBucket` 与本项目 VinylBox 的自动标签
 * 都建在这层之上，只是词表不同。
 *
 * 纯函数，不依赖 electron / react / node（及任何词表）。
 */

export interface KeywordRule {
  /** 命中后输出的标签 */
  label: string
  /** 匹配规则；建议带上 `\b` 边界与中英双语分支 */
  pattern: RegExp
}

export interface RuleGroup {
  label: string
  rules: KeywordRule[]
}

/** 返回命中的标签，保持规则顺序并自动去重 */
export function matchLabels(text: string, rules: KeywordRule[]): string[] {
  if (!text) return []
  const hit: string[] = []
  for (const rule of rules) {
    if (rule.pattern.test(text) && !hit.includes(rule.label)) hit.push(rule.label)
  }
  return hit
}

/** 与 matchLabels 相同，但把结果追加到已有数组（用于多组规则依次叠加） */
export function collectLabels(text: string, rules: KeywordRule[], bucket: string[]): string[] {
  if (!text) return bucket
  for (const rule of rules) {
    if (rule.pattern.test(text) && !bucket.includes(rule.label)) bucket.push(rule.label)
  }
  return bucket
}

/**
 * 多组规则依次匹配，全部命中都会返回（组顺序即输出顺序）。
 * 适合「维度」式的打标：语言 → 版本 → 乐器 → 风格 → 场景。
 */
export function matchGroups(text: string, groups: RuleGroup[]): string[] {
  const labels: string[] = []
  for (const group of groups) collectLabels(text, group.rules, labels)
  return labels
}

/**
 * 只返回第一个命中的组的标签。
 * 适合互斥的分类：把更具体的组排在前面，先命中先归类。
 */
export function classifyFirst(text: string, groups: RuleGroup[]): string | null {
  if (!text) return null
  for (const group of groups) {
    for (const rule of group.rules) {
      if (rule.pattern.test(text)) return group.label
    }
  }
  return null
}

/** 合并多段文本后统一匹配，便于把「标题 + 描述 + 频道名」一起喂进来 */
export function matchAcross(parts: (string | null | undefined)[], rules: KeywordRule[]): string[] {
  return matchLabels(parts.filter(Boolean).join('\n'), rules)
}


