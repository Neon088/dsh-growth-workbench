/**
 * CSV：Data 卡的数据导入与存档。
 * - parseCsv(text)：极简解析（支持引号包裹、双引号转义、\r\n）。
 * - applyMapping(rows, mapping)：把外部 CSV 列映射到模板字段。
 * - toCsv(header, rows)：存档导出（UTF-8 BOM 由写盘方加）。
 */

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (inQuotes) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      cell = ''
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  return rows
}

function escapeCell(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

export function toCsv(header, rows) {
  const lines = [header.map(escapeCell).join(',')]
  for (const row of rows) lines.push(header.map((key) => escapeCell(row[key])).join(','))
  return lines.join('\r\n') + '\r\n'
}

/**
 * 简单列映射：mapping = { 目标字段: csv列名或索引(数字字符串) }。
 * 返回 [{字段: 值}]；数字字段尽量转 number。
 */
export function applyMapping(csvRows, mapping, { numericFields = [] } = {}) {
  if (csvRows.length === 0) return []
  const header = csvRows[0].map((value) => value.trim())
  const body = csvRows.slice(1)
  const out = []
  for (const row of body) {
    const record = {}
    for (const [field, column] of Object.entries(mapping ?? {})) {
      let index = -1
      if (/^\d+$/.test(String(column))) index = Number(column)
      else index = header.findIndex((name) => name.toLowerCase() === String(column).toLowerCase())
      if (index < 0 || index >= row.length) continue
      const value = row[index].trim()
      if (numericFields.includes(field) && value !== '') {
        // 平台导出的数字常带千分位（1,200）、百分号（12.5%）、货币符号（¥199）。
        const cleaned = value.replace(/[,\s¥$€£]/g, '').replace(/%$/, '')
        if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
          record[field] = Number(cleaned)
          continue
        }
      }
      record[field] = value
    }
    if (Object.keys(record).length > 0) out.push(record)
  }
  return out
}

/** 猜测映射：模板字段名与 CSV 列名做包含匹配（双向）。 */
export function guessMapping(header, fields) {
  const mapping = {}
  const used = new Set()
  for (const field of fields) {
    const hit = header.find((name, index) => {
      if (used.has(index)) return false
      const lower = name.toLowerCase()
      return lower === field.toLowerCase() || lower.includes(field.toLowerCase()) || field.toLowerCase().includes(lower)
    })
    if (hit !== undefined) {
      mapping[field] = hit
      used.add(header.indexOf(hit))
    }
  }
  return mapping
}
