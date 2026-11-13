// 旧数据迁移回归：补 id + 建平台版本，可重复执行。
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitNote } from '../lib/frontmatter.js'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-migrate-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-migrate-data-'))
let handler = null
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {}, error() {} },
}, { pluginDataDir: dataDir })
await new Promise((resolve) => setTimeout(resolve, 120))

async function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
  await handler(req, res)
  let json
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 200) }
  return { status: res.statusCode, json }
}

let failures = 0
function check(label, result, predicate) {
  const passed = predicate(result)
  if (!passed) failures += 1
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(38) + ' ' + JSON.stringify(result.json).slice(0, 240))
}

await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir })
fs.mkdirSync(path.join(vault, 'Topics'), { recursive: true })
fs.writeFileSync(path.join(vault, 'Topics', '旧选题.md'), '---\nplatform: 抖音\nstatus: 创作中\ndate: 2026-10-01\n---\n\n## 正文\n旧内容\n', 'utf8')

const recordUrl = '/api/dsh-growth/topics/record?path=' + encodeURIComponent('Topics/旧选题.md')
const beforeRecord = await request('GET', recordUrl)
const exposedId = beforeRecord.json?.record?.id
check('migration exposes original fallback id', beforeRecord, (r) => r.status === 200 && typeof exposedId === 'string' && exposedId !== '' && !r.json.record.front.id)
const preview = await request('GET', '/api/dsh-growth/v2/migration/preview')
check('migration preview counts', preview, (r) => r.status === 200 && r.json.migration?.totalTopics === 1 && r.json.migration?.missingIdCount === 1 && r.json.migration?.createVariantCount === 1 && r.json.migration?.dryRun === true)

const applied = await request('POST', '/api/dsh-growth/v2/migration/apply', { dryRun: false })
check('migration apply', applied, (r) => r.status === 200 && r.json.migration?.assignedIds === 1 && r.json.migration?.createdCount === 1 && r.json.migration?.dryRun === false)
const noteText = fs.readFileSync(path.join(vault, 'Topics', '旧选题.md'), 'utf8')
check('migration persists same exposed id', { json: noteText }, () => splitNote(noteText).front.id === exposedId)
const afterRecord = await request('GET', recordUrl)
check('migration API identity stays unchanged', afterRecord, (r) => r.status === 200 && r.json.record.id === exposedId && r.json.record.front.id === exposedId)
const variantPath = applied.json?.migration?.created?.[0]?.path ?? ''
check('migration variant created', { json: variantPath }, () => variantPath.includes('Workbench/平台版本/') && fs.existsSync(path.join(vault, variantPath)))
const again = await request('POST', '/api/dsh-growth/v2/migration/apply', { dryRun: false })
check('migration is idempotent', again, (r) => r.status === 200 && r.json.migration?.assignedIds === 0 && r.json.migration?.createdCount === 0)

// 待发可以安全保留；待回填不能凭旧标签伪造发布事实和观察周期，迁成在写并标记待确认。
// 一格多平台仍必须拆成多个平台版本。
fs.writeFileSync(path.join(vault, 'Topics', '待发老选题.md'), '---\nplatform: 抖音\nstatus: 待发\ndate: 2026-10-02\n---\n\n正文\n', 'utf8')
fs.writeFileSync(path.join(vault, 'Topics', '多平台老选题.md'), '---\nplatform: 抖音 / 知乎\nstatus: 待回填\ndate: 2026-10-03\n---\n\n正文\n', 'utf8')
const preview2 = await request('GET', '/api/dsh-growth/v2/migration/preview')
check('migration recognizes current statuses and platform lists', preview2, (r) => r.status === 200
  && r.json.migration?.missingIdCount === 2 && r.json.migration?.createVariantCount === 3)
const applied2 = await request('POST', '/api/dsh-growth/v2/migration/apply', { dryRun: false })
check('migration applies status and platform variants', applied2, (r) => r.status === 200 && r.json.migration?.createdCount === 3)
const migrated = (applied2.json?.migration?.created ?? []).map((item) => splitNote(fs.readFileSync(path.join(vault, item.path), 'utf8')).front)
check('migration preserves 待发, safely downgrades unproven publish facts, and splits platforms', { json: migrated }, () => migrated.some((front) => front.platform === '抖音' && front.status === '待发')
  && migrated.some((front) => front.platform === '知乎' && front.status === '在写')
  && (applied2.json?.migration?.created ?? []).some((item) => item.needsPublishConfirmation === true))
const again2 = await request('POST', '/api/dsh-growth/v2/migration/apply', { dryRun: false })
check('migration stays idempotent after multi-platform import', again2, (r) => r.status === 200 && r.json.migration?.createdCount === 0)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
