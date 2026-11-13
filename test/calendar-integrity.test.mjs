// 整改回归：日历原子性 / 多平台扇出 / SOP 清单门禁 / CSV 真落库。
//
// 这几条对应审核报告里的真 bug：
//   A1 日历 PUT 先写盘再推版本，推不动还返回 200 → 日历与版本两本账对不上；
//   B2/B3 一格多平台（「抖音 / 知乎」）把主键和平台筛选都搞坏；
//   B1 门禁只认写死的「7/7」，SOP 改了条数门禁就废了；
//   A3 CSV 导入只归档不落库；
//   PM-07 复盘卡按 type 分流缺失。
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cal-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cal-data-'))
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
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 300) }
  return { status: res.statusCode, json }
}

let failures = 0
function check(label, result, predicate) {
  const passed = predicate(result)
  if (!passed) failures += 1
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(44) + ' ' + JSON.stringify(result.json).slice(0, 240))
}

const ok = (result) => result.status === 200 && result.json?.ok !== false
const errText = (result) => String(result.json?.message ?? result.json?.error ?? '')

await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir })
const accountMain = await request('POST', '/api/dsh-growth/accounts/create', {
  title: '主号', name: '主号', platform: '抖音', status: '启用',
})
const accountTest = await request('POST', '/api/dsh-growth/accounts/create', {
  title: '测试号', name: '测试号', platform: '抖音', status: '启用',
})
const accountList = await request('GET', '/api/dsh-growth/accounts/list?limit=20')
const accountMainId = String((accountList.json?.records ?? []).find((item) => item.front?.name === '主号')?.front?.id ?? '')
const accountTestId = String((accountList.json?.records ?? []).find((item) => item.front?.name === '测试号')?.front?.id ?? '')

// ── 1. SOP 清单是门禁的唯一真源 ───────────────────────────────────────
// 先不放清单：高风险版本发布必须被拦，而且要给出可操作的话（不能只说「不行」）。
const noChecklist = await request('GET', '/api/dsh-growth/v2/checklist')
check('清单缺失时 endpoint 明确 missing', noChecklist, (r) => ok(r) && r.json?.missing === true && Number(r.json?.total) === 0)

const gateMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '门禁主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const gateId = gateMaster.json?.master?.id ?? ''
const gateVariant = (await request('POST', `/api/dsh-growth/v2/masters/${gateId}/variants`, {
  platform: '抖音', account: '', riskLevel: '高',
})).json?.variant?.id ?? ''
await request('POST', `/api/dsh-growth/v2/variants/${gateVariant}/transition`, { to: '待发' })
const noList = await request('POST', `/api/dsh-growth/v2/variants/${gateVariant}/transition`, { to: '已发' })
check('清单缺失时高风险发不出去', noList, (r) => r.status === 400 && errText(r).includes('没找到这份清单'))

// 放一份真的 SOP 清单进去（3 条，故意跟「7 项」不一样 —— 门禁必须跟着它走）。
const sopDir = path.join(vault, 'SOP', '运营SOP')
fs.mkdirSync(sopDir, { recursive: true })
fs.writeFileSync(path.join(sopDir, '发布前检查清单.md'), [
  '# 发布前检查清单',
  '',
  '- 标题不超过平台字数上限，且含一个具体数字',
  '- 前 3 秒出现结论，不寒暄',
  '- 封面文字 ≤ 8 个字，手机上看清',
  '',
  '> 发布后 3~7 天数据稳定，再回「待回流」填播放和点赞。',
  '',
].join('\n'), 'utf8')

const withChecklist = await request('GET', '/api/dsh-growth/v2/checklist')
check('清单条目来自 SOP 文件', withChecklist, (r) => ok(r) && r.json?.missing === false
  && Number(r.json?.total) === 3 && Array.isArray(r.json?.items)
  && r.json.items.every((item) => typeof item.id === 'string' && item.id !== '' && typeof item.text === 'string'))

const stillBlocked = await request('POST', `/api/dsh-growth/v2/variants/${gateVariant}/transition`, { to: '已发' })
check('清单没勾完时门禁拦住（按真实条数）', stillBlocked, (r) => r.status === 400
  && errText(r).includes('3 项勾完') && errText(r).includes('0/3'))

// 勾满（用条目 id，不是序号）才放行。
const itemIds = (withChecklist.json?.items ?? []).map((item) => item.id)
const checked = await request('PUT', `/api/dsh-growth/v2/variants/${gateVariant}`, {
  front: { publishCheckItems: itemIds.join(',') },
})
check('自检进度由服务端按清单重算', checked, (r) => ok(r) && String(r.json?.variant?.front?.publishCheck ?? '') === '3/3'
  && String(r.json?.variant?.front?.publishCheckItems ?? '') === itemIds.join(','))
const allowed = await request('POST', `/api/dsh-growth/v2/variants/${gateVariant}/transition`, {
  to: '已发', at: '2020-11-01T10:00:00+08:00', reviewDays: 7,
})
check('勾满后可以发布', allowed, (r) => ok(r) && r.json?.variant?.status === '已发')

// 伪造「7/7」不能骗过门禁：服务端只认勾了哪几项。
const fakeMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '伪造自检', platform: '抖音', date: '2026-11-07', status: '选题',
})
const fakeId = fakeMaster.json?.master?.id ?? ''
const fakeVariant = (await request('POST', `/api/dsh-growth/v2/masters/${fakeId}/variants`, {
  platform: '抖音', account: '', riskLevel: '高',
})).json?.variant?.id ?? ''
await request('POST', `/api/dsh-growth/v2/variants/${fakeVariant}/transition`, { to: '待发' })
await request('PUT', `/api/dsh-growth/v2/variants/${fakeVariant}`, { front: { publishCheck: '7/7' } })
const fakeBlocked = await request('POST', `/api/dsh-growth/v2/variants/${fakeVariant}/transition`, { to: '已发' })
check('写死 7/7 骗不过门禁', fakeBlocked, (r) => r.status === 400 && errText(r).includes('3 项勾完'))

// ── 2. 日历 PUT 是原子的 ───────────────────────────────────────────────
// 同选题同平台挂两个版本 → 日历标已发必须整条拒绝，日历一个字节都不写。
const multiMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '原子性多版本', platform: '抖音', date: '2026-11-07', status: '选题',
})
const multiId = multiMaster.json?.master?.id ?? ''
const multiPath = multiMaster.json?.master?.path ?? ''
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', accountId: accountMainId })
await request('POST', `/api/dsh-growth/v2/masters/${multiId}/variants`, { platform: '抖音', accountId: accountTestId })
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-21', platform: '抖音', topic: '原子性多版本',
  status: '待发', topicPath: multiPath, topicId: multiId,
})
const calBefore = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const rowBefore = (calBefore.json?.entries ?? []).find((entry) => entry.topic === '原子性多版本') ?? {}
const ambiguous = await request('PUT', '/api/dsh-growth/calendar', {
  ...rowBefore, status: '已发', month: '2026-11', expectedSha1: calBefore.json?.sha1,
})
check('多版本歧义时整条拒绝', ambiguous, (r) => r.status === 409 && errText(r).includes('版本'))
const calAfter = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const rowAfter = (calAfter.json?.entries ?? []).find((entry) => entry.topic === '原子性多版本') ?? {}
check('拒绝后日历一个字节都没写', calAfter, () => String(rowAfter.status ?? '') === '待发')
const variantsAfter = await request('GET', `/api/dsh-growth/v2/masters/${multiId}`)
check('拒绝后版本一个都没被推', variantsAfter, (r) => (r.json?.variants ?? []).every((item) => item.status === '在写'))

// ── 3. 一格多平台：写侧守卫 ────────────────────────────────────────────
const multiCell = await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-25', platform: '抖音 / 知乎', topic: '一格多平台', status: '待发',
})
check('拒绝新写一格多平台', multiCell, (r) => r.status === 400 && errText(r).includes('一行只能放一个平台'))

// ── 4. 多平台扇出：一次动作，N 版 N 行 ────────────────────────────────
const fanMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '扇出主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const fanId = fanMaster.json?.master?.id ?? ''
const fanPath = fanMaster.json?.master?.path ?? ''
const fanout = await request('POST', '/api/dsh-growth/calendar/fanout', {
  month: '2026-11', date: '2026-11-26', topic: '扇出主选题', topicPath: 'Topics/错误路径.md', topicId: fanId,
  platforms: ['抖音', '知乎'], status: '待发', link: 'https://example.com/fanout', gmv: '6666.6', conv: '4.5',
})
check('扇出：两个平台各建一版各排一行', fanout, (r) => ok(r)
  && (r.json?.results ?? []).length === 2
  && (r.json?.results ?? []).every((item) => item.variantCreated === true && item.rowCreated === true)
  && (r.json?.failed ?? []).length === 0)
const fanCal = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const fanRows = (fanCal.json?.entries ?? []).filter((entry) => entry.topic === '扇出主选题')
check('扇出：日历落了两行，一个平台一行', fanCal, () => fanRows.length === 2
  && new Set(fanRows.map((row) => row.platform)).size === 2
  && fanRows.every((row) => String(row.variantId ?? '') !== '')
  && fanRows.every((row) => String(row.topicPath ?? '') === fanPath)
  && fanRows.every((row) => String(row.link ?? '') === 'https://example.com/fanout'
    && String(row.gmv ?? '') === '6666.6' && String(row.conv ?? '') === '4.5'))
const fanVariants = await request('GET', `/api/dsh-growth/v2/masters/${fanId}`)
check('扇出：主选题下建了两个平台版本', fanVariants, (r) => (r.json?.variants ?? []).length === 2
  && new Set((r.json?.variants ?? []).map((v) => String(v.front?.platform ?? ''))).size === 2)

// 再扇一次同样的内容：版本要复用，不能又建一份（同一平台两个版本，台账会分成两笔）。
const fanout2 = await request('POST', '/api/dsh-growth/calendar/fanout', {
  month: '2026-11', date: '2026-11-26', topic: '扇出主选题', topicPath: fanPath, topicId: fanId,
  platforms: ['抖音', '知乎'], status: '待发',
})
check('扇出：同一平台不重复建版本', fanout2, (r) => ok(r)
  && (r.json?.results ?? []).every((item) => item.variantCreated === false))
const fanVariants2 = await request('GET', `/api/dsh-growth/v2/masters/${fanId}`)
check('扇出：重跑后版本数不变', fanVariants2, (r) => (r.json?.variants ?? []).length === 2)

// ── 5. 单一事实源：版本推进会投影回日历 ──────────────────────────────
const syncMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '投影主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const syncId = syncMaster.json?.master?.id ?? ''
const syncPath = syncMaster.json?.master?.path ?? ''
const syncVariant = (await request('POST', `/api/dsh-growth/v2/masters/${syncId}/variants`, {
  platform: '抖音', account: '',
})).json?.variant?.id ?? ''
await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-27', platform: '抖音', topic: '投影主选题',
  status: '待发', topicPath: syncPath, topicId: syncId, variantId: syncVariant,
})
await request('POST', `/api/dsh-growth/v2/variants/${syncVariant}/transition`, { to: '待发' })
const moved = await request('POST', `/api/dsh-growth/v2/variants/${syncVariant}/transition`, {
  to: '已发', at: '2020-11-01T10:00:00+08:00', reviewDays: 7,
})
check('版本推进返回日历同步结果', moved, (r) => ok(r) && r.json?.calendarSynced !== undefined)
const syncCal = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const syncRow = (syncCal.json?.entries ?? []).find((entry) => entry.topic === '投影主选题') ?? {}
check('版本已发 → 日历行跟着变成已发', syncCal, () => String(syncRow.status ?? '') === '已发')

// 发布前取消：只删除今天及未来、仍在写/待发的排期。恢复版本只回到在写，不恢复旧排期。
const cancelMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '取消排期主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const cancelId = cancelMaster.json?.master?.id ?? ''
const cancelPath = cancelMaster.json?.master?.path ?? ''
const cancelVariant = (await request('POST', `/api/dsh-growth/v2/masters/${cancelId}/variants`, {
  platform: '抖音', account: '',
})).json?.variant?.id ?? ''
await request('POST', '/api/dsh-growth/calendar', {
  month: '2099-12', date: '2099-12-20', platform: '抖音', topic: '取消排期主选题',
  status: '待发', topicPath: cancelPath, topicId: cancelId, variantId: cancelVariant,
})
const cancelled = await request('POST', `/api/dsh-growth/v2/variants/${cancelVariant}/transition`, { to: '已取消' })
check('取消版本会成功', cancelled, (r) => ok(r) && r.json?.variant?.status === '已取消')
const cancelledCalendar = await request('GET', '/api/dsh-growth/calendar?month=2099-12')
check('取消版本删除未来排期', cancelledCalendar, (r) => !(r.json?.entries ?? []).some((row) => row.variantId === cancelVariant))
const restoredCancel = await request('POST', `/api/dsh-growth/v2/variants/${cancelVariant}/transition`, { to: '在写' })
check('恢复取消版本回到在写', restoredCancel, (r) => ok(r) && r.json?.variant?.status === '在写')
const restoredCalendar = await request('GET', '/api/dsh-growth/calendar?month=2099-12')
check('恢复取消版本不恢复旧排期', restoredCalendar, (r) => !(r.json?.entries ?? []).some((row) => row.variantId === cancelVariant))

// ── 6. CSV 导入真落库 ────────────────────────────────────────────────
const csv = '周期,平台,GMV,流量,转化率,ROI,环比,数据来源,统计口径\n2026-W45,抖音,12000,500,3.2,1.5,12,后台导出,自然日\n'
const imported = await request('POST', '/api/dsh-growth/data/import', { csv, name: 'regression' })
check('CSV 导入落库并回报写入结果', imported, (r) => ok(r)
  && (r.json?.written ?? []).length === 1
  && String(r.json?.written?.[0]?.title ?? '').includes('2026-W45')
  && (r.json?.failed ?? []).length === 0)
const dataList = await request('GET', '/api/dsh-growth/data/list')
check('导入的行能读回来（含来源与口径）', dataList, (r) => (r.json?.items ?? r.json?.records ?? []).some((row) => {
  const front = row?.front ?? row ?? {}
  return String(front.period ?? '') === '2026-W45' && String(front.source ?? '') !== ''
}))

// ── 7. 复盘卡按 type 分流 ────────────────────────────────────────────
const boards = await request('GET', '/api/dsh-growth/boards')
check('复盘卡只收拆解（type 不含「选题」）', boards, (r) => ok(r)
  && (r.json?.content ?? []).every((item) => String(item.type ?? '') !== '选题')
  && (r.json?.unmeasured ?? []).every((item) => String(item.type ?? '') !== '选题'))

// ── 8. GMV / 转化率是结构化列，商品汇总不再从备注猜 ─────────────────
const metricMaster = await request('POST', '/api/dsh-growth/v2/masters', {
  title: '结构化指标主选题', platform: '抖音', date: '2026-11-07', status: '选题',
})
const metricId = metricMaster.json?.master?.id ?? ''
const metricPath = metricMaster.json?.master?.path ?? ''
const metricVariant = (await request('POST', `/api/dsh-growth/v2/masters/${metricId}/variants`, {
  platform: '抖音', account: '', riskLevel: '低',
})).json?.variant?.id ?? ''
const metricCreated = await request('POST', '/api/dsh-growth/calendar', {
  month: '2026-11', date: '2026-11-28', platform: '抖音', topic: '结构化指标主选题',
  status: '待发', topicPath: metricPath, topicId: metricId, variantId: metricVariant,
  productPath: 'Products/结构化商品.md', gmv: '8888.8', conv: '3.2',
})
check('日历能写入结构化 GMV / 转化率', metricCreated, (r) => ok(r)
  && String(r.json?.entry?.gmv ?? '') === '8888.8' && String(r.json?.entry?.conv ?? '') === '3.2')
const metricRead = await request('GET', '/api/dsh-growth/calendar?month=2026-11')
const metricRow = (metricRead.json?.entries ?? []).find((entry) => entry.topic === '结构化指标主选题') ?? {}
check('结构化 GMV / 转化率能原样读回', metricRead, () => String(metricRow.gmv ?? '') === '8888.8'
  && String(metricRow.conv ?? '') === '3.2')
const metricPublished = await request('PUT', '/api/dsh-growth/calendar', {
  ...metricRow, status: '已发', month: '2026-11', expectedSha1: metricRead.json?.sha1,
  publishedAt: '2020-11-01T10:00:00+08:00', reviewDays: 7,
})
check('结构化指标排期确认发布', metricPublished, (r) => ok(r))
const rollup = await request('GET', '/api/dsh-growth/product-rollup')
const rolledProduct = (rollup.json?.products ?? []).find((item) => String(item.productPath) === 'Products/结构化商品.md') ?? {}
check('商品聚合直接采用结构化值，不依赖备注正则', rollup, () => Number(rolledProduct.gmv) === 8888.8
  && Number(rolledProduct.conv) === 3.2 && Number(rolledProduct.convSamples) === 1
  && Number((rolledProduct.items ?? [])[0]?.conv) === 3.2)

// ── 9. 5–11 列老日历表都能读，11 列写回时补新列不挪旧列 ─────────────
const calendarDir = path.join(vault, 'Calendar')
fs.mkdirSync(calendarDir, { recursive: true })
const legacyTables = [
  { width: 5, header: ['日期', '平台', '主题', '状态', '链接'] },
  { width: 6, header: ['日期', '平台', '主题', '状态', '备注', '链接'] },
  { width: 7, header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记'] },
  { width: 8, header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案'] },
  { width: 9, header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案', '选题ID'] },
  { width: 10, header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案', '选题ID', '版本ID'] },
  { width: 11, header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案', '选题ID', '版本ID', '账号'] },
]
for (const old of legacyTables) {
  const month = '2024-' + String(old.width).padStart(2, '0')
  const cells = {
    日期: '2024-' + String(old.width).padStart(2, '0') + '-01',
    平台: '抖音',
    主题: 'legacy-' + old.width,
    状态: '待发',
    备注: old.width >= 6 ? '备注' + old.width : '',
    链接: 'https://example.com/' + old.width,
    选题笔记: old.width >= 7 ? 'Topics/legacy-' + old.width + '.md' : '',
    商品档案: old.width >= 8 ? 'Products/legacy-' + old.width + '.md' : '',
    选题ID: old.width >= 9 ? 'tid-' + old.width : '',
    版本ID: old.width >= 10 ? 'vid-' + old.width : '',
    账号: old.width >= 11 ? '账号' + old.width : '',
  }
  const text = [
    '# 内容日历 ' + month,
    '',
    '| ' + old.header.join(' | ') + ' |',
    '| ' + old.header.map(() => '---').join(' | ') + ' |',
    '| ' + old.header.map((name) => cells[name] ?? '').join(' | ') + ' |',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(calendarDir, month + '.md'), text, 'utf8')
}
let legacyFailures = 0
for (const old of legacyTables) {
  const month = '2024-' + String(old.width).padStart(2, '0')
  const read = await request('GET', '/api/dsh-growth/calendar?month=' + month)
  const row = (read.json?.entries ?? []).find((entry) => entry.topic === 'legacy-' + old.width) ?? {}
  const good = read.status === 200 && read.json?.code === undefined
    && String(row.date ?? '') === '2024-' + String(old.width).padStart(2, '0') + '-01'
    && String(row.link ?? '') === 'https://example.com/' + old.width
    && String(row.note ?? '') === (old.width >= 6 ? '备注' + old.width : '')
    && String(row.topicPath ?? '') === (old.width >= 7 ? 'Topics/legacy-' + old.width + '.md' : '')
    && String(row.productPath ?? '') === (old.width >= 8 ? 'Products/legacy-' + old.width + '.md' : '')
    && String(row.topicId ?? '') === (old.width >= 9 ? 'tid-' + old.width : '')
    && String(row.variantId ?? '') === (old.width >= 10 ? 'vid-' + old.width : '')
    && String(row.account ?? '') === (old.width >= 11 ? '账号' + old.width : '')
    && String(row.gmv ?? '') === '' && String(row.conv ?? '') === ''
  if (!good) legacyFailures += 1
  console.log((good ? 'PASS ' : 'FAIL ') + ('旧 ' + old.width + ' 列表可读且列不串位').padEnd(44) + ' ' + JSON.stringify(row).slice(0, 240))
}
check('5–11 列老日历表全部兼容', { status: legacyFailures === 0 ? 200 : 500, json: { failures: legacyFailures } }, (r) => r.status === 200)

const oldEleven = await request('GET', '/api/dsh-growth/calendar?month=2024-11')
const oldElevenRow = (oldEleven.json?.entries ?? [])[0] ?? {}
const writtenEleven = await request('PUT', '/api/dsh-growth/calendar', {
  ...oldElevenRow, note: '写回后仍保留原列', month: '2024-11', expectedSha1: oldEleven.json?.sha1,
})
const rawEleven = fs.readFileSync(path.join(calendarDir, '2024-11.md'), 'utf8')
check('11 列老表写回后补 GMV / 转化率两列', writtenEleven, () => rawEleven.includes('| 账号 | GMV | 转化率 |')
  && rawEleven.includes('https://example.com/11') && rawEleven.includes('账号11'))

// 没有 SOP/ 目录时，SOP 树本来就是整个 vault。放在 vault 根下的清单也必须能找到；
// 以前这里只扫 Workbench/，于是根目录清单永远 missing，高风险内容反而发不出去。
const rootSopVault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cal-root-sop-'))
fs.writeFileSync(path.join(rootSopVault, '发布前检查清单.md'), '# 发布前检查清单\n\n- 根目录清单也要能被发现\n', 'utf8')
await request('PUT', '/api/dsh-growth/config', { vaultRoot: rootSopVault, pluginDataDir: dataDir })
const rootChecklist = await request('GET', '/api/dsh-growth/v2/checklist')
check('根目录 SOP 清单能被发现', rootChecklist, (r) => ok(r) && r.json?.missing === false
  && Number(r.json?.total) === 1 && String(r.json?.path ?? '').endsWith('发布前检查清单.md'))

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
