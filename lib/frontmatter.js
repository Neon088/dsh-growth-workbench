/**
 * frontmatter 笔记集合引擎：Topics/Campaigns/Data/Products 共用。
 * 每篇笔记 = 一条记录；frontmatter 是结构化字段，正文是长文本。
 * 只支持扁平 key: value（字符串/数字/布尔/日期字符串），不支持嵌套与数组，
 * 保证写回时与 Obsidian 的 YAML 序列化不冲突。
 */

const FM_BOUNDARY = /^\uFEFF?---[ \t]*$/
const FM_KEY = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/

export class FrontmatterError extends Error {
  constructor(message, code = 'bad_frontmatter') {
    super(message)
    this.name = 'FrontmatterError'
    this.code = code
  }
}

// 这里只解释标量供表单使用；复杂 YAML 的原始字节由 buildNote 搬回，绝不
// 把 splitNote 的有损视图当成整份 frontmatter 的序列化输入。
function scalarParts(raw) {
  const source = String(raw ?? '')
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote === '"' && char === '\\') { index += 1; continue }
    if (quote === "'" && char === "'" && source[index + 1] === "'") { index += 1; continue }
    if (char === quote) { quote = ''; continue }
    if (quote === '' && (char === '"' || char === "'")) { quote = char; continue }
    if (quote === '' && char === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
      let from = index
      while (from > 0 && /[ \t]/.test(source[from - 1])) from -= 1
      return { value: source.slice(0, from).trim(), comment: source.slice(from) }
    }
  }
  return { value: source.trim(), comment: '' }
}

function parseScalar(raw) {
  const text = scalarParts(raw).value
  if (text === '') return ''
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) } catch { return text.slice(1, -1) }
  }
  if (/^(true|yes)$/i.test(text)) return true
  if (/^(false|no)$/i.test(text)) return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

function renderScalar(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value === null || value === undefined) return "''"
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'object') throw new FrontmatterError('只支持修改标量属性；列表和嵌套结构会原样保留', 'bad_field')
  const text = String(value)
  if (/[\r\n]/.test(text)) throw new FrontmatterError('属性值不能含换行', 'bad_field')
  if (text === '') return "''"
  // 前导零不能裸写，否则稳定 ID 会被 YAML 解释成另一个数字。
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^-?0\d/.test(text)) return text
  if (/[:#|\->!&*%@[`{}"',\s]/.test(text) || /^(true|false|yes|no|null|~)$/i.test(text) || /^-?0\d/.test(text)) {
    return "'" + text.replace(/'/g, "''") + "'"
  }
  return text
}

function frontmatterRegion(text) {
  const source = String(text ?? '')
  const opening = /^\uFEFF?---[ \t]*(?:\r\n|\n)/.exec(source)
  if (opening === null) return null
  const boundary = /^---[ \t]*(?:\r?\n|$)/gm
  boundary.lastIndex = opening[0].length
  const closing = boundary.exec(source)
  if (closing === null) return null
  const after = closing.index + closing[0].length
  const separator = /^(?:\r\n|\n)*/.exec(source.slice(after))[0]
  return {
    opening: opening[0],
    content: source.slice(opening[0].length, closing.index),
    closing: closing[0],
    separator,
    prefix: source.slice(0, after + separator.length),
    newline: opening[0].endsWith('\r\n') ? '\r\n' : '\n',
  }
}

/** 拆 frontmatter 与正文。front 是标量视图，写回必须提供 original 和实际 patch。 */
export function splitNote(text) {
  const source = String(text ?? '')
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  if (!FM_BOUNDARY.test(lines[0] ?? '')) {
    return { front: {}, fmLines: [], body: lines.join('\n'), bodyStart: 0, raw: lines.join('\n') }
  }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (FM_BOUNDARY.test(lines[index])) { end = index; break }
  }
  if (end < 0) return { front: {}, fmLines: [], body: lines.join('\n'), bodyStart: 0, raw: lines.join('\n') }
  const fmLines = lines.slice(1, end)
  const front = {}
  for (const line of fmLines) {
    const match = line.match(/^([A-Za-z0-9_\u4e00-\u9fff-]+)[ \t]*:[ \t]*(.*)$/)
    if (match !== null) front[String(match[1])] = parseScalar(match[2])
  }
  return { front, fmLines, body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''), bodyStart: end + 1, raw: lines.join('\n') }
}

/**
 * front 是实际属性 patch，而不是 splitNote().front 的完整快照。
 * 不变的行、列表、嵌套、注释、BOM 和 CRLF 都沿用原始字节；仅重写目标键。
 */
export function buildNote(front, body, original, { removeKeys = [] } = {}) {
  const next = { ...(front ?? {}) }
  for (const key of [...Object.keys(next), ...removeKeys]) {
    if (!FM_KEY.test(key)) throw new FrontmatterError('属性名不合法：' + key, 'bad_field')
  }
  const region = typeof original === 'string' ? frontmatterRegion(original) : null
  const newline = region?.newline ?? '\n'
  const bodyText = String(body ?? '').replace(/^(?:\r\n|\n)+/, '')
  const renderedBody = bodyText + (bodyText.endsWith('\n') ? '' : newline)
  const removed = new Set(removeKeys)
  if (region !== null) {
    if (Object.keys(next).length === 0 && removed.size === 0) return region.prefix + (region.closing.endsWith('\n') ? '' : newline) + renderedBody
    const parsed = splitNote(original)
    const kept = []
    const emitted = new Set()
    let skipContinuation = false
    for (const chunk of region.content.match(/[^\n]*(?:\n|$)/g) ?? []) {
      if (chunk === '') continue
      const line = chunk.replace(/\r?\n$/, '')
      const eol = chunk.slice(line.length)
      // 独立注释和空行不是要删除的数据；也不要因此重置续行保护。
      if (line.trim() === '' || /^[ \t]*#/.test(line)) { kept.push(chunk); continue }
      if (/^[ \t]+/.test(line) || /^-\s/.test(line)) {
        if (!skipContinuation) kept.push(chunk)
        continue
      }
      skipContinuation = false
      const match = line.match(/^([A-Za-z0-9_\u4e00-\u9fff-]+)([ \t]*:[ \t]*)(.*)$/)
      if (match === null) { kept.push(chunk); continue }
      const key = match[1]
      if (removed.has(key)) { skipContinuation = true; continue }
      if (!Object.prototype.hasOwnProperty.call(next, key)) { kept.push(chunk); continue }
      emitted.add(key)
      // 完整表单也可能把不变的标量带回。相同值不重排原行，更不会扁平化其续行。
      if (String(next[key] ?? '') === String(parsed.front[key] ?? '')) { kept.push(chunk); continue }
      kept.push(key + match[2] + renderScalar(next[key]) + scalarParts(match[3]).comment + eol)
      skipContinuation = true
    }
    for (const key of Object.keys(next)) {
      if (emitted.has(key) || removed.has(key)) continue
      kept.push(key + ': ' + renderScalar(next[key]) + newline)
    }
    return region.opening + kept.join('') + region.closing + (region.closing.endsWith('\n') ? '' : newline) + region.separator + renderedBody
  }
  if (Object.keys(next).length === 0) return renderedBody
  const lines = Object.keys(next).filter((key) => !removed.has(key)).map((key) => key + ': ' + renderScalar(next[key]))
  return ['---', ...lines, '---', ''].join(newline) + renderedBody
}

/**
 * 集合操作（无状态，由调用方用 vault.readNote/writeNote 落盘）：
 * listNotes({notes}) —— notes 来自 vault.discover()，这里再逐篇读 frontmatter。
 */
export async function collectRecords({ paths, readNote, fields }) {
  const records = []
  for (const path of paths) {
    let note
    try {
      note = await readNote(path)
    } catch {
      continue
    }
    const { front, body } = splitNote(note.text)
    const record = { path, title: note.title, mtimeMs: note.mtimeMs, sha1: note.sha1, front, bodyPreview: body.split('\n').slice(0, 6).join(' ').slice(0, 160) }
    void fields
    records.push(record)
  }
  return records
}

/** 过滤：front[key] 包含 query（字符串小写包含；标量转字符串）。多条件 AND。 */
export function filterRecords(records, filters = {}) {
  const entries = Object.entries(filters ?? {}).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  if (entries.length === 0) return records
  return records.filter((record) =>
    entries.every(([key, value]) => {
      const actual = record.front?.[key]
      if (actual === undefined) return value === '__missing__'
      return String(actual).toLowerCase().includes(String(value).toLowerCase())
    }),
  )
}

/** 排序：field 为 front 字段或 '_mtime'/'_title'。desc 默认 true。 */
export function sortRecords(records, field = '_mtime', desc = true) {
  const valueOf = (record) => {
    if (field === '_mtime') return record.mtimeMs ?? 0
    if (field === '_title') return String(record.title ?? '')
    const value = record.front?.[field]
    if (typeof value === 'number') return value
    return String(value ?? '')
  }
  const sorted = records.slice().sort((left, right) => {
    const a = valueOf(left)
    const b = valueOf(right)
    if (typeof a === 'number' && typeof b === 'number') return desc ? b - a : a - b
    const cmp = String(a).localeCompare(String(b), 'zh')
    return desc ? -cmp : cmp
  })
  return sorted
}

/** 校验 frontmatter 字段输入；schemaItem: {key, label, required, max} */
export function normalizeFront(schema, input) {
  const front = {}
  for (const item of schema) {
    const raw = input?.[item.key]
    const text = raw === undefined || raw === null ? '' : String(raw).trim()
    if (item.required === true && text === '') {
      throw new FrontmatterError(item.label + ' 必填', 'bad_field')
    }
    if (text.length > (item.max ?? 200)) {
      throw new FrontmatterError(item.label + ' 超长（>' + (item.max ?? 200) + ' 字）', 'bad_field')
    }
    if (/[\r\n]/.test(text)) throw new FrontmatterError(item.label + ' 不能含换行', 'bad_field')
    front[item.key] = text
  }
  return front
}

/** 校验合并后的 schema，但只返回调用者实际提供的字段，未知原始 YAML 不参与重建。 */
export function normalizeFrontPatch(schema, input, current = {}) {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new FrontmatterError('front 必须是属性对象', 'bad_field')
  }
  if (Object.keys(input).length === 0) return {}
  const normalized = normalizeFront(schema, { ...current, ...input })
  const patch = {}
  for (const item of schema) {
    if (Object.prototype.hasOwnProperty.call(input, item.key)) patch[item.key] = normalized[item.key]
  }
  return patch
}

/** 用模板生成一篇新笔记全文。templateBody 里 {key} 会替换为 front 值。 */
export function renderFromTemplate(schema, front, templateBody) {
  let body = String(templateBody ?? '')
  for (const item of schema) {
    body = body.split('{' + item.key + '}').join(String(front?.[item.key] ?? ''))
  }
  const usedKeys = schema.filter((item) => String(front?.[item.key] ?? '') !== '').map((item) => item.key)
  const cleanFront = {}
  for (const key of usedKeys) cleanFront[key] = front[key]
  return buildNote(cleanFront, body)
}
