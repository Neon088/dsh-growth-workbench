// P0-b 领域层回归：主选题 × 平台版本 × 指标快照。
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-v2-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-v2-data-'))
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
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(38) + ' ' + JSON.stringify(result.json).slice(0, 220))
}

await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir })

const master = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '多平台主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const masterId = master.json?.master?.id ?? ''
check('v2 master created', master, (r) => r.status === 200 && /^[0-9a-f]{12}$/.test(masterId))

const v1 = await request('POST', `/api/dsh-growth/v2/masters/${masterId}/variants`, {
  platform: '抖音', account: '主号', riskLevel: '中',
})
const variant1 = v1.json?.variant?.id ?? ''
check('v2 variant created', v1, (r) => r.status === 200 && /^v[0-9a-f]{12}$/.test(variant1))
const v2 = await request('POST', `/api/dsh-growth/v2/masters/${masterId}/variants`, {
  platform: '小红书', account: '种草号', riskLevel: '低',
})
const variant2 = v2.json?.variant?.id ?? ''
check('v2 second variant created', v2, (r) => r.status === 200 && variant2 !== '' && variant2 !== variant1)

const detail = await request('GET', `/api/dsh-growth/v2/masters/${masterId}`)
check('v2 master detail lists 2 variants', detail, (r) => (r.json?.variants ?? []).length === 2)

const badJump = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发' })
check('v2 forbids direct 选题→已发', badJump, (r) => r.status === 400 && String(r.json?.message ?? '').includes('不允许'))

await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '创作中' })
await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '待审' })
await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已排期' })
const highRisk = await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, {
  front: { riskLevel: '高', publishCheck: '6/7' },
})
check('v2 high risk update', highRisk, (r) => r.status === 200)
const highBlocked = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发' })
check('v2 high risk blocked without 7/7', highBlocked, (r) => r.status === 400 && String(r.json?.message ?? '').includes('7 项自检'))
await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, { front: { publishCheck: '7/7' } })
const published = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发', actor: 'tester' })
check('v2 high risk publishes at 7/7', published, (r) => r.status === 200 && r.json?.variant?.status === '已发')

const metric1 = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, {
  date: '2026-11-10', views: '12000', likes: '800', comments: '66', shares: '33', link: 'https://x/1',
})
const metric2 = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, {
  date: '2026-11-10', views: '15000', likes: '900', comments: '70', shares: '40', link: 'https://x/2',
})
check('v2 metric append', metric1, (r) => r.status === 200 && String(r.json?.metric?.entry?.views ?? '') === '12000')
check('v2 metric same day overwrite', metric2, (r) => r.status === 200 && String(r.json?.metric?.entry?.views ?? '') === '15000')
const ledger = path.join(vault, 'Data', '回流台账', '2026-11.md')
const ledgerText = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : ''
check('v2 ledger has one row', { json: ledgerText }, () => (ledgerText.match(/\| 2026-11-10 \|/g) ?? []).length === 1 && ledgerText.includes('15000'))
const withMetrics = await request('GET', `/api/dsh-growth/v2/masters/${masterId}/variants`)
check('v2 variant carries latest metric', withMetrics, (r) => {
  const hit = (r.json?.variants ?? []).find((variant) => variant.id === variant1)
  return String(hit?.latestMetric?.views ?? '') === '15000' && String(hit?.latestMetric?.likes ?? '') === '900'
})

const bypass = await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, { front: { status: '创作中' } })
check('v2 blocks status change via PUT', bypass, (r) => r.status === 400 && String(r.json?.message ?? '').includes('状态只能'))

// 排期只认内容日历：版本要进本月队列/月视图，就得先在日历里排一行。
await request('POST', '/api/dsh-growth/calendar', {
  date: '2026-11-10', platform: '抖音', topic: '多平台主选题', status: '已发',
  topicPath: 'Topics/多平台主选题.md', topicId: masterId,
})
await request('POST', '/api/dsh-growth/calendar', {
  date: '2026-11-11', platform: String(v2.json?.variant?.front?.platform ?? ''), topic: '多平台主选题', status: '选题',
  topicPath: 'Topics/多平台主选题.md', topicId: masterId,
})

const queue = await request('GET', '/api/dsh-growth/v2/queue?month=2026-11')
check('v2 queue includes published variant', queue, (r) => (r.json?.items ?? []).some((item) => item.variant?.id === variant1 && item.variant?.status === '已发'))

const matrix = await request('GET', '/api/dsh-growth/v2/matrix?month=2026-11')
check('v2 matrix includes master', matrix, (r) => (r.json?.rows ?? []).some((row) => row.master?.id === masterId && row.variants.length === 2))

// 「待回流」只收已发布 / 回流中的版本，并且要带上主选题标题 —— 没标题的行点了也没处去。
const pending = await request('GET', '/api/dsh-growth/v2/pending')
check('v2 pending lists published variant', pending, (r) => (r.json?.items ?? []).some((item) => item.variant?.id === variant1
  && String(item.master?.title ?? '') !== ''
  && String(item.master?.path ?? '').startsWith('Topics/')))

// 还停在「选题」的版本没有数据可回流，不能出现在待回流里。
const pendingIds = (pending.json?.items ?? []).map((item) => item.variant?.id)
check('v2 pending hides unpublished variant', pending, () => !pendingIds.includes(variant2))

// 创作台允许打开 Topics/测试/ 下的笔记：直接按 ID 查主选题必须命中，聚合视图仍排除测试数据。
const testMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '测试选题也应有平台版本面板', platform: '抖音', date: '2026-11-07', status: '选题', dir: '测试',
})
const testMasterId = testMaster.json?.master?.id ?? ''
const testDetail = await request('GET', `/api/dsh-growth/v2/masters/${testMasterId}`)
check('v2 direct detail allows test topic', testDetail, (r) => r.status === 200 && r.json?.master?.id === testMasterId)
const matrixAfterTest = await request('GET', '/api/dsh-growth/v2/matrix?month=2026-11')
check('v2 matrix hides test topic', matrixAfterTest, (r) => !(r.json?.rows ?? []).some((row) => row.master?.id === testMasterId))

// 日历把一行标成「已发」时，同选题同平台挂着多个版本：分不清该推哪一个，
// 必须如实回 ambiguous，而不是抓第一个版本推成已发还报成功（曾经的真 bug）。
const multiMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '同日历多版本', platform: '抖音', date: '2026-11-07', status: '选题',
})
const multiId = multiMaster.json?.master?.id ?? ''
const multiPath = multiMaster.json?.master?.path ?? ''
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', account: '主号' })
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', account: '测试号' })
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-21', platform: '抖音', topic: '同日历多版本',
  status: '待发', note: '', link: '', topicPath: multiPath, productPath: '',
})
const calMulti = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const multiRow = (calMulti.json?.entries ?? []).find((entry) => entry.topic === '同日历多版本') ?? {}
const multiPut = await request('PUT', '/api/dsh-growth/calendar', {
  ...multiRow, status: '已发', month: '2026-11', expectedSha1: calMulti.json?.sha1,
})
check('日历标已发：多版本不猜', multiPut, (r) => r.status === 200 && r.json?.advanced?.ambiguous === true)
const multiAfter = await request('GET', `/api/dsh-growth/v2/masters/${multiId}`)
check('日历标已发：多版本一个都没被推', multiAfter, (r) => (r.json?.variants ?? []).every((item) => item.status === '在写'))

// 日历行挂了版本ID之后，同一选题同平台的两个版本必须能各排各的，互不串日期。
const splitMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '同日历拆开排期', platform: '抖音', date: '2026-11-07', status: '选题',
})
const splitId = splitMaster.json?.master?.id ?? ''
const splitPath = splitMaster.json?.master?.path ?? ''
const splitA = (await request('POST', `/api/dsh-growth/v2/masters/${splitId}/variants`, { platform: '抖音', account: '主号' })).json?.variant?.id ?? ''
const splitB = (await request('POST', `/api/dsh-growth/v2/masters/${splitId}/variants`, { platform: '抖音', account: '测试号' })).json?.variant?.id ?? ''
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-23', platform: '抖音', topic: '同日历拆开排期', status: '创作中',
  note: '', link: '', topicPath: splitPath, productPath: '', topicId: splitId, variantId: splitA,
})
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-24', platform: '抖音', topic: '同日历拆开排期', status: '创作中',
  note: '', link: '', topicPath: splitPath, productPath: '', topicId: splitId, variantId: splitB,
})
const splitAfter = await request('GET', `/api/dsh-growth/v2/masters/${splitId}`)
check('同日历同平台多版本各自排期', splitAfter, (r) => {
  const byId = new Map((r.json?.variants ?? []).map((item) => [item.id, item]))
  return String(byId.get(splitA)?.schedule?.date ?? '') === '2026-11-23'
    && String(byId.get(splitB)?.schedule?.date ?? '') === '2026-11-24'
})

// 只有一个版本时照旧要推得动。
const soloMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '同日历单版本', platform: '抖音', date: '2026-11-07', status: '选题',
})
const soloId = soloMaster.json?.master?.id ?? ''
const soloPath = soloMaster.json?.master?.path ?? ''
await request('POST', `/api/dsh-growth/v2/masters/${soloId}/variants`, { platform: '抖音', account: '' })
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-22', platform: '抖音', topic: '同日历单版本',
  status: '待发', note: '', link: '', topicPath: soloPath, productPath: '',
})
const calSolo = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const soloRow = (calSolo.json?.entries ?? []).find((entry) => entry.topic === '同日历单版本') ?? {}
const soloPut = await request('PUT', '/api/dsh-growth/calendar', {
  ...soloRow, status: '已发', month: '2026-11', expectedSha1: calSolo.json?.sha1,
})
check('日历标已发：单版本推得动', soloPut, (r) => r.status === 200 && r.json?.advanced?.ok === true)
const soloAfter = await request('GET', `/api/dsh-growth/v2/masters/${soloId}`)
check('日历标已发：单版本真的变已发', soloAfter, (r) => (r.json?.variants ?? []).some((item) => item.status === '已发'))

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
