/**
 * 单个 schema/legacy Markdown 表块的解析与安全写回。
 * 未识别、歧义或损坏的目标表拒写；表外字节不重排。备份成功才提交。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { withFileWriteLock, atomicWriteFile } from './vault.js'

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
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (char === '\\' && inner[index + 1] === '|') { current += '\\|'; index += 1; continue }
    if (char === '|') { cells.push(current.trim()); current = ''; continue }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function describe(error) { return error instanceof Error ? error.message : String(error) }

function validateField(name, value) {
  const text = String(value ?? '').trim()
  if (text.replace(/\\\|/g, '').includes('|')) throw new TableValidationError(name + ' 不能含竖线（|），会破坏表格')
  if (/[\r\n\t]/.test(text)) throw new TableValidationError(name + ' 不能含换行或制表符')
  if (text.length > MAX_FIELD) throw new TableValidationError(name + ' 超过 ' + MAX_FIELD + ' 字')
  return text
}

export function createTable(config) {
  const { header, keys, idKeys, legacy = null, heading = '', intro = '', label = '', idFallbackKeys = null, validatePath, backupPath = null } = config
  if (!Array.isArray(header) || !Array.isArray(keys) || header.length !== keys.length) {
    throw new Error('createTable：header 与 keys 必须等长')
  }
  const labelOf = (key) => header[keys.indexOf(key)] ?? key
  const prefix = label === '' ? '' : label + ' '
  const legacyRules = legacy === null ? [] : Array.isArray(legacy)
    ? legacy : [{ cells: header.length - 1, at: [{ index: legacy.index }] }]

  function primaryIdKeys(values) { return typeof idKeys === 'function' ? idKeys(values ?? {}) : idKeys }
  function effectiveIdKeys(values) {
    const primary = primaryIdKeys(values)
    if (primary.every((key) => String(values?.[key] ?? '') !== '') || !Array.isArray(idFallbackKeys) || idFallbackKeys.length === 0) return primary
    return idFallbackKeys
  }
  function idOf(values) {
    const source = effectiveIdKeys(values).map((key) => String(values?.[key] ?? '')).join('\u0000')
    return createHash('sha1').update(source).digest('hex').slice(0, ID_LENGTH)
  }
  function sha1Of(text) { return createHash('sha1').update(String(text ?? '')).digest('hex') }

  function legacyShape(rule) {
    const positions = (rule.at ?? []).map((patch) => patch.index)
    const drops = (rule.drop ?? []).map((index) => Number(index))
    const retained = rule.cells - drops.length
    const scope = retained + positions.length
    // at 是升级后表头里的补列位，drop 是老表里已经废弃、不能映射到新列的列。
    // 位置必须唯一且落在补列后的前缀内，不能靠 splice 的先后顺序碰运气。
    if (!Number.isInteger(rule.cells) || rule.cells < 0 || retained < 0 || scope > header.length) return null
    if (new Set(positions).size !== positions.length) return null
    if (positions.some((index) => !Number.isInteger(index) || index < 0 || index >= scope)) return null
    if (new Set(drops).size !== drops.length) return null
    if (drops.some((index) => !Number.isInteger(index) || index < 0 || index >= rule.cells)) return null
    return { positions, drops, retained }
  }

  function upgradeRow(cells) {
    if (cells.length === header.length) return cells.slice()
    const rule = legacyRules.find((item) => item.cells === cells.length)
    if (rule === undefined) return null
    const shape = legacyShape(rule)
    if (shape === null) return null
    const blanks = new Set(shape.positions)
    const dropped = new Set(shape.drops)
    const retainedCells = cells.filter((_, index) => !dropped.has(index))
    const row = []
    let cursor = 0
    for (let index = 0; index < retainedCells.length + shape.positions.length; index += 1) {
      row.push(blanks.has(index) ? '' : retainedCells[cursor++])
    }
    while (row.length < header.length) row.push('')
    return cursor === retainedCells.length && row.length === header.length ? row : null
  }
  function headerMatches(cells) {
    if (cells === null) return false
    if (cells.length === header.length) return cells.every((cell, index) => cell === header[index])
    const rule = legacyRules.find((item) => item.cells === cells.length)
    if (rule === undefined) return false
    const shape = legacyShape(rule)
    if (shape === null) return false
    const expected = header.slice(0, shape.retained + shape.positions.length)
    // 删除补列位必须从后往前：先删前面的 index 会让后面的位置整体左移，
    // 6 列 / 9 列这种「一次补两列」的老表头就永远匹配不上。
    for (const index of [...shape.positions].sort((a, b) => b - a)) expected.splice(index, 1)
    const retained = cells.filter((_, index) => !shape.drops.includes(index))
    return retained.length === expected.length && retained.every((cell, index) => cell === expected[index])
  }

  // parse 和 serialize 共用这一个识别器；不能再一个扫描全文、另一个只改第一张表。
  function layoutOf(text) {
    const source = String(text ?? '')
    const lines = source.split('\n')
    const offsets = []
    let cursor = 0
    for (const line of lines) { offsets.push(cursor); cursor += line.length + 1 }
    const matches = []
    let fence = ''
    for (let index = 0; index < lines.length; index += 1) {
      const marker = /^[ \t]*(`{3,}|~{3,})/.exec(lines[index])
      if (marker !== null) {
        if (fence === '') fence = marker[1][0]
        else if (marker[1][0] === fence) fence = ''
        continue
      }
      if (fence !== '') continue
      const first = cellsOf(lines[index])
      if (first === null) continue
      let end = index + 1
      while (end < lines.length && cellsOf(lines[end]) !== null) end += 1
      if (headerMatches(first)) {
        const divider = cellsOf(lines[index + 1] ?? '')
        if (divider === null || divider.length !== first.length || !divider.every((cell) => SEPARATOR.test(cell))) {
          throw new TableValidationError(prefix + '表头后缺少合法分隔行，已拒绝改写')
        }
        matches.push({ first: index, end, startByte: offsets[index], endByte: Math.min(offsets[end] ?? source.length, source.length) })
      }
      index = end - 1
    }
    if (matches.length > 1) throw new TableValidationError(prefix + '存在多个同 schema 表块，无法确定要改哪一张')
    if (matches.length === 0) {
      if (source.trim() !== '') throw new TableValidationError(prefix + '未找到匹配 schema/legacy 的表块，原文件不改')
      return { found: false, source, lines, newline: source.includes('\r\n') ? '\r\n' : '\n' }
    }
    return { found: true, source, lines, ...matches[0], newline: source.includes('\r\n') ? '\r\n' : '\n' }
  }

  function parse(text) {
    const layout = layoutOf(text)
    if (!layout.found) return []
    const entries = []
    const seen = new Set()
    for (let index = layout.first + 2; index < layout.end; index += 1) {
      const cells = cellsOf(layout.lines[index])
      if (headerMatches(cells) || cells.every((cell) => SEPARATOR.test(cell))) {
        throw new TableValidationError(prefix + '目标表内有重复表头或分隔行，已拒绝改写')
      }
      const row = upgradeRow(cells)
      if (row === null) throw new TableValidationError(prefix + '第 ' + (index + 1) + ' 行列数不符合 schema/legacy')
      if (row.every((cell) => cell === '')) continue
      const entry = {}
      keys.forEach((key, position) => { entry[key] = row[position] ?? '' })
      if (effectiveIdKeys(entry).every((key) => entry[key] === '')) throw new TableValidationError(prefix + '第 ' + (index + 1) + ' 行缺少主键')
      const id = idOf(entry)
      if (seen.has(id)) throw new TableValidationError(prefix + '有重复主键，已拒绝静默合并数据行')
      seen.add(id)
      entries.push({ id, ...entry })
    }
    return entries
  }

  function serialize(entries, original) {
    const table = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |']
    for (const entry of entries) table.push('| ' + keys.map((key) => String(entry?.[key] ?? '')).join(' | ') + ' |')
    if (typeof original === 'string') {
      const layout = layoutOf(original)
      if (layout.found) {
        const endedWithNewline = original.slice(layout.endByte - 1, layout.endByte) === '\n'
        return original.slice(0, layout.startByte) + table.join(layout.newline)
          + (endedWithNewline ? layout.newline : '') + original.slice(layout.endByte)
      }
    }
    const lines = []
    if (heading !== '') lines.push(heading, '')
    if (intro !== '') lines.push(intro, '')
    return [...lines, ...table, ''].join('\n')
  }

  function normalize(input, { selfId = null } = {}) {
    const value = {}
    for (const key of keys) value[key] = validateField(prefix + labelOf(key), input?.[key])
    if (effectiveIdKeys(value).every((key) => value[key] === '')) {
      throw new TableValidationError(prefix + primaryIdKeys(value).map(labelOf).join('和') + '至少要填一个')
    }
    return { id: idOf(value), ...value, selfId }
  }

  async function read(file) {
    if (validatePath !== undefined) await validatePath(file)
    let text
    try { text = await readFile(file, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], exists: false }
      return { entries: [], exists: false, warning: '读取失败：' + describe(error), code: 'read_failed' }
    }
    try { return { entries: parse(text), exists: true, sha1: sha1Of(text), text } } catch (error) {
      if (!(error instanceof TableValidationError)) throw error
      return { entries: [], exists: true, sha1: sha1Of(text), text, warning: error.message, code: error.code }
    }
  }
  function readFailure(current) {
    return current.warning === undefined ? null : { ok: false, error: current.warning, code: current.code ?? 'read_failed' }
  }
  function expectedConflict(current, options) {
    const expected = typeof options?.expectedSha1 === 'string' ? options.expectedSha1 : ''
    if (expected === '' || current.sha1 === expected) return null
    return { ok: false, code: 'conflict', error: '这张表在你读取之后被改过，刷新一下再改。', currentSha1: current.sha1 ?? '' }
  }

  async function writeEntries(file, entries, original) {
    let next
    try { next = serialize(entries, original) } catch (error) {
      if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
    if (validatePath !== undefined) await validatePath(file)
    if (original !== undefined) {
      // 备份落点由调用方给（vault.backupPathFor），和笔记写入/删除用同一套命名。
      // 以前这里固定写「原文件旁边.md.bak」——备份散落在 Obsidian 库里，
      // 会被当正常笔记索引出来，恢复时也找不到统一的地方。
      const backupFile = typeof backupPath === 'function' ? backupPath(file) : file + '.bak'
      try {
        if (validatePath !== undefined) await validatePath(backupFile)
        await atomicWriteFile(backupFile, original)
      } catch (error) {
        return { ok: false, error: '备份失败，已放弃写入（原文件未改动）：' + describe(error), code: 'backup_failed' }
      }
    }
    try {
      await atomicWriteFile(file, next, { beforeCommit: async () => {
        if (validatePath !== undefined) await validatePath(file)
        let latest
        try { latest = await readFile(file, 'utf8') } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (latest !== original) throw new TableValidationError('这张表在提交前被改过，已拒绝覆盖', 'conflict')
      } })
    } catch (error) {
      return { ok: false, error: '写入失败，原文件未改动：' + describe(error), code: error.code === 'conflict' ? 'conflict' : 'write_failed' }
    }
    return { ok: true, entries, sha1: sha1Of(next) }
  }

  async function add(file, input, options) {
    return withFileWriteLock(file, async () => {
      const current = await read(file)
      const failure = readFailure(current) ?? expectedConflict(current, options)
      if (failure !== null) return failure
      let normalized
      try { normalized = normalize(input) } catch (error) {
        if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
        throw error
      }
      if (current.entries.some((entry) => entry.id === normalized.id)) return { ok: false, error: '已经有同一条（主键相同）', code: 'duplicate' }
      const { selfId, ...entry } = normalized
      const written = await writeEntries(file, [...current.entries, entry], current.text)
      return written.ok ? { ...written, entry } : written
    })
  }

  /**
   * 一次写入多条。
   *
   * 为什么要有它：一次「分发到多个平台」要落 N 行排期。用 add() 连做 N 次，
   * 等于 N 次整表重写 + N 次全量解析，中途任何一步失败都会留下半截行，
   * 而且 .bak 备份只保住最后一次写入前的状态 —— 回不到扇出之前。
   * addMany 把整批放进同一次锁、一次备份、一次原子写里，要么全成要么全不成。
   */
  async function addMany(file, inputs, options) {
    return withFileWriteLock(file, async () => {
      const current = await read(file)
      const failure = readFailure(current) ?? expectedConflict(current, options)
      if (failure !== null) return failure
      const normalized = []
      const seen = new Set(current.entries.map((entry) => entry.id))
      for (const input of Array.isArray(inputs) ? inputs : []) {
        let row
        try { row = normalize(input) } catch (error) {
          if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
          throw error
        }
        if (seen.has(row.id)) return { ok: false, error: '已经有同一条（主键相同）', code: 'duplicate' }
        seen.add(row.id)
        normalized.push(row)
      }
      const entries = [...current.entries, ...normalized.map(({ selfId, ...entry }) => entry)]
      const written = await writeEntries(file, entries, current.text)
      return written.ok ? { ...written, entries: normalized.map(({ selfId, ...entry }) => entry) } : written
    })
  }

  async function update(file, id, input, options) {
    return withFileWriteLock(file, async () => {
      const current = await read(file)
      const failure = readFailure(current) ?? expectedConflict(current, options)
      if (failure !== null) return failure
      const index = current.entries.findIndex((entry) => entry.id === id)
      if (index < 0) return { ok: false, error: '找不到这条（可能已被删除或改过）', code: 'not_found' }
      let normalized
      try { normalized = normalize(input) } catch (error) {
        if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
        throw error
      }
      if (current.entries.some((entry, position) => position !== index && entry.id === normalized.id)) {
        return { ok: false, error: '改完之后与另一条完全相同', code: 'duplicate' }
      }
      const { selfId, ...entry } = normalized
      const entries = current.entries.slice()
      entries[index] = entry
      const written = await writeEntries(file, entries, current.text)
      return written.ok ? { ...written, entry } : written
    })
  }

  async function remove(file, id, options) {
    return withFileWriteLock(file, async () => {
      const current = await read(file)
      const failure = readFailure(current) ?? expectedConflict(current, options)
      if (failure !== null) return failure
      if (!current.entries.some((entry) => entry.id === id)) return { ok: false, error: '找不到这条（可能已被删除）', code: 'not_found' }
      return writeEntries(file, current.entries.filter((entry) => entry.id !== id), current.text)
    })
  }

  /**
   * Replace one table as a single compare-and-swap write.
   *
   * Coordinated workflows (for example, cancelling a platform version and
   * removing all of its unpublished calendar rows) must not expose a table
   * after only half its matching rows were changed. Callers read once, build
   * the complete next entry set, then commit it here with that read's sha1.
   */
  async function replaceAll(file, inputs, options) {
    return withFileWriteLock(file, async () => {
      const current = await read(file)
      const failure = readFailure(current) ?? expectedConflict(current, options)
      if (failure !== null) return failure
      const entries = []
      const seen = new Set()
      for (const input of Array.isArray(inputs) ? inputs : []) {
        let normalized
        try { normalized = normalize(input) } catch (error) {
          if (error instanceof TableValidationError) return { ok: false, error: error.message, code: error.code }
          throw error
        }
        if (seen.has(normalized.id)) return { ok: false, error: '替换后存在重复主键', code: 'duplicate' }
        seen.add(normalized.id)
        const { selfId, ...entry } = normalized
        entries.push(entry)
      }
      const written = await writeEntries(file, entries, current.text)
      return written.ok ? { ...written, entries } : written
    })
  }

  return { header, keys, idOf, parse, serialize, normalize, read, add, addMany, update, remove, replaceAll }
}
