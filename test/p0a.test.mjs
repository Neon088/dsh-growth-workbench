// P0-a 数据完整性回归：sourceUrl、稳定 id、日历行 id、状态口径、回写预检。
// 用法：node test/p0a.test.mjs
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-p0a-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-p0a-data-'))

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
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 120) }
  return { status: res.statusCode, json }
}

let failures = 0
function check(label, result, predicate) {
  const passed = predicate(result)
  if (!passed) failures += 1
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(34) + result.status + ' ' + JSON.stringify(result.json).slice(0, 180))
}

await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir })

// 1) 灵感 → 选题：sourceUrl / sourceTitle 必须跟着走，选题必须有稳定 id。
const idea = await request('POST', '/api/dsh-growth/ideas', {
  content: '办公室抽屉换气泡水',
  source: '抖音评论',
  sourceUrl: 'https://example.com/source-1',
})
const ideaId = idea.json?.entry?.id ?? idea.json?.entries?.[0]?.id ?? ''
check('idea created', idea, (r) => r.status === 200 && ideaId !== '')
const promoted = await request('POST', '/api/dsh-growth/ideas/promote', { id: ideaId, platform: '抖音' })
const topicPath = promoted.json?.created?.path ?? promoted.json?.path ?? ''
check('promote returns topic', promoted, (r) => r.status === 200 && topicPath !== '')
const topic1 = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath))
const topicId = topic1.json?.record?.front?.id ?? ''
check('topic has stable id', topic1, (r) => typeof topicId === 'string' && /^[0-9a-f]{12}$/.test(topicId))
check('sourceUrl preserved', topic1, (r) => r.json?.record?.front?.sourceUrl === 'https://example.com/source-1')
check('sourceTitle preserved', topic1, (r) => r.json?.record?.front?.sourceTitle === '办公室抽屉换气泡水')

// 1b) 灵感 → 做选题：type 必须是「选题」，没给平台时先落「待定」。
const ideaTopic = await request('POST', '/api/dsh-growth/ideas', { content: '做选题的临时灵感', source: '评论' })
const ideaTopicId = ideaTopic.json?.entry?.id ?? ''
check('idea for topic created', ideaTopic, (r) => r.status === 200 && ideaTopicId !== '')
const promotedTopic = await request('POST', '/api/dsh-growth/ideas/promote', { id: ideaTopicId, type: '选题' })
const topicPath2 = promotedTopic.json?.created?.path ?? ''
check('promote to own topic', promotedTopic, (r) => r.status === 200 && topicPath2 !== '')
const topicOwn = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath2))
check('own topic type is 选题', topicOwn, (r) => r.json?.record?.front?.type === '选题')
check('own topic platform fallback', topicOwn, (r) => r.json?.record?.front?.platform === '待定')

// 2) 选题更新不能换 id。
const topicSha = topic1.json?.record?.sha1 ?? ''
const updated = await request('PUT', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath), {
  front: { status: '创作中' },
  expectedSha1: topicSha,
})
check('topic update ok', updated, (r) => r.status === 200)
const topic2 = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath))
check('topic id survives update', topic2, (r) => r.json?.record?.front?.id === topicId && r.json?.record?.front?.status === '创作中')

// 3) 日历挂上选题时写 topicId；改主题不换行 id。
const calAdd = await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-11', platform: '抖音', topic: '排期原名', status: '选题',
  note: '', link: '', topicPath, productPath: '',
})
const calId = calAdd.json?.entry?.id ?? calAdd.json?.table?.entries?.find((entry) => entry.topic === '排期原名')?.id ?? ''
check('calendar row created', calAdd, (r) => r.status === 200 && calId !== '')
const calBefore = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const calRow = (calBefore.json?.entries ?? []).find((entry) => entry.topic === '排期原名')
check('calendar row has topicId', calBefore, () => calRow !== undefined && calRow.topicId === topicId)
const renamedCal = await request('PUT', '/api/dsh-growth/calendar', {
  ...calRow, month: '2026-11', topic: '排期改名', status: '创作中',
})
check('calendar rename keeps id', renamedCal, (r) => r.status === 200 && (r.json?.entry?.id ?? '') === calId)
const calAfter = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
check('calendar renamed row readable', calAfter, (r) => (r.json?.entries ?? []).some((entry) => entry.id === calId && entry.topic === '排期改名'))

// 4) 状态口径：日历创作中、笔记也创作中，topics/list 和 overview 必须一致。
const topicsList = await request('GET', '/api/dsh-growth/topics/list?limit=200')
const listRow = (topicsList.json?.records ?? []).find((record) => record.path === topicPath)
check('topics list stage=doing', topicsList, () => listRow?.stage === 'doing')
const overview = await request('GET', '/api/dsh-growth/overview')
check('overview topicsDoing matches', overview, (r) => (r.json?.summary?.topicsDoing ?? 0) >= 1)

// 5) 旧的 /pending/writeback 已删除：播放量只有一个写入口（平台版本 → 回流台账）。
//    这里断言它确实不存在，避免有人又把它加回来、把同一份数字写散到两处。
const beforeBad = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath))
const badWrite = await request('POST', '/api/dsh-growth/pending/writeback', {
  items: [{ id: 'no-such-row', month: '2026-11', topicPath, views: '999', likes: '99', link: '' }],
})
check('legacy writeback route removed', badWrite, (r) => r.status === 404)
const afterBad = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(topicPath))
check('removed writeback cannot touch topic', afterBad, (r) => r.json?.record?.front?.status === beforeBad.json?.record?.front?.status && String(r.json?.record?.front?.views ?? '') === String(beforeBad.json?.record?.front?.views ?? ''))

// 6) 老 8 列日历必须还能读，且 topicId 为空时不合并同天同平台多行。
const legacy = ['---', '', '| 日期 | 平台 | 主题 | 状态 | 备注 | 链接 | 选题笔记 | 商品档案 |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2026-09-01 | 抖音 | 老行一 | 已发 |  |  |  |  |',
  '| 2026-09-01 | 抖音 | 老行二 | 已发 |  |  |  |  |', '', '---', ''].join('\n')
fs.mkdirSync(path.join(vault, 'Calendar'), { recursive: true })
fs.writeFileSync(path.join(vault, 'Calendar', '2026-09.md'), legacy, 'utf8')
const legacyRead = await request('GET', '/api/dsh-growth/calendar?month=2026-09')
check('legacy 8-col rows both survive', legacyRead, (r) => (r.json?.entries ?? []).filter((entry) => String(entry.topic).startsWith('老行')).length === 2)

// 7) 没有 frontmatter 的自由笔记（如回流台账）必须能只改正文保存，
//    不能被 Data 板 schema 的必填「周期」误拦。
fs.mkdirSync(path.join(vault, 'Data', '回流台账'), { recursive: true })
const ledgerRel = 'Data/回流台账/2026-11.md'
fs.writeFileSync(path.join(vault, ledgerRel), '# 回流台账 2026-11\n\n| 日期 | 平台 | 播放 |\n| --- | --- | --- |\n| 2026-11-07 | 抖音 | 100 |\n', 'utf8')
const ledgerGet = await request('GET', '/api/dsh-growth/data/record?path=' + encodeURIComponent(ledgerRel))
check('free note has empty front', ledgerGet, (r) => r.status === 200 && Object.keys(r.json?.record?.front ?? {}).length === 0)
const ledgerPut = await request('PUT', '/api/dsh-growth/data/record?path=' + encodeURIComponent(ledgerRel), {
  body: '# 回流台账 2026-11\n\n| 日期 | 平台 | 播放 |\n| --- | --- | --- |\n| 2026-11-08 | 抖音 | 200 |\n',
  front: {},
  expectedSha1: ledgerGet.json?.record?.sha1,
})
check('body-only save on free note', ledgerPut, (r) => r.status === 200)
check('free note body persisted', { status: 200, json: {} }, () => fs.readFileSync(path.join(vault, ledgerRel), 'utf8').includes('2026-11-08'))

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
