/**
 * 文案规则库的往返测试。
 *
 * 这里守的是两个曾经把用户数据吃掉的 bug：
 *   1. 真实 rules.md 的编号是「### H1 · 标题」，而解析器只认「R-001 · 标题」，
 *      于是 16 条规则的 id 全是空串。保存时后端按 id 匹配 —— 空串等于「全都匹配」，
 *      删一条会删光 16 条，改一条会把 16 条标题全改成同一条。
 *   2. 字段白名单只有 证据/来源/强度/反例，真实文件写的是「内容 / 改法」，
 *      往返一次 3526 字变 2137 字。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as rules from '../lib/rules.js'

// 用真实文件的第一节做夹具，形状与线上一致（H1 · 标题 / 内容 / 证据 / 反例 / 改法）。
const FIXTURE = [
  '# 文案规则 / 语调库',
  '',
  '> 简介',
  '',
  '## 状态一览',
  '',
  '| 指标 | 数值 |',
  '| --- | --- |',
  '| 硬规则数 | 2 |',
  '',
  '## 硬规则',
  '',
  '### H1 · 禁用绝对化极限词',
  '- **内容**：不写「最」「第一」。',
  '- **证据**：《广告法》第九条。',
  '- **反例**：「全网最低价」。',
  '- **改法**：换成有边界的表达。',
  '',
  '### H2 · 不写没有口径的数字',
  '- **内容**：量化结论必须标样本量。',
  '- **证据**：待补。',
  '- **反例**：「提升 300%」。',
  '- **改法**：「12 次测试里从 8 分钟降到 3 分钟」。',
  '',
  '## 软规则',
  '',
  '### S1 · 一句话一个意思',
  '- **内容**：一句一个意思。',
  '- **证据**：待补。',
  '- **反例**：长句套长句。',
  '- **改法**：拆开写。',
  '',
].join('\n')

test('rules: 编号认 H1 这种前缀，不再是空串', () => {
  const items = rules.parseRules(FIXTURE).items
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.id), ['H1', 'H2', 'S1'])
  assert.equal(items[0].title, '禁用绝对化极限词')
  // 空串 id 会让「按 id 匹配」把全部规则当成同一条。
  assert.ok(items.every((item) => item.id.trim() !== ''))
  assert.equal(new Set(items.map((item) => item.id)).size, items.length)
})

test('rules: 内容 / 改法 两个字段往返不丢', () => {
  const parsed = rules.parseRules(FIXTURE)
  const h1 = parsed.items.find((item) => item.id === 'H1')
  assert.equal(h1.fields['内容'], '不写「最」「第一」。')
  assert.equal(h1.fields['改法'], '换成有边界的表达。')
  const round = rules.parseRules(rules.renderRules(parsed)).items
  assert.deepEqual(round, parsed.items)
})

test('rules: 删一条只少一条，改一条不动别人', () => {
  const parsed = rules.parseRules(FIXTURE)
  const kept = parsed.items.filter((item) => item.id !== 'H2')
  assert.equal(kept.length, 2)
  assert.equal(kept.some((item) => item.id === 'H2'), false)
  assert.deepEqual(kept.map((item) => item.title), ['禁用绝对化极限词', '一句话一个意思'])

  const edited = parsed.items.map((item) => (item.id === 'H1' ? { ...item, title: '改过的标题' } : item))
  assert.equal(edited.filter((item) => item.title === '改过的标题').length, 1)
  assert.equal(edited.find((item) => item.id === 'H2').title, '不写没有口径的数字')
})

test('rules: 没有编号的标题也拿到唯一 id', () => {
  const text = ['## 硬规则', '', '### 随手写的一条', '- **内容**：x', '', '### 另一条', '- **内容**：y', ''].join('\n')
  const items = rules.parseRules(text).items
  assert.equal(items.length, 2)
  assert.ok(items.every((item) => item.id.startsWith('X-')))
  assert.notEqual(items[0].id, items[1].id)
})

test('rules: 新编号跟着分组走（H7 / S8 / W4）', () => {
  const items = [
    { id: 'H6', section: 'hard' },
    { id: 'S7', section: 'soft' },
    { id: 'W3', section: 'watch' },
  ]
  assert.equal(rules.nextRuleId(items, 'hard'), 'H7')
  assert.equal(rules.nextRuleId(items, 'soft'), 'S8')
  assert.equal(rules.nextRuleId(items, 'watch'), 'W4')
  // 不指定分组时沿用用得最多的前缀，且仍是合法的 R-001 风格回退。
  assert.equal(rules.nextRuleId([], 'hard'), 'H1')
  assert.equal(rules.nextRuleId([], ''), 'R-001')
})

test('rules: normalizeRule 保留自定义列并拒绝换行', () => {
  const ok = rules.normalizeRule({ id: 'H9', section: 'hard', title: 't', fields: { 内容: 'a', 改法: 'b', 自造列: 'c' } }, { existingIds: [] })
  assert.equal(ok.ok, true)
  assert.equal(ok.item.fields['内容'], 'a')
  assert.equal(ok.item.fields['改法'], 'b')
  assert.equal(ok.item.fields['自造列'], 'c')

  const bad = rules.normalizeRule({ id: 'H9', section: 'hard', title: 't', fields: { 内容: 'a\nb' } }, { existingIds: [] })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不能含换行/)

  const dup = rules.normalizeRule({ id: 'H1', section: 'hard', title: 't', fields: {} }, { existingIds: ['H1'] })
  assert.equal(dup.ok, false)
})
