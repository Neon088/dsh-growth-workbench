/**
 * frontmatter 笔记集合引擎：Topics/Campaigns/Data/Products 共用。
 * 每篇笔记 = 一条记录；frontmatter 是结构化字段，正文是长文本。
 * 只支持扁平 key: value（字符串/数字/布尔/日期字符串），不支持嵌套与数组，
 * 保证写回时与 Obsidian 的 YAML 序列化不冲突。
 */

const FM_BOUNDARY = /^---\s*$/

export class FrontmatterError extends Error {
  constructor(message, code = 'bad_frontmatter') {
    super(message)
    this.name = 'FrontmatterError'
    this.code = code
  }
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (/^(true|yes)$/i.test(text)) return true
  if (/^(false|no)$/i.test(text)) return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  // 去掉成对引号
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function renderScalar(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value === null || value === undefined) return "''"
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const text = String(value)
  if (text === '') return "''"
  // 纯数字字符串裸写：读回来是 number，与 parseScalar 对称。
  if (/^-?\d+(\.\d+)?$/.test(text)) return text
  if (/[:#|\->!&*%@[`{}"',\s]/.test(text) || /^(true|false|yes|no|null|~)$/i.test(text)) {
    const inner = text.replace(/'/g, "''")
    return "'" + inner + "'"
  }
  return text
}

/** 拆 frontmatter 与正文。返回 {front:Object, body:string, fmLines:string[], bodyStart:number} */
export function splitNote(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  if (!FM_BOUNDARY.test(lines[0] ?? '')) {
    return { front: {}, fmLines: [], body: lines.join('\n'), bodyStart: 0, raw: lines.join('\n') }
  }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (FM_BOUNDARY.test(lines[index])) {
      end = index
      break
    }
  }
  if (end < 0) return { front: {}, fmLines: [], body: lines.join('\n'), bodyStart: 0, raw: lines.join('\n') }
  const fmLines = lines.slice(1, end)
  const front = {}
  for (const line of fmLines) {
    const match = line.match(/^([A-Za-z0-9_\u4e00-\u9fff-]+)\s*:\s*(.*)$/)
    if (match === null) continue
    front[String(match[1])] = parseScalar(match[2])
  }
  return {
    front,
    fmLines,
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    bodyStart: end + 1,
    raw: lines.join('\n'),
  }
}

/**
 * 写回一篇笔记。
 *
 * original 是这篇笔记原来的全文。插件只负责 schema 里那几个键，其余的行
 * （aliases / created / cover / cssclass，以及任何 YAML 列表、嵌套结构）一律
 * 原样搬过去 —— 之前这里只把 front 对象里的键重新拼一遍，用户的这些字段
 * 每保存一次就被删一次，YAML 列表还会被降级成带引号的字符串。
 */
export function buildNote(front, body, original) {
  const next = { ...(front ?? {}) }
  const lines = ['---']
  const emitted = new Set()
  const parsed = typeof original === 'string' && original !== '' ? splitNote(original) : { fmLines: [] }

  // 无 frontmatter 的自由笔记（台账、随手记）只改正文时，不要凭空长出一个
  // 空的 ---\n--- 块，否则 Obsidian 会显示一块空属性。
  if (Object.keys(next).length === 0 && parsed.fmLines.length === 0) {
    return String(body ?? '').replace(/^\n+/, '') + '\n'
  }

  if (parsed.fmLines.length > 0) {
    let skipContinuation = false
    for (const line of parsed.fmLines) {
      const isContinuation = /^\s+\S/.test(line) || /^\s*-\s/.test(line)
      if (isContinuation) {
        if (!skipContinuation) lines.push(line)
        continue
      }
      skipContinuation = false
      const match = line.match(/^([A-Za-z0-9_\u4e00-\u9fff-]+)\s*:\s*(.*)$/)
      if (match === null) {
        lines.push(line)
        continue
      }
      const key = String(match[1])
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        emitted.add(key)
        lines.push(key + ': ' + renderScalar(next[key]))
        skipContinuation = true
      } else {
        lines.push(line)
      }
    }
    for (const key of Object.keys(next)) {
      if (emitted.has(key)) continue
      lines.push(key + ': ' + renderScalar(next[key]))
    }
    lines.push('---', '')
    return lines.join('\n') + String(body ?? '').replace(/^\n+/, '') + '\n'
  }

  for (const key of Object.keys(next)) {
    lines.push(key + ': ' + renderScalar(next[key]))
  }
  lines.push('---', '')
  return lines.join('\n') + String(body ?? '').replace(/^\n+/, '') + '\n'
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
