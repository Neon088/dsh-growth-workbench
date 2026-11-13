import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createTable } from '../lib/table.js'
import { createVaultStore, previewOf, sectionsOf } from '../lib/vault.js'
import * as fm from '../lib/frontmatter.js'
import * as csv from '../lib/csv.js'
import * as rules from '../lib/rules.js'
import { reviewDueAtFor } from '../lib/domain.js'

async function tempVault() {
  const root = await mkdtemp(join(tmpdir(), 'growth-vault-'))
  await mkdir(join(root, 'SOP'), { recursive: true })
  return root
}

const glossary = () => createTable({
  header: ['中文', '英文', '领域', '标签', '备注'],
  keys: ['zh', 'en', 'domain', 'tags', 'note'],
  idKeys: ['zh', 'en'],
  heading: '# 指标与黑话',
  label: '术语',
})

test('观察截止：发布当天算第 1 天，并按上海自然日截止', () => {
  assert.equal(reviewDueAtFor('2026-01-31T16:30:00Z', 1), '2026-02-01T23:59:59+08:00')
  assert.equal(reviewDueAtFor('2024-02-28T10:00:00+08:00', 2), '2024-02-29T23:59:59+08:00')
  assert.equal(reviewDueAtFor('2024-02-29T23:30:00+08:00', 1), '2024-02-29T23:59:59+08:00')
  assert.equal(reviewDueAtFor('2026-01-31T10:00:00+08:00', 2), '2026-02-01T23:59:59+08:00')
})

test('table: 增改删 + id 稳定 + 拒绝竖线', async () => {
  const file = join(await tempVault(), 'Workbench', '指标.md')
  const table = glossary()
  const added = await table.add(file, { zh: 'ROI', en: 'Return on Investment', domain: '电商', tags: '核心', note: '投入产出比' })
  assert.equal(added.ok, true)
  assert.equal(added.entry.id, table.idOf({ zh: 'ROI', en: 'Return on Investment' }))

  const again = await table.add(file, { zh: 'ROI', en: 'Return on Investment' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'duplicate')

  const bad = await table.add(file, { zh: 'GMV|口径', en: 'gmv' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'invalid_table')

  const state = await table.read(file)
  assert.equal(state.entries.length, 1)
  const updated = await table.update(file, added.entry.id, { zh: 'ROI', en: 'Return on Investment', note: '改过' })
  assert.equal(updated.ok, true)
  assert.equal(updated.entry.note, '改过')

  const removed = await table.remove(file, added.entry.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.entries.length, 0)
  assert.match(await readFile(file, 'utf8'), /^# 指标与黑话/)
})

test('table: 写入前留 .bak', async () => {
  const file = join(await tempVault(), 't.md')
  const table = glossary()
  await table.add(file, { zh: 'CTR', en: 'click through rate' })
  await table.add(file, { zh: 'CPM', en: 'cost per mille' })
  const backup = await readFile(file + '.bak', 'utf8')
  assert.match(backup, /CTR/)
  assert.doesNotMatch(backup, /CPM/)
})

test('vault: expectedSha1 冲突被拦住且原文件不变', async () => {
  const root = await tempVault()
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP' })
  const created = await vault.createNote('SOP/开张.md', '# 开张\n')
  const stale = created.sha1
  await vault.writeNote('SOP/开张.md', '# 开张\n改了\n', { expectedSha1: stale })
  await assert.rejects(
    () => vault.writeNote('SOP/开张.md', '# 又被改\n', { expectedSha1: stale }),
    (error) => error.code === 'conflict' && typeof error.extra.currentSha1 === 'string',
  )
  const now = await vault.readNote('SOP/开张.md')
  assert.match(now.text, /改了/)
})

test('vault: 拒绝 .. 与绝对路径', async () => {
  const root = await tempVault()
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP' })
  await assert.rejects(() => vault.readNote('../outside.md'), (error) => error.code === 'bad_path')
  await assert.rejects(() => vault.readNote('C:/Windows/x.md'), (error) => error.code === 'bad_path')
  await assert.rejects(() => vault.readNote('SOP/a.txt'), (error) => error.code === 'bad_path')
})

test('vault: 目录树/搜索/行内预览', async () => {
  const root = await tempVault()
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP' })
  await vault.createNote('SOP/平台/小红书.md', '# 小红书冷启动\n\n先养号 7 天。\n')
  await vault.createNote('SOP/抖音.md', '# 抖音\n\n前 3 秒决定完播。\n')
  const tree = await vault.tree()
  assert.equal(tree.length, 2)
  assert.equal(tree[0].type, 'dir')
  assert.equal(tree[0].count, 1)

  vault.invalidate()
  const hits = await vault.search('完播')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, 'SOP/抖音.md')
  assert.match(hits[0].snippet, /完播/)

  assert.equal(previewOf('# 标题\n\n**加粗** 正文'), '标题 加粗 正文')
  assert.deepEqual(sectionsOf('# a\nx\n## b\ny').map((section) => section.title), ['a', 'b'])
})

test('vault: Obsidian URI 用真正的库根而不是配置的子目录名', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'growth-ob-vault-'))
  await mkdir(join(outer, '.obsidian'), { recursive: true })
  const root = join(outer, 'vault')
  await mkdir(join(root, 'Data'), { recursive: true })
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP' })
  await vault.createNote('Data/2026 W44.md', '# 周报\n')
  const uri = await vault.uriFor('Data/2026 W44.md')
  const parsed = new URL(uri)
  assert.equal(parsed.searchParams.get('vault'), basename(outer))
  assert.equal(parsed.searchParams.get('file'), 'vault/Data/2026 W44')
})

test('frontmatter: 解析/生成往返', () => {
  const text = fm.buildNote({ platform: '小红书', date: '2026-11-01', views: 1200, status: '已发', link: 'https://x.com/a?b=1' }, '## 正文\n- 一\n')
  const parsed = fm.splitNote(text)
  assert.equal(parsed.front.platform, '小红书')
  assert.equal(parsed.front.views, 1200)
  assert.equal(parsed.front.link, 'https://x.com/a?b=1')
  assert.match(parsed.body, /## 正文/)
})

test('frontmatter: 过滤与排序', () => {
  const records = [
    { title: 'a', mtimeMs: 1, front: { platform: '小红书', views: 100 } },
    { title: 'b', mtimeMs: 3, front: { platform: '抖音', views: 900 } },
    { title: 'c', mtimeMs: 2, front: { platform: '小红书', views: 50 } },
  ]
  assert.equal(fm.filterRecords(records, { platform: '小红书' }).length, 2)
  assert.equal(fm.filterRecords(records, { platform: '小红书', views: '5' }).length, 1)
  assert.deepEqual(fm.sortRecords(records, 'views').map((record) => record.title), ['b', 'a', 'c'])
  assert.deepEqual(fm.sortRecords(records, '_mtime').map((record) => record.title), ['b', 'c', 'a'])
})

test('frontmatter: 必填校验与模板渲染', () => {
  const schema = [{ key: 'platform', label: '平台', required: true }, { key: 'date', label: '日期', required: true }]
  assert.throws(() => fm.normalizeFront(schema, { date: '2026-11-01' }), (error) => error.code === 'bad_field')
  const front = fm.normalizeFront(schema, { platform: '抖音', date: '2026-11-01' })
  const text = fm.renderFromTemplate(schema, front, '- 平台：{platform}\n- 日期：{date}\n')
  assert.match(text, /- 平台：抖音/)
  assert.match(text, /platform: 抖音/)
})

test('csv: 解析引号/换行 + 列映射 + 猜测', () => {
  const rows = csv.parseCsv('日期,GMV,备注\n2026-11-01,"1,200",好\n2026-11-02,900,"含,逗号"\n')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1], ['2026-11-01', '1,200', '好'])

  const mapping = csv.guessMapping(rows[0], ['gmv', 'date'])
  const mapped = csv.applyMapping(rows, mapping, { numericFields: ['gmv'] })
  assert.equal(mapped.length, 2)
  assert.equal(mapped[0].gmv, 1200)
  assert.equal(mapped[1].gmv, 900)

  const back = csv.toCsv(['a', 'b'], [{ a: 'x,y', b: 1 }])
  assert.match(back, /"x,y",1/)
})

const RULES_SAMPLE = [
  '# 文案规则',
  '',
  '## 状态一览',
  '',
  '| 指标 | 数值 |',
  '',
  '## 硬规则',
  '',
  '### R-001 · 不写「最」字绝对化用语',
  '- **证据**：被平台限流一次',
  '- **来源**：2026-10 复盘',
  '- **强度**：硬',
  '',
  '## 软规则',
  '',
  '### R-002 · 开头先给结论',
  '- **证据**：完播率 +12%',
  '',
  '## 待观察',
  '',
].join('\n')

test('rules: 解析结构 + 回写', () => {
  const parsed = rules.parseRules(RULES_SAMPLE)
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[0].id, 'R-001')
  assert.equal(parsed.items[0].section, 'hard')
  assert.equal(parsed.items[1].section, 'soft')
  assert.match(parsed.items[0].fields.证据, /限流/)
  assert.equal(rules.nextRuleId(parsed.items), 'R-003')

  const rendered = rules.renderRules(parsed)
  assert.match(rendered, /### R-001 · 不写「最」字绝对化用语/)
  assert.match(rendered, /## 待观察/)
  const reparsed = rules.parseRules(rendered)
  assert.equal(reparsed.items.length, 2)
  assert.equal(reparsed.items[0].fields.来源, '2026-10 复盘')
})

test('rules: 计数表刷新 + 校验', () => {
  const parsed = rules.parseRules(RULES_SAMPLE)
  const next = rules.refreshCounts(RULES_SAMPLE, parsed.items)
  assert.match(next, /\| 硬规则数 \| 1 \|/)
  assert.match(next, /\| 软规则数 \| 1 \|/)

  assert.equal(rules.normalizeRule({ id: 'R-9', section: 'hard', title: '' }).ok, false)
  assert.equal(rules.normalizeRule({ id: 'R-9', section: 'nope', title: 'x' }).ok, false)
  assert.equal(rules.normalizeRule({ id: 'R-001', section: 'hard', title: 'x' }, { existingIds: ['R-001'] }).ok, false)
  const good = rules.normalizeRule({ id: 'R-003', section: 'watch', title: '标题别超 18 字', fields: { 证据: '点击率下降' } })
  assert.equal(good.ok, true)
  assert.equal(good.item.fields.证据, '点击率下降')
})

test('table: 解析失败保护（怪表格不改原文件）', async () => {
  const file = join(await tempVault(), 'broken.md')
  await writeFile(file, '# x\n\n| a | b\n没有竖线结尾\n', 'utf8')
  const table = glossary()
  const before = await readFile(file, 'utf8')
  const added = await table.add(file, { zh: 'CPA', en: 'cost per action' })
  // 表头对不上不能当成空表覆盖；真实验收是拒写且逐字保留。
  assert.equal(added.ok, false)
  assert.equal(added.code, 'invalid_table')
  assert.equal(await readFile(file, 'utf8'), before)
})

test('table: legacy 多格式还原（5列/6列/7列老日历都读得对）', async () => {
  // 现在的日历是 8 列：[日期,平台,主题,状态,备注,链接,选题笔记,商品档案]
  const cal = createTable({
    header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案'],
    keys: ['date', 'platform', 'topic', 'status', 'note', 'link', 'topicPath', 'productPath'],
    idKeys: ['date', 'platform', 'topic'],
    legacy: [
      { cells: 5, at: [{ index: 4 }] },
      { cells: 6, at: [{ index: 6 }, { index: 7 }] },
      { cells: 7, at: [{ index: 7 }] },
    ],
    label: '日历',
  })
  const file = join(await tempVault(), 'Calendar', '2026-11.md')
  await mkdir(join(file, '..'), { recursive: true })
  const text = [
    '| 日期 | 平台 | 主题 | 状态 | 备注 | 链接 | 选题笔记 | 商品档案 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 2026-11-01 | 小红书 | 五列老格式 | 已发 | https://x.cn/a |',                     // 5 列
    '| 2026-11-02 | 小红书 | 六列老格式 | 已发 | 早上发 | https://x.cn/b |',              // 6 列
    '| 2026-11-03 | 小红书 | 七列老格式 | 已发 | 早上发 | https://x.cn/c | Topics/c.md |', // 7 列
    '| 2026-11-04 | 小红书 | 新格式 | 已发 | 早上发 | https://x.cn/d | Topics/d.md | Products/d.md |',
  ].join('\n') + '\n'
  await writeFile(file, text, 'utf8')
  const state = await cal.read(file)
  const byTopic = Object.fromEntries(state.entries.map((e) => [e.topic, e]))

  // 5 列：[日期,平台,主题,状态,链接] ——「链接」必须落在 link，不能当备注
  assert.equal(byTopic['五列老格式'].note, '')
  assert.equal(byTopic['五列老格式'].link, 'https://x.cn/a')
  // 6 列：有备注有链接
  assert.equal(byTopic['六列老格式'].note, '早上发')
  assert.equal(byTopic['六列老格式'].link, 'https://x.cn/b')
  assert.equal(byTopic['六列老格式'].topicPath, '')
  // 7 列：多了选题笔记
  assert.equal(byTopic['七列老格式'].topicPath, 'Topics/c.md')
  assert.equal(byTopic['七列老格式'].productPath, '')
  // 8 列：全都有
  assert.equal(byTopic['新格式'].topicPath, 'Topics/d.md')
  assert.equal(byTopic['新格式'].productPath, 'Products/d.md')
})

test('table: 多补列按升级后的表头位置映射，旧行状态不串列', async () => {
  const root = await tempVault()
  const ideas = createTable({
    header: ['日期', '来源', '来源URL', '内容', '状态', '去向'],
    keys: ['date', 'source', 'sourceUrl', 'content', 'status', 'outcome'],
    idKeys: ['date', 'content'],
    legacy: [
      { cells: 5, at: [{ index: 2 }] },
      { cells: 4, at: [{ index: 2 }, { index: 5 }] },
    ],
    label: '灵感',
  })
  const ideaFile = join(root, 'Workbench', '灵感箱.md')
  await mkdir(join(ideaFile, '..'), { recursive: true })
  await writeFile(ideaFile, [
    '| 日期 | 来源 | 内容 | 状态 |',
    '| --- | --- | --- | --- |',
    '| 2026-11-01 | 评论 | 四列老行 | 已用 |',
    '',
  ].join('\n'), 'utf8')
  const idea = (await ideas.read(ideaFile)).entries[0]
  assert.equal(idea.sourceUrl, '')
  assert.equal(idea.content, '四列老行')
  assert.equal(idea.status, '已用')
  assert.equal(idea.outcome, '')

  const feedback = createTable({
    header: ['日期', '渠道', '来源', '情感', '内容', '标签', '处理意见', '处理结果', '状态'],
    keys: ['date', 'channel', 'source', 'sentiment', 'content', 'tags', 'advice', 'resolution', 'status'],
    idKeys: ['date', 'content'],
    legacy: [
      { cells: 8, at: [{ index: 2 }] },
      { cells: 6, at: [{ index: 2 }, { index: 6 }, { index: 7 }] },
    ],
    label: '反馈',
  })
  const feedbackFile = join(root, 'Feedback', '客户反馈.md')
  await mkdir(join(feedbackFile, '..'), { recursive: true })
  await writeFile(feedbackFile, [
    '| 日期 | 渠道 | 情感 | 内容 | 标签 | 状态 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2026-11-02 | 私信 | 正 | 六列老行 | 口碑 | 未处理 |',
    '',
  ].join('\n'), 'utf8')
  const row = (await feedback.read(feedbackFile)).entries[0]
  assert.equal(row.source, '')
  assert.equal(row.tags, '口碑')
  assert.equal(row.advice, '')
  assert.equal(row.resolution, '')
  assert.equal(row.status, '未处理')
})

test('table: 旧表里已删除的列按 drop 丢掉，不会挤进新列', async () => {
  const root = await tempVault()
  const metrics = createTable({
    header: ['日期', '主选题ID', '平台版本ID', '平台', '账号', '播放/阅读', '赞/收藏', '评论', '转发', '链接', '完播率', '平均播放时长', '粉丝净增', '订单', 'GMV', '退货原因', '数据来源', '统计口径'],
    keys: ['date', 'masterId', 'variantId', 'platform', 'account', 'views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber'],
    idKeys: ['variantId', 'date'],
    legacy: [
      { cells: 10, at: [] },
      { cells: 11, at: [], drop: [10] },
      { cells: 17, at: [] },
    ],
    label: '指标',
  })
  const file = join(root, 'Data', '回流台账', '2026-10.md')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, [
    '| 日期 | 主选题ID | 平台版本ID | 平台 | 账号 | 播放/阅读 | 赞/收藏 | 评论 | 转发 | 链接 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 2026-10-28 | t1 | v1 | 抖音 |  | 92000 | 4100 | 220 | 640 | https://v.douyin.com/demo | 旧备注不迁移 |',
    '',
  ].join('\n'), 'utf8')
  const state = await metrics.read(file)
  assert.equal(state.warning, undefined)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].views, '92000')
  assert.equal(state.entries[0].likes, '4100')
  assert.equal(state.entries[0].link, 'https://v.douyin.com/demo')
  assert.equal(state.entries[0].completion, '')
  assert.equal(state.entries[0].gmv, '')
})
