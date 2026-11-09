#!/usr/bin/env node
/**
 * 最小 asar 读取器：列出/提取 app.asar 里的文件。
 * asar 布局：[4B 4][4B headerPickleSize][4B headerSize][JSON header][data...]
 */
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ASAR = process.argv[2] || 'F:/dsh/resources/app.asar'
const COMMAND = process.argv[3] || 'list'
const PATTERN = process.argv[4] || ''

const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
// 实测布局：[0]=4(固定) [4]=headerPickleSize [8]=headerStringSize [12]=jsonLength [16..]=JSON
const headerPickleSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)

const headerBuf = Buffer.alloc(jsonLength)
readSync(fd, headerBuf, 0, jsonLength, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const dataStart = 8 + headerPickleSize

function walk(node, prefix, out) {
  for (const [name, info] of Object.entries(node.files || {})) {
    const path = prefix === '' ? name : prefix + '/' + name
    if (info.files) walk(info, path, out)
    else out.push({ path, size: info.size, offset: info.offset === undefined ? null : Number(info.offset), unpacked: info.unpacked })
  }
}

const files = []
walk(header, '', files)

if (COMMAND === 'list') {
  const hits = PATTERN === '' ? files : files.filter((f) => f.path.includes(PATTERN))
  for (const f of hits.slice(0, 200)) console.log(`${String(f.size).padStart(9)}  ${f.path}`)
  console.log(`\n匹配 ${hits.length} / 总计 ${files.length}`)
} else if (COMMAND === 'cat') {
  const hit = files.find((f) => f.path === PATTERN) || files.find((f) => f.path.endsWith(PATTERN))
  if (!hit) { console.error('没找到: ' + PATTERN); process.exit(1) }
  const buf = Buffer.alloc(hit.size)
  readSync(fd, buf, 0, hit.size, dataStart + hit.offset)
  process.stdout.write(buf.toString('utf8'))
} else if (COMMAND === 'grep') {
  const re = new RegExp(PATTERN, 'g')
  let total = 0
  for (const f of files) {
    if (f.size > 3_000_000) continue
    const buf = Buffer.alloc(f.size)
    readSync(fd, buf, 0, f.size, dataStart + f.offset)
    const text = buf.toString('utf8')
    if (re.test(text)) {
      re.lastIndex = 0
      console.log('HIT ' + f.path)
      total++
      if (total > 40) break
    }
    re.lastIndex = 0
  }
  console.log(`\n命中 ${total} 个文件`)
}

closeSync(fd)
