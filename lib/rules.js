/**
 * 文案规则库：与原插件 email-rules.js 同构（MIT），仅改文案与字段。
 * SECTIONS: hard 禁忌 / soft 风格 / watch 待观察。
 * FIELD_ORDER: 规则 / 证据 / 来源 / 强度 / 反例。
 * markdown 结构（无损读写）：
 *   # 标题
 *   > 简介
 *   ## 状态一览   ← 计数表（refreshCounts 重写）
 *   ## 硬规则 / 软规则 / 待观察
 *   ### R-001 · 规则文本
 *   | 证据 | 来源 | 强度 | 反例 |
 */
import { createHash } from 'node:crypto'

const SECTIONS = [
  { key: 'hard', title: '硬规则', label: '禁忌，违反必改' },
  { key: 'soft', title: '软规则', label: '风格偏好，尽量遵守' },
  { key: 'watch', title: '待观察', label: '证据不足，先记录' },
]
// 真实 rules.md 用的是「内容 / 证据 / 反例 / 改法」四列；早先的白名单只有
// 证据/来源/强度/反例，于是「内容」「改法」在保存时被静默丢掉（3526→2137 字符）。
const FIELD_ORDER = ['规则', '内容', '证据', '来源', '强度', '反例', '改法']
// 编号：早先是 R-001，真实文件里是 H1 / H2 …（手写成「### H1 · 标题」）。
// 认不出编号时 id 会变成空串，而空串让「按 id 匹配」把 16 条规则当成同一条 ——
// 删一条等于全删，改一条等于全改成同一条。这是本插件最危险的一个 bug。
const ID_PATTERN = /^([A-Za-z]{1,4}-?\d+)$/

// 每个分组各用一套编号前缀，和真实文件一致（hard=H1..H6 / soft=S1..S7 / watch=W1..W3）。
const SECTION_PREFIX = { hard: 'H', soft: 'S', watch: 'W' }

export function nextRuleId(items, section) {
  const wanted = String(section ?? '').trim()
  const seen = new Map()
  for (const item of items) {
    const match = String(item?.id ?? '').match(/^([A-Za-z]{1,4})-?(\d+)$/)
    if (match === null) continue
    const prefix = match[1].toUpperCase()
    const num = Number(match[2])
    const slot = seen.get(prefix) ?? { max: 0, count: 0 }
    slot.max = Math.max(slot.max, num)
    slot.count += 1
    seen.set(prefix, slot)
  }
  let prefix = 'R'
  if (wanted !== '' && SECTION_PREFIX[wanted] !== undefined) {
    prefix = SECTION_PREFIX[wanted]
  } else {
    // 没指定分组时，沿用文件里用得最多的那套前缀。
    let best = 0
    for (const [name, slot] of seen) {
      if (slot.count > best) { best = slot.count; prefix = name }
    }
  }
  const max = seen.get(prefix)?.max ?? 0
  const pad = prefix === 'R' ? 3 : 0
  const body = String(max + 1).padStart(pad > 0 ? pad : 1, '0')
  return prefix + (pad > 0 ? '-' : '') + body
}

function parseFieldBlock(text) {
  const fields = {}
  for (const name of FIELD_ORDER) {
    if (name === '规则') continue
    fields[name] = ''
  }
  const source = Array.isArray(text) ? text.join('\n') : String(text ?? '')
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/)
    if (match === null) continue
    const name = String(match[1] ?? '').trim()
    if (name === '' || name === '规则') continue
    // 未知列也留着：宁可多存一列，也不能把用户手写的内容读丢。
    fields[name] = String(match[2] ?? '').trim()
  }
  return fields
}

function renderFieldBlock(fields) {
  const lines = []
  const source = fields ?? {}
  const known = FIELD_ORDER.filter((name) => name !== '规则')
  const extra = Object.keys(source).filter((name) => name !== '规则' && !known.includes(name))
  for (const name of known.concat(extra)) {
    const value = String(source[name] ?? '').trim()
    if (value !== '') lines.push('- **' + name + '**：' + value)
  }
  return lines.join('\n')
}

export function parseRules(markdown) {
  const text = String(markdown ?? '')
  const lines = text.split(/\r?\n/)
  const structure = { top: [], sections: [], bottom: [] }
  const items = []
  const SECTION_TITLES = SECTIONS.map((section) => section.title)

  let mode = 'top'
  let currentSection = null
  let currentSectionKey = null
  let currentRule = null
  let blanks = 0

  const pushRule = () => {
    if (currentRule !== null) {
      currentRule.fields = parseFieldBlock(currentRule.body)
      delete currentRule.body
      items.push(currentRule)
      currentRule = null
    }
  }
  const pushSection = () => {
    pushRule()
    if (currentSection !== null) {
      currentSection.blanksAfter = blanks
      structure.sections.push(currentSection)
      currentSection = null
    }
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/)
    const h3 = line.match(/^###\s+(.+)$/)

    if (h2 !== null) {
      pushSection()
      blanks = 0
      const title = String(h2[1] ?? '').trim()
      const known = SECTION_TITLES.includes(title)
      currentSection = { type: 'h2', title, known, body: [] }
      currentSectionKey = known ? (SECTIONS.find((entry) => entry.title === title)?.key ?? null) : null
      mode = 'section'
      continue
    }
    if (mode === 'top') {
      structure.top.push(line)
      continue
    }
    if (mode === 'section') {
      if (h3 !== null && currentSection !== null && currentSection.known) {
        pushRule()
        blanks = 0
        const heading = String(h3[1] ?? '').trim()
        const match = heading.match(/^([A-Za-z]{1,4}-?\d+)\s*[·・]\s*(.+)$/)
          ?? heading.match(/^([A-Za-z]{1,4}-?\d+)\s+(.+)$/)
        // 没写编号的标题：用标题文本摘要生成稳定 id，保证「按 id 匹配」不会把
        // 所有无编号规则当成同一条。
        const generated = 'X-' + createHash('sha1').update(heading, 'utf8').digest('hex').slice(0, 6)
        currentRule = {
          id: match !== null ? match[1] : generated,
          title: match !== null ? match[2].trim() : heading,
          section: currentSectionKey ?? '',
          body: [],
        }
        continue
      }
      if (currentRule !== null) {
        currentRule.body.push(line)
        if (line.trim() === '') blanks += 1
        else blanks = 0
        continue
      }
      if (currentSection !== null) {
        // 规则段落里的尾部空行留在段落里，节级空行计数。
        currentSection.body.push(line)
        if (line.trim() === '') blanks += 1
        else blanks = 0
      }
    }
  }
  pushSection()
  structure.bottom = []
  return { structure, items, blanksTail: blanks }
}

/** 把 items 重新渲染成 markdown（与 parse 配对，尽量保持原布局）。 */
export function renderRules({ structure, items }) {
  const lines = []
  lines.push(...structure.top)
  for (const section of structure.sections) {
    const sectionKey = SECTIONS.find((entry) => entry.title === section.title)?.key ?? null
    const sectionItems = sectionKey === null ? [] : items.filter((item) => item.section === sectionKey)
    lines.push('## ' + section.title)
    lines.push(...section.body.filter((line, index, all) => !(index === all.length - 1 && line.trim() === '')))
    if (sectionKey !== null) {
      if (lines[lines.length - 1].trim() !== '') lines.push('')
      for (const item of sectionItems) {
        lines.push('### ' + item.id + ' · ' + item.title)
        const fieldBlock = renderFieldBlock(item.fields)
        if (fieldBlock !== '') lines.push(...fieldBlock.split('\n'))
        lines.push('')
      }
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** 校验+规范化一条规则输入；返回 {ok,item} 或 {ok:false,error}。 */
export function normalizeRule(input, { existingIds = [] } = {}) {
  const id = String(input?.id ?? '').trim()
  if (!ID_PATTERN.test(id)) return { ok: false, error: '规则编号必须是「字母+数字」（如 H17 / R-012 / X-3f2a1b）' }
  if (existingIds.includes(id)) return { ok: false, error: '规则编号重复：' + id }
  const sectionKey = String(input?.section ?? '').trim()
  if (!SECTIONS.some((section) => section.key === sectionKey)) {
    return { ok: false, error: '分组必须是 ' + SECTIONS.map((section) => section.key + '(' + section.title + ')').join('/') }
  }
  const title = String(input?.title ?? '').trim()
  if (title === '') return { ok: false, error: '规则文本不能为空' }
  if (title.length > 120) return { ok: false, error: '规则文本太长（>120 字）' }
  const fields = {}
  const incoming = input?.fields ?? {}
  const names = FIELD_ORDER.filter((name) => name !== '规则')
  for (const name of Object.keys(incoming)) {
    if (name !== '规则' && !names.includes(name)) names.push(name)
  }
  for (const name of names) {
    const value = String(incoming?.[name] ?? '').trim()
    if (/[\r\n]/.test(value)) return { ok: false, error: name + ' 不能含换行' }
    if (value.length > 200) return { ok: false, error: name + ' 太长（>200 字）' }
    fields[name] = value
  }

  return { ok: true, item: { id, section: sectionKey, title, fields } }
}

export function countsOf(items) {
  const counts = { hard: 0, soft: 0, watch: 0 }
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.section)) counts[item.section] += 1
  }
  return counts
}

/** 重写「## 状态一览」计数表；没有就插在第一个已知节之前。 */
export function refreshCounts(markdown, items) {
  const counts = countsOf(items)
  // 用本机时区的时间：toISOString() 是 UTC，东八区晚间会把「最后整合」算成前一天。
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
  const table = [
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 硬规则数 | ' + counts.hard + ' |',
    '| 软规则数 | ' + counts.soft + ' |',
    '| 待观察 | ' + counts.watch + ' |',
    '| 最后整合 | ' + stamp + ' |',
  ].join('\n')

  const lines = String(markdown ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+状态一览/.test(line))
  const block = ['## 状态一览', '', table, '']
  if (start >= 0) {
    let end = start + 1
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1
    lines.splice(start, end - start, ...block)
  } else {
    const firstKnown = lines.findIndex((line) => SECTIONS.some((section) => ('## ' + section.title) === line.trim()))
    if (firstKnown >= 0) lines.splice(firstKnown, 0, ...block, '')
    else lines.push('', ...block)
  }
  return lines.join('\n')
}

export function sha1Of(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex')
}

export const RULES_SECTIONS = SECTIONS
export const RULES_FIELD_ORDER = FIELD_ORDER
