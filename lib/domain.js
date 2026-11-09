/**
 * 领域层：主选题（Topics 笔记）× 平台版本（Workbench/平台版本 下的笔记）× 指标快照（Data/回流台账）。
 *
 * 这一层只做「结构 + 规则」，不碰 HTTP、不碰 UI。index.js 负责鉴权/路由，
 * client.js 负责展示，这样以后新增平台、账号、栏目都只改这一处。
 */
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { createTable } from './table.js'
import * as fm from './frontmatter.js'
import { normalizePlatform } from './platforms.js'
import { VaultError } from './vault.js'

export const VARIANT_STATUSES = ['在写', '待发', '已发', '待回填', '已归档']

// 2026-11-09 状态词表收敛：只保留内容写作者真正要认的五个状态。
// 老笔记里的七态在读取时统一映射到新词表，磁盘上的历史写法不丢，但界面
// 和状态机只认这五种。
const LEGACY_VARIANT_STATUS = {
  选题: '在写',
  创作中: '在写',
  待审: '待发',
  已排期: '待发',
  已发: '已发',
  数据回流: '待回填',
  已归档: '已归档',
}
export function normalizeVariantStatus(value) {
  const text = String(value ?? '').trim()
  return LEGACY_VARIANT_STATUS[text] ?? text
}

// 允许的下一步。任何不在表里的跳转（比如 在写 → 已发）都会被拒绝；
// 归档是终态，只能从「待回填」进，避免误点把在做的内容藏起来。
export const VARIANT_TRANSITIONS = {
  在写: ['待发', '已归档'],
  待发: ['已发', '在写', '已归档'],
  已发: ['待回填', '已归档'],
  待回填: ['已归档'],
  已归档: [],
}

export const VARIANT_SCHEMA = [
  { key: 'id', label: 'ID', max: 40 },
  { key: 'masterId', label: '主选题ID', required: true, max: 40 },
  { key: 'platform', label: '平台', required: true, max: 100 },
  { key: 'account', label: '账号', max: 100 },
  { key: 'accountId', label: '账号ID', max: 40 },
  // 版本卡里真正决定「这一版长什么样」的五项：标题备选、封面文案、素材清单、
  // 目标人群、发布目的。它们只属于这一版，不写回主选题（同一选题抖音和视频号的
  // 标题、封面本来就不该一样）。
  { key: 'titleOptions', label: '标题备选', max: 500 },
  { key: 'coverCopy', label: '封面文案', max: 500 },
  { key: 'materials', label: '素材清单', max: 500 },
  { key: 'audience', label: '目标人群', max: 300 },
  { key: 'purpose', label: '发布目的', max: 300 },
  { key: 'status', label: '状态', max: 20 },
  { key: 'riskLevel', label: '风险等级', max: 20 },
  { key: 'publishCheck', label: '发布自检', max: 40 },
  { key: 'publishCheckItems', label: '自检明细', max: 80 },
]

// 备注列已删（2026-11-08）：台账只放数字，一行一个版本一天，写一句备注没人回头读。
// 老文件多出来的第 11 列由 table.parse 的 slice 直接丢掉，下次写这一页时表格自动收成 10 列。
const METRIC_HEADER = ['日期', '主选题ID', '平台版本ID', '平台', '账号', '播放/阅读', '赞/收藏', '评论', '转发', '链接', '完播率', '平均播放时长', '粉丝净增', '订单', 'GMV', '退货原因', '数据来源', '统计口径']
const METRIC_KEYS = ['date', 'masterId', 'variantId', 'platform', 'account', 'views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber']

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

function safeName(value, fallback = '未命名') {
  const text = clean(value, 80).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim()
  return text === '' ? fallback : text
}

function newId(prefix) {
  return prefix + randomBytes(6).toString('hex')
}

/**
 * 本机时区的「今天」，YYYY-MM-DD。
 * 不能用 toISOString().slice(0, 10)：那是 UTC，东八区 20:00 之后会算成「昨天」，
 * 台账日期就跟日历排期差一天，回流也记到上个月去。
 */
function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function fallbackId(prefix, path) {
  return prefix + createHash('sha1').update(String(path ?? '')).update('\0').digest('hex').slice(0, 11)
}

export function createDomainStore({ vault, workbenchDir, topics, dataDir }) {
  const variantsRoot = () => join(workbenchDir, '平台版本').replace(/\\/g, '/')

  function metricTable(month = '') {
    return createTable({
      header: METRIC_HEADER,
      keys: METRIC_KEYS,
      idKeys: ['variantId', 'date'],
      heading: '# 回流台账' + (month === '' ? '' : ' ' + month),
      intro: '> 按平台版本记录每次数据回流；一行一个版本一天，同一天重填会覆盖。',
      label: '指标',
    })
  }

  function variantIdOf(front, path) {
    const stored = clean(front?.id, 40)
    return stored !== '' ? stored : fallbackId('v', path)
  }

  async function listVariantPaths() {
    const root = variantsRoot()
    const discovered = await vault.discover()
    return discovered.notes
      .map((note) => note.path)
      .filter((item) => item.startsWith(root + '/') && item.toLowerCase().endsWith('.md'))
  }

  async function readVariant(path) {
    const note = await vault.readNote(path)
    const parsed = fm.splitNote(note.text)
    return {
      ...note,
      front: { ...parsed.front, status: normalizeVariantStatus(parsed.front?.status) || '在写' },
      body: parsed.body,
      id: variantIdOf(parsed.front, path),
      status: normalizeVariantStatus(parsed.front?.status) || '在写',
      riskLevel: clean(parsed.front?.riskLevel, 20) || '低',
    }
  }

  async function findMaster(masterId) {
    const id = clean(masterId, 40)
    if (id === '') throw new VaultError('缺少主选题 ID', 'bad_request')
    const records = await topics.list({ limit: 1000 })
    const master = records.find((record) => String(record.id ?? record.front?.id ?? '') === id)
    if (master === undefined) throw new VaultError('主选题不存在：' + id, 'not_found')
    return master
  }

  async function createVariant(input) {
    const master = await findMaster(input?.masterId)
    // 平台名先归一再落盘：不归一的话「抖音」和「douyin」会在同一个主选题下
    // 各建一个版本文件，回流记到两条上、榜单也并不到一起。
    const platform = normalizePlatform(clean(input?.platform, 100))
    if (platform === '') throw new VaultError('平台版本必须填平台', 'bad_request')
    const account = clean(input?.account, 100)
    const status = normalizeVariantStatus(clean(input?.status, 20)) || '在写'
    if (!VARIANT_STATUSES.includes(status)) throw new VaultError('未知平台版本状态：' + status, 'bad_request')
    const front = {
      id: newId('v'),
      masterId: master.id,
      platform,
      account,
      accountId: clean(input?.accountId, 40),
      titleOptions: clean(input?.titleOptions, 500),
      coverCopy: clean(input?.coverCopy, 500),
      materials: clean(input?.materials, 500),
      audience: clean(input?.audience, 300),
      purpose: clean(input?.purpose, 300),
      status,
      riskLevel: clean(input?.riskLevel, 20) || '低',
      publishCheck: clean(input?.publishCheck, 40),
      publishCheckItems: clean(input?.publishCheckItems, 80),
    }
    const title = safeName(platform + (account === '' ? '' : '-' + account), platform)
    const rel = join(variantsRoot(), safeName(master.id, 'master'), title + '.md').replace(/\\/g, '/')
    // 通用模板常驻：新建时带了草稿脚本就插在提示行下面，钩子/分段/自检骨架原样保留。
    // （以前客户端建完再 put 一次整篇替换正文，手打的脚本会把模板整个冲掉。）
    const script = String(input?.script ?? '').replace(/\r\n/g, '\n').trim()
    const bodyLines = [
      '## 版本脚本',
      '> 一条拆解笔记下的一个平台版本。脚本、封面、发布时间都写在这里，不要写回拆解笔记。',
      '',
    ]
    if (script !== '') bodyLines.push(script, '')
    bodyLines.push(
      '### 开场钩子（前 3 秒）',
      '- 口播：',
      '- 画面：',
      '',
      '### 正文分段（每段：说什么 · 拍什么 · 约几秒）',
      '- 段 1：',
      '- 段 2：',
      '- 段 3：',
      '',
      '### 风险与证据',
      '- 风险等级：' + front.riskLevel,
      '- 证据链接：',
      '- 待补材料：',
      '',
      '### 发布前自检（7 项，全勾才能标已发）',
      '- [ ] 事实/数字有来源',
      '- [ ] 价格/规格与商品档案一致',
      '- [ ] 无绝对化用语',
      '- [ ] 无未授权竞品对比',
      '- [ ] 封面/标题不误导',
      '- [ ] 账号与平台选对',
      '- [ ] 发布时间确认',
    )
    await vault.createNote(rel, fm.renderFromTemplate(VARIANT_SCHEMA, front, bodyLines.join('\n')))
    vault.invalidate()
    return readVariant(rel)
  }

  async function listMetrics(masterId = '') {
    const wanted = clean(masterId, 40)
    const root = dataDir === undefined || dataDir === null || String(dataDir).trim() === ''
      ? ''
      : join(String(dataDir), '回流台账')
    if (root === '') return []
    let files = []
    try {
      files = (await readdir(root)).filter((name) => /^\d{4}-\d{2}\.md$/.test(name))
    } catch {
      return []
    }
    const table = metricTable()
    const out = []
    for (const name of files) {
      const state = await table.read(join(root, name))
      for (const entry of state.entries ?? []) {
        if (wanted === '' || String(entry.masterId ?? '') === wanted) out.push({ ...entry, file: join(root, name).replace(/\\/g, '/') })
      }
    }
    out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    return out
  }

  async function listVariants(masterId) {
    const id = clean(masterId, 40)
    const out = []
    for (const path of await listVariantPaths()) {
      const variant = await readVariant(path)
      if (id === '' || String(variant.front?.masterId ?? '') === id) out.push(variant)
    }
    const latest = new Map()
    for (const metric of await listMetrics(id)) {
      if (!latest.has(metric.variantId)) latest.set(metric.variantId, metric)
    }
    for (const variant of out) variant.latestMetric = latest.get(variant.id) ?? null
    out.sort((a, b) => String(a.path).localeCompare(String(b.path)))
    return out
  }

  async function getVariant(id) {
    const wanted = clean(id, 40)
    if (wanted === '') throw new VaultError('缺少平台版本 ID', 'bad_request')
    for (const path of await listVariantPaths()) {
      const variant = await readVariant(path)
      if (variant.id === wanted) return variant
    }
    throw new VaultError('平台版本不存在：' + wanted, 'not_found')
  }

  async function updateVariant(path, { front: frontInput, body, expectedSha1 } = {}) {
    const before = await readVariant(path)
    const requestedStatus = clean(frontInput?.status, 20)
    if (requestedStatus !== '' && requestedStatus !== before.status) {
      throw new VaultError('状态只能通过「推进」按状态机修改', 'bad_request')
    }
    const merged = fm.normalizeFront(VARIANT_SCHEMA, { ...before.front, ...(frontInput ?? {}), status: before.status })
    if (clean(merged.id, 40) === '') merged.id = before.id
    const nextBody = body === undefined ? before.body : String(body)
    return vault.writeNote(path, fm.buildNote(merged, nextBody, before.text), { expectedSha1 })
  }

  function assertTransition(from, to, riskLevel, publishCheck) {
    const current = normalizeVariantStatus(clean(from, 20)) || '在写'
    const next = normalizeVariantStatus(clean(to, 20))
    if (!VARIANT_STATUSES.includes(next)) throw new VaultError('未知平台版本状态：' + next, 'bad_request')
    const allowed = VARIANT_TRANSITIONS[current] ?? []
    if (!allowed.includes(next)) throw new VaultError('不允许从「' + current + '」直接到「' + next + '」', 'bad_request')
    if (next === '已发') {
      if (clean(riskLevel, 20) === '禁发') throw new VaultError('风险等级为「禁发」，不能发布', 'bad_request')
      if (clean(riskLevel, 20) === '高' && clean(publishCheck, 40) !== '7/7') {
        throw new VaultError('高风险内容发布前必须完成 7 项自检', 'bad_request')
      }
    }
  }

  async function transitionVariant(path, to, options = {}) {
    const before = await readVariant(path)
    assertTransition(before.status, to, before.riskLevel, before.front?.publishCheck)
    const front = { ...before.front, status: clean(to, 20) }
    if (options.actor !== undefined && clean(options.actor, 80) !== '') front.lastActor = clean(options.actor, 80)
    if (clean(to, 20) === '已发') front.publishedAt = clean(options.at, 40) || new Date().toISOString()
    // 归档要记住它从哪儿来：恢复时回原位，而不是一律掉回「选题」。
    if (clean(to, 20) === '已归档') front.archivedFrom = clean(before.status, 20)
    const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  // 恢复：归档是「收起来」，不是「删掉」，所以必须有一条回来的路。
  // 回到归档前的状态；老笔记没记 archivedFrom 时，发过的回「已发」，没发过的回「选题」。
  // 这一步刻意不走 assertTransition：它不是「推进」，是撤销一次归档。
  async function restoreVariant(path) {
    const before = await readVariant(path)
    if (before.status !== '已归档') throw new VaultError('这条平台版本没有归档，不需要恢复', 'bad_request')
    const remembered = normalizeVariantStatus(before.front?.archivedFrom)
    const fallback = clean(before.front?.publishedAt, 40) === '' ? '在写' : '已发'
    const target = VARIANT_STATUSES.includes(remembered) && remembered !== '已归档' ? remembered : fallback
    const front = { ...before.front, status: target }
    delete front.archivedFrom
    const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  async function appendMetric(input) {
    const date = clean(input?.date, 40) || localDay()
    const month = (input?.month !== undefined && clean(input.month, 7) !== '') ? clean(input.month, 7) : date.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) throw new VaultError('月份格式应为 YYYY-MM', 'bad_request')
    const variantId = clean(input?.variantId, 40)
    if (variantId === '') throw new VaultError('缺少平台版本 ID', 'bad_request')
    const table = metricTable(month)
    const file = join(input?.dataDir ?? '', '回流台账', month + '.md')
    const state = await table.read(file)
    const row = {
      date,
      masterId: clean(input?.masterId, 40),
      variantId,
      platform: clean(input?.platform, 100),
      account: clean(input?.account, 100),
      views: clean(input?.views, 40),
      likes: clean(input?.likes, 40),
      comments: clean(input?.comments, 40),
      shares: clean(input?.shares, 40),
      link: clean(input?.link, 300),
      // 内容复盘真正要看的几个数：完播、时长、涨粉、订单、GMV、退货原因，
      // 再记一条数据从哪来、按什么口径算的，否则「32%→58%」这种结论没法复核。
      completion: clean(input?.completion, 40),
      avgDuration: clean(input?.avgDuration, 40),
      followers: clean(input?.followers, 40),
      orders: clean(input?.orders, 40),
      gmv: clean(input?.gmv, 40),
      returnReason: clean(input?.returnReason, 300),
      source: clean(input?.source, 100),
      caliber: clean(input?.caliber, 200),
    }
    const existing = (state.entries ?? []).find((entry) => entry.variantId === variantId && entry.date === date)
    const result = existing === undefined
      ? await table.add(file, row)
      : await table.update(file, existing.id, row, { expectedSha1: state.sha1 })
    if (result.ok !== true) throw new VaultError(result.error, result.code ?? 'write_failed')
    return { entry: result.entry, file: file.replace(/\\/g, '/') }
  }

  async function variantSummary(masterId) {
    const list = await listVariants(masterId)
    const byStatus = {}
    for (const status of VARIANT_STATUSES) byStatus[status] = 0
    for (const variant of list) byStatus[variant.status] = (byStatus[variant.status] ?? 0) + 1
    return { total: list.length, byStatus }
  }

  return {
    createVariant,
    listVariants,
    getVariant,
    readVariant,
    updateVariant,
    transitionVariant,
    restoreVariant,
    appendMetric,
    variantSummary,
    assertTransition,
    listMetrics,
    metricTable,
  }
}
