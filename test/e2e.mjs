// 端到端路由实测：假 req/res 直接打 handler，跑真实的 vault 读写。
// 用法：node test/e2e.mjs
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-data-'))

let handler = null
const logs = []
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn(message) { logs.push(message) }, error(message) { logs.push(message) } },
  // 传 phantomDataDir 让 config.json 落到临时目录：不传的话它读写的都是真实的
  // ~/.dsh-growth/config.json，会把用户配好的 vaultRoot 覆盖成临时目录（踩过）。
}, { pluginDataDir: dataDir })

// apply() 里的 loadState() 是异步的：等它把旧配置读进内存，再开始打请求，
// 否则第一次 PUT 会和初始化抢同一份 userConfig。
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
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 120) }
  return { status: res.statusCode, json }
}

let failures = 0
function check(label, result, predicate) {
  const passed = predicate(result)
  if (!passed) failures += 1
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(20) + result.status + ' ' + JSON.stringify(result.json).slice(0, 150))
}

check('state', await request('GET', '/api/dsh-growth/state'), (r) => r.status === 200 && r.json.configured === false)
check('config', await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir }), (r) => r.status === 200 && r.json.configured === true)
check('state configured', await request('GET', '/api/dsh-growth/state'), (r) => r.json.configured === true && r.json.config.vaultRoot === vault)
check('overview empty', await request('GET', '/api/dsh-growth/overview'), (r) => r.status === 200)
check('ideas add', await request('POST', '/api/dsh-growth/ideas', { content: '把差评做成选题', source: '客服' }), (r) => r.status === 200)
check('ideas list', await request('GET', '/api/dsh-growth/ideas'), (r) => r.status === 200 && JSON.stringify(r.json).includes('差评'))
check('calendar add', await request('POST', '/api/dsh-growth/calendar', { month: '2026-11', date: '2026-11-08', platform: '小红书', topic: '冬季外套测评', status: '选题' }), (r) => r.status === 200)
check('calendar list', await request('GET', '/api/dsh-growth/calendar?month=2026-11'), (r) => r.status === 200)

// P0：日历的关联键（选题笔记 / 商品档案）要能写进表、再从表里读回来。
check('calendar add with links', await request('POST', '/api/dsh-growth/calendar', { month: '2026-11', date: '2026-11-09', platform: '抖音', topic: '挂货那条', status: '创作中', note: '晚上发', link: 'https://p', topicPath: 'Topics/羽绒服.md', productPath: 'Products/竞品A.md' }), (r) => r.status === 200)
const calWithLinks = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
check('calendar links roundtrip', calWithLinks, (r) => {
  const row = (r.json.entries ?? []).find((item) => item.topic === '挂货那条')
  return row !== undefined && row.topicPath === 'Topics/羽绒服.md' && row.productPath === 'Products/竞品A.md' && row.note === '晚上发' && row.link === 'https://p'
})
// 冲突恢复：用旧 sha1 写 → 409 conflict，且要把盘上最新内容一并带回去（前端靠它弹「用我的 / 用他的」）。
const topicCreated = await request('POST', '/api/dsh-growth/topics/create', { title: '冲突探针', platform: '抖音', date: '2026-11-02' })
const conflictPath = topicCreated.json?.created?.path ?? topicCreated.json?.path ?? ''
const beforeWrite = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(conflictPath))
const staleSha = beforeWrite.json?.record?.sha1 ?? ''
check('conflict setup', beforeWrite, (r) => r.status === 200 && typeof r.json?.record?.sha1 === 'string' && r.json.record.sha1 !== '')
// 先写一次，把 sha1 弄旧
await request('PUT', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(conflictPath), { body: '地上变了。', front: {}, expectedSha1: staleSha })
const conflictResult = await request('PUT', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(conflictPath), { body: '本地改的。', front: {}, expectedSha1: staleSha })
check('conflict returns 409', conflictResult, (r) => r.status === 409 && r.json.code === 'conflict')
check('conflict carries latest', conflictResult, (r) => typeof r.json.currentSha1 === 'string' && r.json.currentSha1 !== '' && typeof r.json.currentText === 'string' && r.json.currentText.includes('地上变了'))
// 用最新 sha1 重写（即「用我的覆盖」）应该成功
const forceWrite = await request('PUT', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(conflictPath), { body: '本地改的。', front: {}, expectedSha1: conflictResult.json.currentSha1 })
check('conflict overwrite ok', forceWrite, (r) => r.status === 200)

check('topics create', await request('POST', '/api/dsh-growth/topics/create', { title: '爆款拆解-羽绒服', platform: '抖音', date: '2026-11-01', link: 'https://x' }), (r) => r.status === 200)
check('topics list', await request('GET', '/api/dsh-growth/topics/list?limit=10'), (r) => r.status === 200 && JSON.stringify(r.json).includes('羽绒服'))
check('campaigns create', await request('POST', '/api/dsh-growth/campaigns/create', { title: '双十一预热', platform: '小红书', status: '进行中', start: '2026-11-01', end: '2026-11-11', budget: '50000', goal: 'GMV 80万' }), (r) => r.status === 200)
check('products create', await request('POST', '/api/dsh-growth/products/create', { title: '竞品A', kind: '竞品', platform: '天猫', price: '399', sales: '1.2万', tags: '外套' }), (r) => r.status === 200)
check('data create', await request('POST', '/api/dsh-growth/data/create', { period: '2026-W44', title: '2026-W44', gmv: '120000', traffic: '34000', conv: '3.2%', roi: '4.1', mom: '+12%' }), (r) => r.status === 200)
check('rules get', await request('GET', '/api/dsh-growth/rules'), (r) => r.status === 200)
check('glossary add', await request('POST', '/api/dsh-growth/glossary', { zh: 'GMV', en: 'Gross Merchandise Volume', domain: '电商', tags: '核心指标', note: '成交总额' }), (r) => r.status === 200)
check('glossary list', await request('GET', '/api/dsh-growth/glossary'), (r) => r.status === 200 && JSON.stringify(r.json).includes('GMV'))
check('sop tree', await request('GET', '/api/dsh-growth/sop'), (r) => r.status === 200)
check('search', await request('GET', '/api/dsh-growth/search?q=' + encodeURIComponent('差评')), (r) => r.status === 200)
// P1-2 平台归一：B站 / bilibili / 哔哩哔哩 是同一个平台，读出来的 platform 收敛成「B站」；
// 但认不出来的自定义平台原样保留（绝不替用户改写）。
await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-08', platform: 'bilibili', topic: '别名平台', status: '选题', note: '', link: '', topicPath: '', productPath: '' })
await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-09', platform: '我自己的博客', topic: '自定义平台', status: '选题', note: '', link: '', topicPath: '', productPath: '' })
const platCal = await request('GET', '/api/dsh-growth/calendar?month=2026-12')
check('platform alias normalises to B站', platCal, (r) => {
  const row = (r.json.entries ?? []).find((entry) => entry.topic === '别名平台')
  return row?.platform === 'B站'
})
check('custom platform kept verbatim', platCal, (r) => {
  const row = (r.json.entries ?? []).find((entry) => entry.topic === '自定义平台')
  return row?.platform === '我自己的博客'
})
check('calendar returns platform options', platCal, (r) => {
  const list = r.json.platforms ?? []
  return list.includes('B站') && list.includes('小红书') && !list.includes('bilibili')
})

// 已发布只能由绑定平台版本的“确认已发布”动作产生，不能在新建日历时直接伪造。
const directPublished = await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-03', platform: '抖音', topic: '十二月已发', status: '已发', note: '', link: '', topicPath: 'Topics/羽绒服.md', productPath: '' })
check('calendar cannot create 已发 directly', directPublished, (r) => r.status === 400 && r.json.code === 'bad_request')
const unboundPublished = await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-01', platform: '小红书', topic: '没挂选题的已发', status: '已发', note: '', link: '', topicPath: '', productPath: '' })
check('unbound calendar cannot create publish fact', unboundPublished, (r) => r.status === 400 && r.json.code === 'bad_request')
await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-05', platform: '抖音', topic: '还没发', status: '创作中', note: '', link: '', topicPath: '', productPath: '' })
const pending = await request('GET', '/api/dsh-growth/pending')
check('rejected publish creates no pending gap', pending, (r) => r.status === 200 && (r.json.rows ?? []).length === 0)
check('pending sorted by date desc', pending, (r) => {
  const dates = (r.json.rows ?? []).map((row) => String(row.date))
  return dates.every((value, index) => index === 0 || dates[index - 1] >= value)
})
check('pending total counts the gap rows it actually returns', pending, (r) =>
  Number(r.json.total ?? -1) === (r.json.rows ?? []).length)
const topicsList = await request('GET', '/api/dsh-growth/topics/list?limit=50')
const realTopicPath = (topicsList.json.records ?? []).map((r) => r.path).find((p) => p.includes('羽绒服')) ?? 'Topics/羽绒服.md'
const pendingRow = (pending.json.rows ?? []).find((row) => row.topic === '十二月已发')
// 旧的双写入口已删除：同一份播放量以前既写选题 frontmatter、又写回流台账，
// 榜单读台账、选题卡读 frontmatter，两边永远对不上。现在只留
// POST /v2/variants/:id/metrics（覆盖在 v2.test.mjs），/pending 退化成只读的缺口列表。
const goneWriteback = await request('POST', '/api/dsh-growth/pending/writeback', { items: [] })
check('legacy writeback route is gone', goneWriteback, (r) => r.status === 404 && r.json.ok === false)
const pendingReadOnly = await request('GET', '/api/dsh-growth/pending')
check('pending remains read-only and empty', pendingReadOnly, (r) => r.status === 200 && (r.json.rows ?? []).length === 0)

// ── 回归：挂了选题笔记的日历行，改主题不换 id（P0-a 断点 B 已修）──
const renameNew = await request('POST', '/api/dsh-growth/calendar', { month: '2026-12', date: '2026-12-20', platform: '小红书', topic: '改名前', status: '选题', note: '', link: '', topicPath: 'Topics/爆款拆解-羽绒服.md', productPath: '' })
const renameEntries = renameNew.json.table?.entries ?? renameNew.json.entries ?? renameNew.json.calendar?.entries ?? []
const renameRow = renameEntries.find((entry) => entry.topic === '改名前') ?? {}
const renameId = renameRow.id
const renamedPut = await request('PUT', '/api/dsh-growth/calendar', {
  month: '2026-12', id: renameId, date: '2026-12-20', platform: '小红书', topic: '改名后', status: '选题', note: '', link: '', topicPath: 'Topics/爆款拆解-羽绒服.md', productPath: '',
})
check('calendar rename keeps id', renamedPut, (r) => r.json.ok === true && r.json.entry?.id === renameId && r.json.entry?.topic === '改名后')

check('unknown route', await request('GET', '/api/dsh-growth/nope'), (r) => r.status === 404 && r.json.ok === false)
check('overview final', await request('GET', '/api/dsh-growth/overview'), (r) => r.status === 200 && typeof r.json === 'object')
// overview 里要能数出还在等回流的条数（挂货那条是「创作中」，不算；十二月已发已回写，也不算）。
check('overview pendingCount numeric', await request('GET', '/api/dsh-growth/overview'), (r) => r.status === 200 && typeof (r.json.summary?.pendingCount ?? r.json.pendingCount) === 'number')

console.log('\nvault dirs:', fs.readdirSync(vault).join(', '))
const calendar = path.join(vault, 'Calendar', '2026-11.md')
if (fs.existsSync(calendar)) console.log('\nCalendar/2026-11.md:\n' + fs.readFileSync(calendar, 'utf8'))
const topicDir = path.join(vault, 'Topics')
if (fs.existsSync(topicDir)) {
  for (const name of fs.readdirSync(topicDir)) {
    console.log('\nTopics/' + name + ':\n' + fs.readFileSync(path.join(topicDir, name), 'utf8').slice(0, 500))
  }
}
if (logs.length > 0) console.log('\nlogs:', logs.slice(0, 6))
console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
