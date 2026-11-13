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
import { normalizePlatform, splitPlatforms } from './platforms.js'
import { checklistState, checklistPatch } from './checklist.js'
import { VaultError } from './vault.js'

export const VARIANT_STATUSES = ['在写', '待发', '已发', '待回填', '已结案', '已取消']

// 状态词表收敛为六个生命周期状态。老笔记里的旧写法在读取时统一映射；
// 「已归档」只作为旧数据兼容，读取后拆成原生命周期状态 + 收纳标记。
const LEGACY_VARIANT_STATUS = {
  选题: '在写',
  创作中: '在写',
  待审: '待发',
  已排期: '待发',
  已发: '已发',
  数据回流: '待回填',
  已结案: '已结案',
  已取消: '已取消',
  已归档: '已归档',
}
export function normalizeVariantStatus(value) {
  const text = String(value ?? '').trim()
  return LEGACY_VARIANT_STATUS[text] ?? text
}

// 允许的下一步。任何不在表里的跳转（比如 在写 → 已发）都会被拒绝。
// 收纳不属于生命周期，由 archiveVariant / restoreVariant 单独处理。
export const VARIANT_TRANSITIONS = {
  在写: ['待发', '已取消'],
  待发: ['已发', '在写', '已取消'],
  已发: ['待回填'],
  待回填: ['已结案'],
  已结案: [],
  已取消: ['在写'],
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
  // 自检明细存的是清单项 id（每项 8 位哈希，逗号分隔）。
  // 清单条数会变，条数上限不能写死在 80 —— 写到第 11 项就会超长报错。
  { key: 'publishCheckItems', label: '自检明细', max: 400 },
  { key: 'publishedAt', label: '实际发布时间', max: 40 },
  { key: 'publishedLink', label: '发布链接', max: 300 },
  { key: 'archivedAt', label: '收纳时间', max: 40 },
  { key: 'cancelledAt', label: '取消时间', max: 40 },
  { key: 'reviewCycle', label: '观察轮次', max: 10 },
  { key: 'reviewStatus', label: '观察状态', max: 20 },
  { key: 'reviewDays', label: '观察天数', max: 10 },
  { key: 'reviewStartedAt', label: '观察开始', max: 40 },
  { key: 'reviewDueAt', label: '观察截止', max: 40 },
  { key: 'reviewBaselineAt', label: '观察基线', max: 40 },
  { key: 'reviewClosedAt', label: '结案时间', max: 40 },
  { key: 'reviewClosedThrough', label: '结案覆盖日期', max: 20 },
  { key: 'reviewClosedMetricId', label: '结案快照ID', max: 40 },
]

// 备注列已删（2026-11-08）：台账只放数字，一行一个版本一天，写一句备注没人回头读。
// 老文件多出来的第 11 列由 table.parse 的 slice 直接丢掉，下次写这一页时表格自动收成 10 列。
const METRIC_HEADER = ['日期', '主选题ID', '平台版本ID', '平台', '账号', '播放/阅读', '赞/收藏', '评论', '转发', '链接', '完播率', '平均播放时长', '粉丝净增', '订单', 'GMV', '退货原因', '数据来源', '统计口径', '快照ID', '首次录入时间', '最后更新时间', '修订序号']
const METRIC_KEYS = ['date', 'masterId', 'variantId', 'platform', 'account', 'views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber', 'metricId', 'recordedAt', 'updatedAt', 'revision']
const METRIC_EDITABLE_KEYS = ['views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber']

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

function validIsoInstant(value, { future = true } = {}) {
  const text = clean(value, 40)
  if (text === '') return ''
  const parsed = new Date(text)
  if (!Number.isFinite(parsed.getTime())) throw new VaultError('时间格式不正确', 'bad_field')
  if (!future && parsed.getTime() > Date.now()) throw new VaultError('实际发布时间不能在未来', 'bad_field')
  return parsed.toISOString()
}

function reviewDaysOf(value) {
  const days = Number(String(value ?? '').trim())
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new VaultError('观察天数必须是 1–365 的整数', 'bad_field')
  return days
}

function datePartsInZone(date, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date)
  const take = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return { year: Number(take('year')), month: Number(take('month')), day: Number(take('day')), offset: take('timeZoneName') }
}

export function reviewDueAtFor(publishedAt, days, zone = 'Asia/Shanghai') {
  const local = datePartsInZone(new Date(publishedAt), zone)
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + days - 1, 12, 0, 0))
  const date = datePartsInZone(target, zone)
  const offsetMatch = /GMT([+-])(\d{2}):(\d{2})/.exec(date.offset)
  const offset = offsetMatch === null ? '+00:00' : offsetMatch[1] + offsetMatch[2] + ':' + offsetMatch[3]
  return String(date.year).padStart(4, '0') + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0') + 'T23:59:59' + offset
}

export function createDomainStore({ vault, workbenchDir, topics, dataDir, checklistProvider = null, accountProvider = null, timezone = 'Asia/Shanghai' }) {
  const variantsRoot = () => join(workbenchDir, '平台版本').replace(/\\/g, '/')

  /**
   * 发布前自检清单的唯一真源在 vault 的 SOP 目录里（一份 Markdown）。
   * 这里只负责把「读清单」这件事转出去：清单在哪儿、怎么找，由 index.js 决定，
   * 领域层只拿到条目数组，找不到就是 null。
   */
  async function loadChecklist() {
    if (typeof checklistProvider !== 'function') return null
    const loaded = await checklistProvider()
    if (loaded === null || loaded === undefined) return null
    const items = Array.isArray(loaded.items) ? loaded.items : []
    return { items, path: String(loaded.path ?? ''), uri: String(loaded.uri ?? '') }
  }

  /** 高风险判定：写「高」「中高」「高风险」都算高。以前只认精确字符串「高」，
   *  改成「中高」就绕过了门禁。禁发优先于一切。 */
  function riskKind(value) {
    const text = clean(value, 20)
    if (text.includes('禁发')) return '禁发'
    if (text.includes('高')) return '高'
    return text
  }

  function metricTable(month = '') {
    return createTable({
      header: METRIC_HEADER,
      keys: METRIC_KEYS,
      idKeys: ['variantId', 'date'],
      heading: '# 回流台账' + (month === '' ? '' : ' ' + month),
      intro: '> 按平台版本记录每次数据回流；一行一个版本一天，同一天重填会覆盖。',
      label: '指标',
      // 历史台账有三种表头：10 列（当前前 10 列）、11 列（第 11 列是
      // 已删除的「备注」）、17 列（还没有「统计口径」）。老行读入时只补空列，
      // 11 列的「备注」明确丢弃，绝不能挤进「完播率」。
      legacy: [
        { cells: 10, at: [] },
        { cells: 11, at: [], drop: [10] },
        { cells: 17, at: [] },
        { cells: 18, at: [] },
      ],
      validatePath: typeof vault.assertInsidePath === 'function' ? (file) => vault.assertInsidePath(file) : undefined,
      // 台账备份和笔记备份同一套落点（备份目录 + 原相对路径 + .bak）。
      backupPath: typeof vault.backupPathFor === 'function' ? (file) => vault.backupPathFor(file) : undefined,
    })
  }

  function variantIdOf(front, path) {
    const stored = clean(front?.id, 40)
    return stored !== '' ? stored : fallbackId('v', path)
  }

  async function listVariantPaths() {
    const root = variantsRoot()
    // 只扫 Workbench/平台版本/ 这一个目录，不再整库扫：
    // discover() 会把 vault 里每一篇笔记都读进内存算 sha1 和章节，
    // 而「有哪些平台版本」只需要知道这个目录下有哪些文件。
    if (typeof vault.listUnder === 'function') {
      const listed = await vault.listUnder(root)
      return listed.filter((item) => item.startsWith(root + '/') && item.toLowerCase().endsWith('.md'))
    }
    const discovered = await vault.discover()
    return discovered.notes
      .map((note) => note.path)
      .filter((item) => item.startsWith(root + '/') && item.toLowerCase().endsWith('.md'))
  }

  async function readVariant(path, { cached = false } = {}) {
    const note = await (cached && vault.readCachedNote !== undefined ? vault.readCachedNote(path) : vault.readNote(path))
    const parsed = fm.splitNote(note.text)
    const rawStatus = normalizeVariantStatus(parsed.front?.status) || '在写'
    const legacyArchived = rawStatus === '已归档'
    const restoredStatus = legacyArchived
      ? (normalizeVariantStatus(parsed.front?.archivedFrom) || (clean(parsed.front?.publishedAt, 40) === '' ? '已取消' : '待回填'))
      : rawStatus
    return {
      ...note,
      front: { ...parsed.front, status: restoredStatus, ...(legacyArchived && clean(parsed.front?.archivedAt, 40) === '' ? { archivedAt: 'legacy' } : {}) },
      body: parsed.body,
      rawStatus,
      id: variantIdOf(parsed.front, path),
      status: restoredStatus,
      archived: legacyArchived || clean(parsed.front?.archivedAt, 40) !== '',
      riskLevel: clean(parsed.front?.riskLevel, 20) || '低',
    }
  }

  async function findMaster(masterId) {
    const id = clean(masterId, 40)
    if (id === '') throw new VaultError('缺少主选题 ID', 'bad_request')
    if (typeof topics.findById === 'function') return topics.findById(id)
    const records = typeof topics.all === 'function' ? await topics.all({ includeVariants: false }) : await topics.list({ limit: 1000 })
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
    // 一个平台版本 = 一个平台 + 一个账号。平台栏写了「抖音 / 知乎」这种一格多平台，
    // 在这里直接拒掉：落盘以后没人说得清这一行到底代表哪个平台的稿子，
    // 标题、封面、自检、状态全是按平台分的。要同步发多个平台，请在同一个主选题下
    // 各建一个版本（产品里的「分发到多个平台」会一次建好）。
    const platforms = splitPlatforms(platform)
    if (platforms.length > 1) {
      throw new VaultError('一个平台版本只能对应一个平台；「' + platforms.join(' / ') + '」请拆成多个平台版本', 'bad_field')
    }
    let account = clean(input?.account, 100)
    const accountId = clean(input?.accountId, 40)
    if (accountId !== '') {
      if (typeof accountProvider !== 'function') throw new VaultError('账号档案暂不可用', 'bad_request')
      const record = await accountProvider(accountId)
      if (record === null || record === undefined) throw new VaultError('账号档案不存在：' + accountId, 'not_found')
      const accountPlatform = normalizePlatform(clean(record.front?.platform, 100))
      if (accountPlatform !== platform) throw new VaultError('所选账号属于「' + accountPlatform + '」，不能用于「' + platform + '」版本', 'bad_field')
      account = clean(record.front?.name, 100)
    } else if (account !== '') {
      throw new VaultError('要使用账号请从账号档案选择；也可以明确留空，暂不绑定账号', 'bad_field')
    }
    const status = normalizeVariantStatus(clean(input?.status, 20)) || '在写'
    if (!VARIANT_STATUSES.includes(status)) throw new VaultError('未知平台版本状态：' + status, 'bad_request')
    if (!['在写', '待发'].includes(status)) throw new VaultError('新建平台版本只能从「在写」或「待发」开始', 'bad_request')
    const front = {
      id: newId('v'),
      masterId: master.id,
      platform,
      account,
      accountId,
      titleOptions: clean(input?.titleOptions, 500),
      coverCopy: clean(input?.coverCopy, 500),
      materials: clean(input?.materials, 500),
      audience: clean(input?.audience, 300),
      purpose: clean(input?.purpose, 300),
      status,
      riskLevel: clean(input?.riskLevel, 20) || '低',
      publishCheck: clean(input?.publishCheck, 40),
      publishCheckItems: clean(input?.publishCheckItems, 400),
    }
    const title = safeName(platform + (account === '' ? '' : '-' + account), platform)
    const rel = join(variantsRoot(), safeName(master.id, 'master'), title + '.md').replace(/\\/g, '/')
    // 通用模板常驻：新建时带了草稿脚本就插在提示行下面，钩子/分段/自检骨架原样保留。
    // （以前客户端建完再 put 一次整篇替换正文，手打的脚本会把模板整个冲掉。）
    const script = String(input?.script ?? '').replace(/\r\n/g, '\n').trim()
    const checklist = await loadChecklist()
    const checklistLine = checklist === null || checklist.path === ''
      ? '> 自检清单以 SOP 里的《发布前检查清单》为准：找到那份文件后，这里会列出它。'
      : '> 自检清单以 SOP 里的《发布前检查清单》为准：' + checklist.path + '（改那份清单，工具里的自检项跟着变）。'
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
      // 这里不再抄一份固定清单：抄一份就会和 SOP 那份对不上（以前 SOP 6 条、产品 7 项，
      // 措辞完全不同）。自检项以 SOP 为准，勾选状态记在 frontmatter 的 publishCheckItems。
      '### 发布前自检',
      checklistLine,
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

  async function listVariants(masterId, { includeMetrics = true } = {}) {
    const id = clean(masterId, 40)
    const out = []
    for (const path of await listVariantPaths()) {
      const variant = await readVariant(path, { cached: true })
      if (id === '' || String(variant.front?.masterId ?? '') === id) out.push(variant)
    }
    const allMetrics = includeMetrics ? await listMetrics(id) : []
    const latest = new Map()
    for (const metric of allMetrics) {
      if (!latest.has(metric.variantId)) latest.set(metric.variantId, metric)
    }
    for (const variant of out) {
      variant.latestMetric = latest.get(variant.id) ?? null
      const closedAt = clean(variant.front?.reviewClosedAt, 40)
      const closedThrough = clean(variant.front?.reviewClosedThrough, 20)
      variant.hasNewDataAfterClose = variant.status === '已结案' && allMetrics.some((metric) => (
        String(metric.variantId ?? '') === variant.id
        && ((closedAt !== '' && String(metric.updatedAt ?? '') > closedAt)
          || (closedThrough !== '' && String(metric.date ?? '') > closedThrough))
      ))
    }
    out.sort((a, b) => String(a.path).localeCompare(String(b.path)))
    return out
  }

  async function getVariant(id) {
    const wanted = clean(id, 40)
    if (wanted === '') throw new VaultError('缺少平台版本 ID', 'bad_request')
    let matched = ''
    for (const path of await listVariantPaths()) {
      const variant = await readVariant(path, { cached: true })
      if (variant.id !== wanted) continue
      if (matched !== '') throw new VaultError('多个平台版本使用同一 ID，不能猜选：' + wanted, 'conflict')
      matched = path
    }
    if (matched !== '') {
      const variant = await readVariant(matched)
      const metrics = (await listMetrics(variant.front?.masterId)).filter((metric) => String(metric.variantId ?? '') === variant.id)
      variant.latestMetric = metrics[0] ?? null
      const closedAt = clean(variant.front?.reviewClosedAt, 40)
      const closedThrough = clean(variant.front?.reviewClosedThrough, 20)
      variant.hasNewDataAfterClose = variant.status === '已结案' && metrics.some((metric) => (
        (closedAt !== '' && String(metric.updatedAt ?? '') > closedAt)
        || (closedThrough !== '' && String(metric.date ?? '') > closedThrough)
      ))
      return variant
    }
    throw new VaultError('平台版本不存在：' + wanted, 'not_found')
  }

  async function updateVariant(path, { front: frontInput, body, expectedSha1 } = {}) {
    const before = await readVariant(path)
    const requestedStatus = clean(frontInput?.status, 20)
    if (requestedStatus !== '' && requestedStatus !== before.status) {
      throw new VaultError('状态只能通过「推进」按状态机修改', 'bad_request')
    }
    const patch = fm.normalizeFrontPatch(VARIANT_SCHEMA, frontInput, before.front)
    if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== before.id
      && !(clean(before.front.id, 40) === '' && patch.id === '')) {
      throw new VaultError('平台版本 ID 是稳定身份，不能通过属性编辑修改', 'bad_field')
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'masterId') && patch.masterId !== String(before.front.masterId ?? '')) {
      throw new VaultError('主选题关联不能通过普通属性编辑修改', 'bad_field')
    }
    for (const key of ['platform', 'account', 'accountId', 'publishedAt', 'archivedAt', 'cancelledAt', 'reviewCycle', 'reviewStatus', 'reviewDays', 'reviewStartedAt', 'reviewDueAt', 'reviewBaselineAt', 'reviewClosedAt', 'reviewClosedThrough', 'reviewClosedMetricId']) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && String(patch[key] ?? '') !== String(before.front?.[key] ?? '')) {
        throw new VaultError('「' + key + '」只能通过对应的专用操作修改', 'bad_field')
      }
    }
    if (clean(before.front.id, 40) === '' && Object.keys(patch).length > 0) patch.id = before.id
    // 自检进度不采信前端写上来的字符串：只认「勾了哪几项」，
    // 勾了几项由服务端按真实清单算。以前 publishCheck 是个自由文本字段，
    // 手改成 "7/7" 就能骗过门禁。
    if (Object.prototype.hasOwnProperty.call(patch, 'publishCheckItems')) {
      const checklist = await loadChecklist()
      const items = checklist === null ? [] : checklist.items
      const wanted = String(patch.publishCheckItems ?? '')
        .split(/[,;\s]+/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
      const recomputed = checklistPatch(items, wanted)
      patch.publishCheckItems = recomputed.publishCheckItems
      patch.publishCheck = recomputed.publishCheck
    }
    const nextBody = body === undefined ? before.body : String(body)
    const written = await vault.writeNote(path, fm.buildNote(patch, nextBody, before.text), { expectedSha1: expectedSha1 || before.sha1 })
    // 回读整篇：自检进度是服务端按真实清单重算的，前端得看得见算出来的结果，
    // 不能只回一句「写好了」让它自己猜。
    return { ...(await readVariant(path)), written }
  }

  /**
   * 发布门禁。
   *
   * 自检清单有几项、勾了几项，全部由 vault 里那份 SOP 清单决定 ——
   * 不再认「7/7」这种写死的字符串。以前写死「7/7」，一是清单改了条数门禁就废了，
   * 二是「中高」这种风险等级能绕过门禁。
   *
   * 清单本身读不到时：不能当成「全过了」，也不能让高风险内容发不出去却只给一句
   * 没法操作的话 —— 直接告诉人清单在哪儿、去补齐。
   */
  function assertTransition(from, to, riskLevel, checkState) {
    const current = normalizeVariantStatus(clean(from, 20)) || '在写'
    const next = normalizeVariantStatus(clean(to, 20))
    if (!VARIANT_STATUSES.includes(next)) throw new VaultError('未知平台版本状态：' + next, 'bad_request')
    const allowed = VARIANT_TRANSITIONS[current] ?? []
    if (!allowed.includes(next)) throw new VaultError('不允许从「' + current + '」直接到「' + next + '」', 'bad_request')
    if (next === '已发') {
      if (riskKind(riskLevel) === '禁发') throw new VaultError('风险等级为「禁发」，不能发布', 'bad_request')
      if (riskKind(riskLevel) === '高') {
        if (checkState === null || checkState === undefined || checkState.total === 0) {
          throw new VaultError('高风险内容发布前必须完成《发布前检查清单》，但没找到这份清单 —— 先在 SOP 目录里建一份再发', 'bad_request')
        }
        if (!checkState.complete) {
          throw new VaultError('高风险内容发布前必须把《发布前检查清单》全部 ' + checkState.total + ' 项勾完（当前 ' + checkState.done + '/' + checkState.total + '）', 'bad_request')
        }
      }
    }
  }

  /**
   * 预检：只读，不写盘。
   *
   * 「在日历标已发」和「版本推到已发」是两次写盘。以前顺序是先写日历、再推版本，
   * 版本推不动时日历已经写成「已发」了 —— 两本账对不上，接口还返回 200 装作没事。
   * 所以推之前先问一句「这一步推得动吗」，推不动就整条拒绝，一个字节都不写。
   *
   * steps 是状态机上的完整路径（中间可能经过「待发」）。逐步预检：中间任一步
   * 不允许，最后一步的门禁不过，都在这里暴露出来。
   */
  async function preflightSteps(path, steps) {
    const before = await readVariant(path)
    const checklist = await loadChecklist()
    const checkState = checklist === null ? null : checklistState(before.front, checklist.items)
    let cursor = before.status
    for (const step of steps) {
      try {
        assertTransition(cursor, step, before.riskLevel, checkState)
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) }
      }
      cursor = step
    }
    return { ok: true, from: before.status, steps }
  }

  async function transitionVariant(path, to, options = {}) {
    const before = await readVariant(path)
    const checklist = await loadChecklist()
    const checkState = checklist === null ? null : checklistState(before.front, checklist.items)
    assertTransition(before.status, to, before.riskLevel, checkState)
    const target = normalizeVariantStatus(clean(to, 20))
    if (target === '已结案') throw new VaultError('请使用「阶段结案」并选择结案快照', 'bad_request')
    const front = { status: target }
    if (options.actor !== undefined && clean(options.actor, 80) !== '') front.lastActor = clean(options.actor, 80)
    if (target === '已发') {
      const publishedAt = validIsoInstant(options.at, { future: false }) || new Date().toISOString()
      const reviewDays = reviewDaysOf(options.reviewDays)
      front.publishedAt = publishedAt
      front.publishedLink = clean(options.link, 300)
      front.reviewCycle = '1'
      front.reviewStatus = 'open'
      front.reviewDays = String(reviewDays)
      front.reviewStartedAt = publishedAt
      front.reviewDueAt = reviewDueAtFor(publishedAt, reviewDays, timezone)
      front.reviewBaselineAt = ''
    }
    if (target === '已取消') front.cancelledAt = new Date().toISOString()
    if (target === '在写' && before.status === '已取消') front.cancelledAt = ''
    const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  async function archiveVariant(path, options = {}) {
    const before = await readVariant(path)
    if (before.archived) throw new VaultError('这条平台版本已经收纳', 'bad_request')
    const front = { archivedAt: new Date().toISOString() }
    if (clean(options.actor, 80) !== '') front.lastActor = clean(options.actor, 80)
    const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  async function restoreVariant(path) {
    const before = await readVariant(path)
    if (!before.archived) throw new VaultError('这条平台版本没有收纳，不需要恢复', 'bad_request')
    const patch = {}
    const removeKeys = ['archivedAt', 'archivedFrom']
    if (before.rawStatus === '已归档') {
      patch.status = before.status
      if (before.status === '已取消' && clean(before.front?.cancelledAt, 40) === '') patch.cancelledAt = new Date().toISOString()
    }
    const written = await vault.writeNote(path, fm.buildNote(patch, before.body, before.text, { removeKeys }), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  async function appendMetric(input) {
    const date = clean(input?.date, 40) || localDay()
    const month = (input?.month !== undefined && clean(input.month, 7) !== '') ? clean(input.month, 7) : date.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) throw new VaultError('月份格式应为 YYYY-MM', 'bad_request')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new VaultError('数据日期格式应为 YYYY-MM-DD', 'bad_request')
    if (month !== date.slice(0, 7)) throw new VaultError('月份必须与数据日期一致', 'bad_request')
    const variantId = clean(input?.variantId, 40)
    if (variantId === '') throw new VaultError('缺少平台版本 ID', 'bad_request')
    const table = metricTable(month)
    const file = join(input?.dataDir ?? '', '回流台账', month + '.md')
    const state = await table.read(file)
    const existing = (state.entries ?? []).find((entry) => entry.variantId === variantId && entry.date === date)
    const now = new Date().toISOString()
    const base = existing === undefined ? {} : existing
    const row = {
      date,
      masterId: clean(input?.masterId, 40),
      variantId,
      platform: clean(input?.platform, 100),
      account: clean(input?.account, 100),
      views: clean(base.views, 40),
      likes: clean(base.likes, 40),
      comments: clean(base.comments, 40),
      shares: clean(base.shares, 40),
      link: clean(base.link, 300),
      // 内容复盘真正要看的几个数：完播、时长、涨粉、订单、GMV、退货原因，
      // 再记一条数据从哪来、按什么口径算的，否则「32%→58%」这种结论没法复核。
      completion: clean(base.completion, 40),
      avgDuration: clean(base.avgDuration, 40),
      followers: clean(base.followers, 40),
      orders: clean(base.orders, 40),
      gmv: clean(base.gmv, 40),
      returnReason: clean(base.returnReason, 300),
      source: clean(base.source, 100),
      caliber: clean(base.caliber, 200),
      metricId: clean(base.metricId, 40) || newId('m'),
      recordedAt: clean(base.recordedAt, 40) || now,
      updatedAt: now,
      revision: String(Math.max(0, Number(base.revision) || 0) + 1),
    }
    for (const key of METRIC_EDITABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(input ?? {}, key)) row[key] = clean(input[key], key === 'link' || key === 'returnReason' ? 300 : key === 'caliber' ? 200 : key === 'source' ? 100 : 40)
    }
    const result = existing === undefined
      ? await table.add(file, row)
      : await table.update(file, existing.id, row, { expectedSha1: state.sha1 })
    if (result.ok !== true) throw new VaultError(result.error, result.code ?? 'write_failed')
    return { entry: result.entry, file: file.replace(/\\/g, '/') }
  }

  function validCoreMetric(metric) {
    return ['views', 'likes', 'comments', 'shares', 'completion', 'avgDuration', 'followers', 'orders', 'gmv']
      .some((key) => String(metric?.[key] ?? '').trim() !== '' && Number.isFinite(Number(String(metric[key]).replace(/[%,$￥,\s]/g, ''))))
  }

  async function closeReview(path, metricId, options = {}) {
    const before = await readVariant(path)
    if (before.status !== '待回填') throw new VaultError('只有「待回填」的平台版本可以阶段结案', 'bad_request')
    const publishedAt = validIsoInstant(before.front?.publishedAt, { future: false })
    if (publishedAt === '') throw new VaultError('缺少可信的实际发布时间，不能结案', 'bad_request')
    const metrics = (await listMetrics(before.front?.masterId)).filter((metric) => String(metric.variantId) === before.id)
    const wanted = clean(metricId, 40)
    const metric = metrics.find((item) => String(item.metricId || item.id) === wanted)
    if (metric === undefined) throw new VaultError('找不到选定的结案快照', 'not_found')
    if (String(metric.date) < publishedAt.slice(0, 10)) throw new VaultError('结案快照不能早于实际发布时间', 'bad_field')
    if (clean(metric.source, 100) === '' || clean(metric.caliber, 200) === '') throw new VaultError('结案快照必须填写数据来源和统计口径', 'bad_field')
    if (!validCoreMetric(metric)) throw new VaultError('结案快照至少要填写一个有效的核心指标', 'bad_field')
    const cycle = Math.max(1, Number(before.front?.reviewCycle) || 1)
    const closedAt = new Date().toISOString()
    const snapshot = Object.fromEntries(METRIC_KEYS.map((key) => [key, String(metric[key] ?? '')]))
    const insight = String(options.insight ?? '').trim().slice(0, 1000)
    const reviewPath = join(workbenchDir, '复盘结案', safeName(before.id, 'variant'), String(cycle).padStart(3, '0') + '.md').replace(/\\/g, '/')
    const reviewFront = {
      id: newId('r'), variantId: before.id, cycle: String(cycle), closedAt,
      closedThrough: String(metric.date), metricId: String(metric.metricId || metric.id),
      metricHash: createHash('sha1').update(JSON.stringify(snapshot)).digest('hex'),
      actor: clean(options.actor, 80),
    }
    await vault.createNote(reviewPath, fm.buildNote(reviewFront, '# 阶段复盘结案\n\n## 本轮结论\n\n' + (insight === '' ? '- 待补' : insight) + '\n\n## 冻结快照\n\n```json\n' + JSON.stringify(snapshot, null, 2) + '\n```\n'))
    const front = {
      status: '已结案', reviewStatus: 'closed', reviewClosedAt: closedAt,
      reviewClosedThrough: String(metric.date), reviewClosedMetricId: String(metric.metricId || metric.id),
    }
    try {
      const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
      return { ...(await readVariant(path)), written, reviewPath, snapshot }
    } catch (error) {
      try { await vault.deleteNote(reviewPath) } catch { /* 原子补偿失败由原错误暴露，备份仍可恢复 */ }
      throw error
    }
  }

  async function startReview(path, days, options = {}) {
    const before = await readVariant(path)
    if (before.status !== '已结案') throw new VaultError('只有已结案版本可以开始新一轮观察', 'bad_request')
    const reviewDays = reviewDaysOf(days)
    const now = new Date().toISOString()
    const cycle = Math.max(1, Number(before.front?.reviewCycle) || 1) + 1
    const front = {
      status: '待回填', reviewCycle: String(cycle), reviewStatus: 'open', reviewDays: String(reviewDays),
      reviewStartedAt: now, reviewDueAt: reviewDueAtFor(now, reviewDays, timezone), reviewBaselineAt: clean(before.front?.reviewClosedAt, 40),
      reviewClosedAt: '', reviewClosedThrough: '', reviewClosedMetricId: '',
    }
    if (clean(options.actor, 80) !== '') front.lastActor = clean(options.actor, 80)
    const written = await vault.writeNote(path, fm.buildNote(front, before.body, before.text), { expectedSha1: before.sha1 })
    return { ...(await readVariant(path)), written }
  }

  async function correctVariantIdentity(path, accountIdInput) {
    const before = await readVariant(path)
    const accountId = clean(accountIdInput, 40)
    if (accountId === '') throw new VaultError('纠正归属时必须选择账号档案', 'bad_request')
    if (typeof accountProvider !== 'function') throw new VaultError('账号档案暂不可用', 'bad_request')
    const record = await accountProvider(accountId)
    if (record === null || record === undefined) throw new VaultError('账号档案不存在：' + accountId, 'not_found')
    const platform = normalizePlatform(clean(record.front?.platform, 100))
    const account = clean(record.front?.name, 100)
    if (platform === '' || account === '') throw new VaultError('账号档案缺少平台或账号名', 'bad_field')
    const conflict = (await listVariants(before.front?.masterId, { includeMetrics: false })).find((item) => (
      item.id !== before.id
      && normalizePlatform(item.front?.platform) === platform
      && clean(item.front?.accountId, 40) === accountId
    ))
    if (conflict !== undefined) throw new VaultError('这个主选题已经有同平台同账号的版本，不能把两本台账合成一条', 'conflict')

    const metrics = (await listMetrics(before.front?.masterId)).filter((metric) => String(metric.variantId ?? '') === before.id)
    const plans = []
    for (const file of [...new Set(metrics.map((metric) => String(metric.file ?? '')))].filter((file) => file !== '')) {
      const month = /([0-9]{4}-[0-9]{2})\.md$/.exec(file)?.[1] ?? ''
      const table = metricTable(month)
      const state = await table.read(file)
      if (state.warning !== undefined) throw new VaultError('台账读取失败：' + state.warning, state.code ?? 'read_failed')
      const next = (state.entries ?? []).map((entry) => String(entry.variantId ?? '') === before.id ? { ...entry, platform, account } : entry)
      plans.push({ file, table, before: state.entries ?? [], next, sha1: state.sha1 ?? '' })
    }

    const applied = []
    try {
      for (const plan of plans) {
        const written = await plan.table.replaceAll(plan.file, plan.next, { expectedSha1: plan.sha1 })
        if (written.ok !== true) throw new VaultError('台账归属同步失败：' + String(written.error ?? '未知错误'), written.code ?? 'write_failed')
        applied.push({ ...plan, writtenSha1: written.sha1 })
      }
      const written = await vault.writeNote(path, fm.buildNote({ platform, account, accountId }, before.body, before.text), { expectedSha1: before.sha1 })
      return { ...(await readVariant(path)), written, metricsChanged: metrics.length, previousIdentity: { platform: before.front?.platform ?? '', account: before.front?.account ?? '', accountId: before.front?.accountId ?? '' } }
    } catch (error) {
      const rollbackFailed = []
      for (const plan of applied.slice().reverse()) {
        const rolled = await plan.table.replaceAll(plan.file, plan.before, { expectedSha1: plan.writtenSha1 })
        if (rolled.ok !== true) rollbackFailed.push({ file: plan.file, error: rolled.error ?? '回滚失败' })
      }
      if (rollbackFailed.length > 0) throw new VaultError('纠正归属失败，且部分台账回滚失败，请检查报告', 'conflict', { partial: true, rollbackFailed })
      throw error
    }
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
    preflightSteps,
    archiveVariant,
    restoreVariant,
    appendMetric,
    closeReview,
    startReview,
    correctVariantIdentity,
    variantSummary,
    assertTransition,
    listMetrics,
    metricTable,
    loadChecklist,
    checklistState,
    checklistPatch,
  }
}
