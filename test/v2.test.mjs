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
const accountMain = await request('POST', '/api/dsh-growth/accounts/create', {
  title: '主号', name: '主号', platform: '抖音', status: '启用',
})
const accountTest = await request('POST', '/api/dsh-growth/accounts/create', {
  title: '测试号', name: '测试号', platform: '抖音', status: '启用',
})
const accountTarget = await request('POST', '/api/dsh-growth/accounts/create', {
  title: '目标号', name: '目标号', platform: 'B站', status: '启用',
})
const accountList = await request('GET', '/api/dsh-growth/accounts/list?limit=20')
const accountMainId = String((accountList.json?.records ?? []).find((item) => item.front?.name === '主号')?.front?.id ?? '')
const accountTestId = String((accountList.json?.records ?? []).find((item) => item.front?.name === '测试号')?.front?.id ?? '')
const accountTargetId = String((accountList.json?.records ?? []).find((item) => item.front?.name === '目标号')?.front?.id ?? '')

const master = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '多平台主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const masterId = master.json?.master?.id ?? ''
check('v2 master created', master, (r) => r.status === 200 && /^[0-9a-f]{12}$/.test(masterId))

const v1 = await request('POST', `/api/dsh-growth/v2/masters/${masterId}/variants`, {
  platform: '抖音', accountId: accountMainId, riskLevel: '中',
})
const variant1 = v1.json?.variant?.id ?? ''
check('v2 variant created', v1, (r) => r.status === 200 && /^v[0-9a-f]{12}$/.test(variant1))
const v2 = await request('POST', `/api/dsh-growth/v2/masters/${masterId}/variants`, {
  platform: '小红书', account: '', riskLevel: '低',
})
const variant2 = v2.json?.variant?.id ?? ''
check('v2 second variant created', v2, (r) => r.status === 200 && variant2 !== '' && variant2 !== variant1)

const detail = await request('GET', `/api/dsh-growth/v2/masters/${masterId}`)
check('v2 master detail lists 2 variants', detail, (r) => (r.json?.variants ?? []).length === 2)

const badJump = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发' })
check('v2 forbids direct 选题→已发', badJump, (r) => r.status === 400 && String(r.json?.message ?? '').includes('不允许'))

await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '待发' })
const highRisk = await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, {
  front: { riskLevel: '高' },
})
check('v2 high risk update', highRisk, (r) => r.status === 200)
const highBlocked = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发' })
// 门禁按 vault 里那份 SOP 清单的真实条数算，不再认写死的「7/7」。
// 这个临时 vault 没有 SOP 清单文件 → 清单读不到 → 高风险必须被拦住，并说清去哪儿补。
check('v2 high risk blocked without checklist', highBlocked, (r) => r.status === 400 && String(r.json?.message ?? '').includes('没找到这份清单'))

// 旧台账有两种真实表头：10 列，和 11 列（第 11 列是后来删掉的「备注」）。
// 它们必须能读、能继续追加，且旧行不能串到「完播率」；电商复盘列表也不能把
// 回流台账文件当成空白记录展示。
const ledgerDir = path.join(vault, 'Data', '回流台账')
fs.mkdirSync(ledgerDir, { recursive: true })
fs.writeFileSync(path.join(ledgerDir, '2026-09.md'), [
  '# 回流台账 2026-09',
  '',
  '| 日期 | 主选题ID | 平台版本ID | 平台 | 账号 | 播放/阅读 | 赞/收藏 | 评论 | 转发 | 链接 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2026-09-28 | t-old | v-old10 | 抖音 |  | 92000 | 4100 | 220 | 640 | https://v.douyin.com/old10 |',
  '',
].join('\n'), 'utf8')
fs.writeFileSync(path.join(ledgerDir, '2026-10.md'), [
  '# 回流台账 2026-10',
  '',
  '| 日期 | 主选题ID | 平台版本ID | 平台 | 账号 | 播放/阅读 | 赞/收藏 | 评论 | 转发 | 链接 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2026-10-28 | t-old | v-old11 | 抖音 |  | 123 | 45 | 6 | 7 | https://v.douyin.com/old11 | 旧备注 |',
  '',
].join('\n'), 'utf8')
const legacyLedger = await request('GET', '/api/dsh-growth/v2/ledger?month=2026-09')
check('v2 legacy 10-col ledger is readable', legacyLedger, (r) => (r.json?.rows ?? []).some((row) => row.variantId === 'v-old10' && String(row.views) === '92000'))
const legacyElevenLedger = await request('GET', '/api/dsh-growth/v2/ledger?month=2026-10')
check('v2 legacy 11-col ledger drops old note column', legacyElevenLedger, (r) => (r.json?.rows ?? []).some((row) => row.variantId === 'v-old11'
  && String(row.views) === '123' && String(row.completion ?? '') === '' && String(row.link) === 'https://v.douyin.com/old11'))
const dataListWithoutLedger = await request('GET', '/api/dsh-growth/data/list?limit=100')
check('data list excludes ledger note files', dataListWithoutLedger, (r) => (r.json?.records ?? []).every((record) => !String(record.path ?? '').includes('/回流台账/')))
// 放一份 SOP 清单进去：3 条（故意不是 7 条），门禁必须跟着它走。
const sopDir = path.join(vault, 'SOP', '运营SOP')
fs.mkdirSync(sopDir, { recursive: true })
fs.writeFileSync(path.join(sopDir, '发布前检查清单.md'), [
  '# 发布前检查清单', '',
  '- 标题不超过平台字数上限，且含一个具体数字',
  '- 前 3 秒出现结论，不寒暄',
  '- 封面文字 ≤ 8 个字，手机上看清', '',
].join('\n'), 'utf8')
const checklist = await request('GET', '/api/dsh-growth/v2/checklist')
check('v2 checklist comes from the SOP file', checklist, (r) => r.status === 200 && r.json?.total === 3
  && (r.json?.items ?? []).every((item) => typeof item.id === 'string' && item.id !== ''))
const stillBlocked = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '已发' })
check('v2 high risk blocked until checklist done', stillBlocked, (r) => r.status === 400 && String(r.json?.message ?? '').includes('3 项勾完'))
// 勾选用条目 id（不是序号）—— 前端改一份 SOP 清单，勾选状态不能跑位。
const itemIds = (checklist.json?.items ?? []).map((item) => item.id)
await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, { front: { publishCheckItems: itemIds.join(',') } })
const published = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, {
  to: '已发', actor: 'tester', at: '2020-11-01T10:00:00+08:00', reviewDays: 7,
})
check('v2 high risk publishes at full checklist', published, (r) => r.status === 200 && r.json?.variant?.status === '已发')

const appendLegacy = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, { date: '2026-09-29', views: '7', likes: '2' })
check('v2 can append into a legacy 10-col ledger', appendLegacy, (r) => r.status === 200 && String(r.json?.metric?.entry?.views ?? '') === '7')
const upgradedLegacy = fs.readFileSync(path.join(ledgerDir, '2026-09.md'), 'utf8')
check('v2 legacy ledger upgrades header without losing old row', { json: upgradedLegacy }, () => upgradedLegacy.includes('统计口径')
  && upgradedLegacy.includes('https://v.douyin.com/old10') && upgradedLegacy.includes('| 2026-09-29 |'))

const metric1 = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, {
  date: '2026-11-10', views: '12000', likes: '800', comments: '66', shares: '33', link: 'https://x/1',
  source: '平台后台', caliber: '自然累计',
})
const metric2 = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, {
  date: '2026-11-10', views: '15000', link: 'https://x/2',
})
check('v2 metric append', metric1, (r) => r.status === 200 && String(r.json?.metric?.entry?.views ?? '') === '12000')
check('v2 metric same day overwrite', metric2, (r) => r.status === 200 && String(r.json?.metric?.entry?.views ?? '') === '15000')
check('v2 metric same day patch keeps omitted fields', metric2, (r) => String(r.json?.metric?.entry?.likes ?? '') === '800'
  && String(r.json?.metric?.entry?.comments ?? '') === '66' && Number(r.json?.metric?.entry?.revision) === 2
  && String(r.json?.metric?.entry?.recordedAt ?? '') !== '' && String(r.json?.metric?.entry?.updatedAt ?? '') !== '')
const ledger = path.join(vault, 'Data', '回流台账', '2026-11.md')
const ledgerText = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : ''
check('v2 ledger has one row', { json: ledgerText }, () => (ledgerText.match(/\| 2026-11-10 \|/g) ?? []).length === 1 && ledgerText.includes('15000'))
const withMetrics = await request('GET', `/api/dsh-growth/v2/masters/${masterId}/variants`)
check('v2 variant carries latest metric', withMetrics, (r) => {
  const hit = (r.json?.variants ?? []).find((variant) => variant.id === variant1)
  return String(hit?.latestMetric?.views ?? '') === '15000' && String(hit?.latestMetric?.likes ?? '') === '800'
})

const collecting = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/transition`, { to: '待回填' })
check('v2 published variant enters review', collecting, (r) => r.status === 200 && r.json?.variant?.status === '待回填')
const closeMetricId = String(metric2.json?.metric?.entry?.metricId ?? '')
const closed = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/close-review`, { metricId: closeMetricId, actor: 'tester' })
check('v2 review closes against one frozen snapshot', closed, (r) => r.status === 200 && r.json?.variant?.status === '已结案'
  && String(r.json?.variant?.reviewPath ?? '').includes('Workbench/复盘结案/'))
const reviewPath = String(closed.json?.variant?.reviewPath ?? '')
const reviewText = reviewPath !== '' && fs.existsSync(path.join(vault, reviewPath)) ? fs.readFileSync(path.join(vault, reviewPath), 'utf8') : ''
check('v2 frozen review preserves snapshot values', { json: reviewText }, () => reviewText.includes('"views": "15000"') && reviewText.includes('"likes": "800"'))
const postCloseMetric = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/metrics`, {
  date: '2026-11-11', views: '18000', source: '平台后台', caliber: '自然累计',
})
check('v2 closed review still accepts later snapshots', postCloseMetric, (r) => r.status === 200)
const closedState = await request('GET', `/api/dsh-growth/v2/variants/${variant1}`)
check('v2 later snapshot flags closed review for recheck', closedState, (r) => r.json?.variant?.hasNewDataAfterClose === true)
const reopened = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/start-review`, { reviewDays: 10 })
check('v2 starts a distinct next review cycle', reopened, (r) => r.status === 200 && r.json?.variant?.status === '待回填'
  && String(r.json?.variant?.front?.reviewCycle ?? '') === '2' && String(r.json?.variant?.front?.reviewDays ?? '') === '10')

const bypass = await request('PUT', `/api/dsh-growth/v2/variants/${variant1}`, { front: { status: '创作中' } })
check('v2 blocks status change via PUT', bypass, (r) => r.status === 400 && String(r.json?.message ?? '').includes('状态只能'))

// 排期只认内容日历：版本要进本月队列/月视图，就得先在日历里排一行。
await request('POST', '/api/dsh-growth/calendar', {
  date: '2026-11-10', platform: '抖音', topic: '多平台主选题', status: '待发',
  topicPath: 'Topics/多平台主选题.md', topicId: masterId, variantId: variant1,
})
await request('POST', '/api/dsh-growth/calendar', {
  date: '2026-11-11', platform: String(v2.json?.variant?.front?.platform ?? ''), topic: '多平台主选题', status: '选题',
  topicPath: 'Topics/多平台主选题.md', topicId: masterId,
})

const queue = await request('GET', '/api/dsh-growth/v2/queue?month=2026-11')
check('v2 queue excludes published variant', queue, (r) => !(r.json?.items ?? []).some((item) => item.variant?.id === variant1))

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
const overviewAtPending = await request('GET', '/api/dsh-growth/overview')
check('overview pendingCount matches the rows the pending card actually lists', overviewAtPending, (r) =>
  Number(r.json?.summary?.pendingCount ?? -1) === pendingIds.length)

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
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', accountId: accountMainId })
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', accountId: accountTestId })
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-21', platform: '抖音', topic: '同日历多版本',
  status: '待发', note: '', link: '', topicPath: multiPath, productPath: '',
})
const calMulti = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const multiRow = (calMulti.json?.entries ?? []).find((entry) => entry.topic === '同日历多版本') ?? {}
const multiPut = await request('PUT', '/api/dsh-growth/calendar', {
  ...multiRow, status: '已发', month: '2026-11', expectedSha1: calMulti.json?.sha1,
})
// 现在是「整条拒绝」而不是「回一个 ambiguous 字段」：推不动就别写日历，
// 日历一个字节都不改（以前先写日历再推版本，推不动还返回 200，两本账从此对不上）。
check('日历标已发：多版本整条拒绝', multiPut, (r) => r.status === 409 && String(r.json?.message ?? '').includes('版本'))
const calMultiAfter = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const multiRowAfter = (calMultiAfter.json?.entries ?? []).find((entry) => entry.topic === '同日历多版本') ?? {}
check('日历标已发：拒绝后日历没被改', calMultiAfter, () => String(multiRowAfter.status ?? '') === '待发')
const multiAfter = await request('GET', `/api/dsh-growth/v2/masters/${multiId}`)
check('日历标已发：多版本一个都没被推', multiAfter, (r) => (r.json?.variants ?? []).every((item) => item.status === '在写'))

// 日历行挂了版本ID之后，同一选题同平台的两个版本必须能各排各的，互不串日期。
const splitMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '同日历拆开排期', platform: '抖音', date: '2026-11-07', status: '选题',
})
const splitId = splitMaster.json?.master?.id ?? ''
const splitPath = splitMaster.json?.master?.path ?? ''
const splitA = (await request('POST', `/api/dsh-growth/v2/masters/${splitId}/variants`, { platform: '抖音', accountId: accountMainId })).json?.variant?.id ?? ''
const splitB = (await request('POST', `/api/dsh-growth/v2/masters/${splitId}/variants`, { platform: '抖音', accountId: accountTestId })).json?.variant?.id ?? ''
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
  publishedAt: '2020-11-01T10:00:00+08:00', reviewDays: 7,
})
check('日历标已发：单版本推得动', soloPut, (r) => r.status === 200 && r.json?.advanced?.ok === true)
const soloAfter = await request('GET', `/api/dsh-growth/v2/masters/${soloId}`)
check('日历标已发：单版本真的变已发', soloAfter, (r) => (r.json?.variants ?? []).some((item) => item.status === '已发'))

// 创建时选错平台或账号后，专用纠正动作要同步版本、所有历史快照和日历；
// 版本 ID 与文件路径保持不变，已有同平台同账号版本时拒绝合并。
const beforeCorrection = await request('GET', `/api/dsh-growth/v2/variants/${variant1}`)
const originalVariantPath = String(beforeCorrection.json?.variant?.path ?? '')
const corrected = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/correct-identity`, { accountId: accountTargetId })
check('纠正归属更新版本且身份稳定', corrected, (r) => r.status === 200
  && r.json?.variant?.front?.platform === 'B站' && r.json?.variant?.front?.account === '目标号'
  && r.json?.variant?.front?.accountId === accountTargetId && r.json?.variant?.path === originalVariantPath)
const correctedCalendar = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
check('纠正归属同步关联日历', correctedCalendar, (r) => (r.json?.entries ?? []).filter((entry) => entry.variantId === variant1)
  .every((entry) => entry.platform === 'B站' && entry.account === '目标号'))
const correctedLedger = await request('GET', '/api/dsh-growth/v2/ledger')
const correctedRows = correctedLedger.json?.rows?.filter((row) => row.variantId === variant1) ?? []
check('纠正归属同步全部历史快照', correctedLedger, () => correctedRows.length >= 3
  && correctedRows.every((row) => row.platform === 'B站' && row.account === '目标号'))

const conflictVariant = await request('POST', `/api/dsh-growth/v2/masters/${masterId}/variants`, {
  platform: '抖音', accountId: accountTestId,
})
check('纠正归属冲突夹具已建立', conflictVariant, (r) => r.status === 200)
const identityConflict = await request('POST', `/api/dsh-growth/v2/variants/${variant1}/correct-identity`, { accountId: accountTestId })
check('纠正归属拒绝同平台同账号合并', identityConflict, (r) => r.status === 409 && String(r.json?.message ?? '').includes('同平台同账号'))
const afterConflict = await request('GET', `/api/dsh-growth/v2/variants/${variant1}`)
check('归属冲突不会改动原版本', afterConflict, (r) => r.json?.variant?.front?.platform === 'B站'
  && r.json?.variant?.front?.accountId === accountTargetId)

// 待回填任务顺序由服务端统一给出：逾期、今日截止、未录入、最近截止。
// 只有状态文字、没有实际发布时间的旧记录不属于已发布事实，不能混入回填队列。
const localDay = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const take = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return take('year') + '-' + take('month') + '-' + take('day')
}
const nowIso = new Date(Date.now() - 1000).toISOString()
async function publishedFixture(title, reviewDays, withMetric = false) {
  const createdMaster = await request('POST', '/api/dsh-growth/v2/masters', { title, platform: 'B站', date: localDay(), status: '在写' })
  const id = String(createdMaster.json?.master?.id ?? '')
  const made = await request('POST', `/api/dsh-growth/v2/masters/${id}/variants`, { platform: 'B站', accountId: accountTargetId })
  const variantId = String(made.json?.variant?.id ?? '')
  await request('POST', `/api/dsh-growth/v2/variants/${variantId}/transition`, { to: '待发' })
  await request('POST', `/api/dsh-growth/v2/variants/${variantId}/transition`, { to: '已发', at: nowIso, reviewDays })
  if (withMetric) await request('POST', `/api/dsh-growth/v2/variants/${variantId}/metrics`, { date: localDay(), views: '1' })
  return variantId
}
const dueTodayId = await publishedFixture('今天截止夹具', 1)
const unrecordedId = await publishedFixture('未录入夹具', 7)
const upcomingId = await publishedFixture('观察中夹具', 7, true)
const missingMaster = await request('POST', '/api/dsh-growth/v2/masters', { title: '缺发布时间夹具', platform: 'B站', date: localDay(), status: '在写' })
const missingId = 'v-missing-published-at'
const missingReviewId = 'v-missing-review-due'
const missingDir = path.join(vault, 'Workbench', '平台版本', String(missingMaster.json?.master?.id ?? ''))
fs.mkdirSync(missingDir, { recursive: true })
fs.writeFileSync(path.join(missingDir, 'legacy.md'), `---\nid: ${missingId}\nmasterId: ${missingMaster.json?.master?.id ?? ''}\nplatform: B站\naccount: 目标号\naccountId: ${accountTargetId}\nstatus: 已发\n---\n`, 'utf8')
fs.writeFileSync(path.join(missingDir, 'legacy-review.md'), `---\nid: ${missingReviewId}\nmasterId: ${missingMaster.json?.master?.id ?? ''}\nplatform: 抖音\nstatus: 已发\npublishedAt: '${nowIso}'\n---\n`, 'utf8')
const orderedPending = await request('GET', '/api/dsh-growth/v2/pending')
const ordered = orderedPending.json?.items ?? []
const ranks = ordered.map((item) => Number(item.reviewTask?.rank))
check('待回填任务按优先级稳定排序', orderedPending, (r) => r.status === 200
  && ranks.every((rank, index) => index === 0 || ranks[index - 1] <= rank)
  && ordered.find((item) => item.variant?.id === dueTodayId)?.reviewTask?.kind === 'due_today'
  && ordered.find((item) => item.variant?.id === unrecordedId)?.reviewTask?.kind === 'unrecorded'
  && ordered.find((item) => item.variant?.id === upcomingId)?.reviewTask?.kind === 'upcoming'
  && ordered.find((item) => item.variant?.id === missingReviewId)?.reviewTask?.kind === 'unscheduled_review'
  && ordered.every((item) => item.variant?.id !== missingId))
const missingMetric = await request('POST', `/api/dsh-growth/v2/variants/${missingId}/metrics`, { date: localDay(), views: '1' })
check('缺实际发布时间的旧已发状态不能回填', missingMetric, (r) => r.status === 400 && String(r.json?.message ?? '').includes('没有实际发布时间'))

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
