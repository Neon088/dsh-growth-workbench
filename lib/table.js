/**
 * 通用「一张 Markdown 表格」的解析 / 校验 / 备份 / 原子写。
 * 移植自 dsh-legal-workbench/lib/table.js（MIT），写盘纪律不变：
 *   ① 先解析现有文件；解析不了就拒绝写入，原文件不动；
 *   ② 现有字节复制到 `<file>.bak`；
 *   ③ 新内容写临时文件再 rename 覆盖（原子）；
 *   ④ 任何一步失败：删临时文件、抛错。
 * id = sha1(主键字段用 \0 连接).slice(0, 12)。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, unlink, copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const SEPARATOR = /^:?-{2,}:?$/
const MAX_FIELD = 200
const ID_LENGTH = 12

export class TableValidationError extends Error {
  constructor(message, code = 'invalid_table') {
    super(message)
    this.name = 'TableValidationError'
    this.code = code
  }
}

function cellsOf(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let current = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    // [[222\|选题A]] 里的竖线是转义的，属于单元格内容而不是分隔符。
    if (ch === '\\' && inner[i + 1] === '|') { current += '\\|'; i += 1; continue }
    if (ch === '|') { cells.push(current.trim()); current = ''; continue }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function validateField(name, value) {
  const text = String(value ?? '').trim()
  // 没转义的竖线会破坏表格；\| 是合法的（Obsidian 双链里常见）。
  if (text.replace(/\\\|/g, '').includes('|')) throw new TableValidationError(name + ' 不能含竖线（|），会破坏表格')
  if (/[\r\n\t]/.test(text)) throw new TableValidationError(name + ' 不能含换行或制表符')
  if (text.length > MAX_FIELD) throw new TableValidationError(name + ' 超过 ' + MAX_FIELD + ' 字')
  return text
}

export function createTable(config) {
  const { header, keys, idKeys, legacy = null, heading = '', intro = '', label = '', idFallbackKeys = null } = config
  if (!Array.isArray(header) || !Array.isArray(keys) || header.length !== keys.length) {
    throw new Error('createTable：header 与 keys 必须等长')
  }
  const labelOf = (key) => header[keys.indexOf(key)] ?? key
  const prefix = label === '' ? '' : label + ' '

  // 新列（如日历的 topicId）出现后，老行还没有这个值。主键不完整时退回老主键，
  // 这样升级那一刻不会把同一天、同一平台的多行合并成一条。
  // 主键可以是固定字段，也可以按这一行的内容动态决定（日历就是动态的：
  // 有选题ID时用「选题+平台」，老行还没回填时退回「日期+平台+主题」，
  // 同一选题同平台有多个版本时再加版本ID，才能让每一版各排各的）。
  function primaryIdKeys(values) {
    return typeof idKeys === 'function' ? idKeys(values ?? {}) : idKeys
  }

  function effectiveIdKeys(values) {
    const primary = primaryIdKeys(values)
    const primaryFilled = primary.every((key) => String(values?.[key] ?? '') !== '')
    if (primaryFilled || !Array.isArray(idFallbackKeys) || idFallbackKeys.length === 0) return primary
    return idFallbackKeys
  }

  function idOf(values) {
    const source = effectiveIdKeys(values).map((key) => String(values?.[key] ?? '')).join('\u0000')
    return createHash('sha1').update(source).digest('hex').slice(0, ID_LENGTH)
  }

  // 整份表格原文的指纹。update 用它判断「读完之后有没有别人动过」。
  function sha1Of(text) {
    return createHash('sha1').update(String(text ?? '')).digest('hex')
  }

  function parse(text) {
    const entries = []
    const seen = new Set()
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const cells = cellsOf(line)
      if (cells === null || cells.length === 0) continue
      if (cells.every((cell) => SEPARATOR.test(cell))) continue
      if (cells[0] === header[0] && cells[1] === header[1]) continue
      const row = cells.slice(0, header.length)
      while (row.length < header.length) row.push('')
      // legacy 可以是单个 {index}（老写法：少一列时在 index 处补空串），
      // 也可以是 [{cells, at:[{index}]}] 数组：一张表历经过多种老列数时，按 `cells`（该格式的列数）挑规则，
      // `at` 列出缺的列应插回的位置。
      if (legacy !== null) {
        const rules = Array.isArray(legacy) ? legacy : [{ cells: header.length - 1, at: [{ index: legacy.index }] }]
        const rule = rules.find((item) => item.cells === cells.length)
        if (rule !== undefined) {
          // 从后往前插，前面的下标就不会被前一次插入挤偏。
          const patches = [...(rule.at ?? [])].sort((a, b) => b.index - a.index)
          for (const patch of patches) row.splice(patch.index, 0, '')
        }
      }
      const entry = {}
      keys.forEach((key, index) => { entry[key] = row[index] ?? '' })
      const checkKeys = effectiveIdKeys(entry)
      if (checkKeys.every((key) => entry[key] === '')) continue
      const id = idOf(entry)
      if (seen.has(id)) continue
      seen.add(id)
      entries.push({ id, ...entry })
    }
    return entries
  }

  // 找出现有文件里「表格那一段」的起止行：表格之外的一切（简介、注意事项、
  // 第二张表、文末备查）都原样保留。以前 serialize 只重建表头和数据行，
  // 于是任何一次增删改都会把表外正文整段抹掉。
  function layoutOf(text) {
    const lines = String(text ?? '').split(/\r?\n/)
    let first = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (cellsOf(lines[i]) !== null) { first = i; break }
    }
    if (first < 0) return { found: false, prefix: lines, suffix: [] }
    // 只吃掉「紧挨着的一段表格行」：中间夹了空行或标题，说明那是另一张表，
    // 必须留在 suffix 里原样搬回去。
    let last = first
    for (let i = first; i < lines.length; i += 1) {
      if (cellsOf(lines[i]) === null) break
      last = i
    }
    return { found: true, prefix: lines.slice(0, first), suffix: lines.slice(last + 1) }
  }

  function serialize(entries, original) {
    const table = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |']
    for (const entry of entries) {
      table.push('| ' + keys.map((key) => String(entry?.[key] ?? '')).join(' | ') + ' |')
    }
    if (typeof original === 'string') {
      const layout = layoutOf(original)
      if (layout.found) {
        const kept = []
        if (layout.prefix.length > 0 && layout.prefix[layout.prefix.length - 1].trim() !== '') kept.push('')
        return [...layout.prefix, ...kept, ...table, ...layout.suffix].join('\n')
      }
    }
    const lines = []
    if (heading !== '') lines.push(heading, '')
    if (intro !== '') lines.push(intro, '')
    lines.push(...table, '')
    return lines.join('\n')
  }

  function normalize(input, { selfId = null } = {}) {
    const value = {}
    for (const key of keys) value[key] = validateField(prefix + labelOf(key), input?.[key])
    const checkKeys = effectiveIdKeys(value)
    if (checkKeys.every((key) => value[key] === '')) {
      throw new TableValidationError(prefix + primaryIdKeys(value).map(labelOf).join('和') + '至少要填一个')
    }
    return { id: idOf(value), ...value, selfId }
  }

  async function read(file) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return { entries: [], exists: false }
      return { entries: [], exists: false, warning: '读取失败：' + describe(error) }
    }
    return { entries: parse(text), exists: true, sha1: sha1Of(text), text }
  }

  async function writeEntries(file, entries, original) {
    const next = serialize(entries, original)
    try {
      await mkdir(dirname(file), { recursive: true })
    } catch (error) {
      return { ok: false, error: '目录不可写：' + describe(error), code: 'write_failed' }
    }
    try {
      await copyFile(file, file + '.bak')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        return { ok: false, error: '备份失败，已放弃写入（原文件未改动）：' + describe(error), code: 'backup_failed' }
      }
    }
    const temp = file + '.tmp-' + process.pid
    try {
      await writeFile(temp, next, 'utf8')
      await rename(temp, file)
    } catch (error) {
      try { await unlink(temp) } catch { /* 临时文件可能根本没创建成功 */ }
      return { ok: false, error: '写入失败，原文件未改动：' + describe(error), code: 'write_failed' }
    }
    return { ok: true, entries }
  }

  async function add(file, input) {
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    let normalized
    try {
      normalized = normalize(input)
    } catch (error) {
      if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
    if (current.entries.some((entry) => entry.id === normalized.id)) {
      return { ok: false, error: '已经有同一条（主键相同）', code: 'duplicate' }
    }
    const { selfId, ...fields } = normalized
    const entry = { id: normalized.id, ...fields }
    const written = await writeEntries(file, [...current.entries, entry], current.text)
    return written.ok === true ? { ok: true, entry, entries: written.entries } : written
  }

  async function update(file, id, input, options) {
    const expectedSha1 = options !== undefined && options !== null && typeof options.expectedSha1 === 'string' ? options.expectedSha1 : ''
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    // 读和写之间这张表被别人改过，就别拿旧快照整表覆盖 —— 那会把对方刚加的行抹掉。
    if (expectedSha1 !== '' && current.exists === true && current.sha1 !== expectedSha1) {
      return {
        ok: false,
        code: 'conflict',
        error: '这张表在你读取之后被改过（可能刚有人加了别的行）。刷新一下再改。',
        currentSha1: current.sha1,
      }
    }
    const index = current.entries.findIndex((entry) => entry.id === id)
    if (index < 0) return { ok: false, error: '找不到这条（可能已被删除或改过）', code: 'not_found' }
    let normalized
    try {
      normalized = normalize(input)
    } catch (error) {
      if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
    const collision = current.entries.some((entry, position) => position !== index && entry.id === normalized.id)
    if (collision) return { ok: false, error: '改完之后与另一条完全相同', code: 'duplicate' }
    const { selfId, ...fields } = normalized
    const entry = { id: normalized.id, ...fields }
    const entries = current.entries.slice()
    entries[index] = entry
    const written = await writeEntries(file, entries, current.text)
    return written.ok === true ? { ok: true, entry, entries: written.entries } : written
  }

  async function remove(file, id) {
    const current = await read(file)
    if (current.warning !== undefined) return { ok: false, error: current.warning, code: 'read_failed' }
    if (!current.entries.some((entry) => entry.id === id)) {
      return { ok: false, error: '找不到这条（可能已被删除）', code: 'not_found' }
    }
    const entries = current.entries.filter((entry) => entry.id !== id)
    const written = await writeEntries(file, entries, current.text)
    return written.ok === true ? { ok: true, entries } : written
  }

  return { header, keys, idOf, parse, serialize, normalize, read, add, update, remove }
}
