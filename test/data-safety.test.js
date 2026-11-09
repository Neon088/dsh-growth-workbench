/**
 * 数据安全测试：守的是「保存一次就悄悄丢掉用户手写内容」这一类 bug。
 * 每个用例对应一次真实的数据丢失路径，失败时先别改测试，先看是不是回归了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTable } from '../lib/table.js'
import * as fm from '../lib/frontmatter.js'

test('frontmatter: 保存时保留 aliases / created / YAML 列表', () => {
  const original = [
    '---',
    'title: 一条选题',
    'platform: 抖音',
    'aliases:',
    '  - 老标题',
    '  - 备选标题',
    'created: 2026-01-02',
    'cover: "[[cover.png]]"',
    'tags: [a, b]',
    '---',
    '',
    '## 正文',
    '原文',
    '',
  ].join('\n')
  // 插件只管 title / platform，其余字段必须原样留下。
  const next = fm.buildNote({ title: '改过的标题', platform: '小红书' }, '## 正文\n原文\n', original)
  assert.match(next, /title: 改过的标题/)
  assert.match(next, /platform: 小红书/)
  assert.match(next, /aliases:\n  - 老标题\n  - 备选标题/)
  assert.match(next, /created: 2026-01-02/)
  assert.match(next, /cover: "\[\[cover.png\]\]"/)
  // 列表保持原样，不被降级成带引号的一整串。
  assert.match(next, /tags: \[a, b\]/)
  assert.match(next, /## 正文/)
})

test('frontmatter: 新键追加，旧键不重复', () => {
  const original = ['---', 'a: 1', '---', '', 'body', ''].join('\n')
  const next = fm.buildNote({ a: '2', b: '3' }, 'body\n', original)
  assert.equal(next.split('a:').length - 1, 1)
  assert.match(next, /a: 2/)
  assert.match(next, /b: 3/)
})

test('table: 增删改只动表格那一段，表外正文与第二张表都在', async () => {
  const root = await mkdtemp(join(tmpdir(), 'growth-safety-'))
  await mkdir(join(root, 'Workbench'), { recursive: true })
  const file = join(root, 'Workbench', '指标.md')
  const table = createTable({
    header: ['中文', '英文', '领域', '标签', '备注'],
    keys: ['zh', 'en', 'domain', 'tags', 'note'],
    idKeys: ['zh', 'en'],
    heading: '# 指标与黑话',
    label: '术语',
  })
  const original = [
    '# 指标与黑话',
    '',
    '> 简介：这段在表格外面，不能被抹掉。',
    '',
    '| 中文 | 英文 | 领域 | 标签 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    '| ROI | Return on Investment | 电商 | 核心 | 投入产出比 |',
    '',
    '## 备查',
    '',
    '| 别的 | 表 |',
    '| --- | --- |',
    '| 不该 | 被删 |',
    '',
    '文末的一句话。',
    '',
  ].join('\n')
  await writeFile(file, original, 'utf8')

  await table.add(file, { zh: 'GMV', en: 'Gross Merchandise Volume', domain: '电商', tags: '', note: '成交总额' })
  let text = await readFile(file, 'utf8')
  assert.match(text, /这段在表格外面，不能被抹掉/)
  assert.match(text, /## 备查/)
  assert.match(text, /\| 不该 \| 被删 \|/)
  assert.match(text, /文末的一句话/)
  assert.match(text, /GMV/)

  const rows = table.parse(text)
  const target = rows.find((row) => row.zh === 'GMV')
  await table.update(file, target.id, { ...target, note: '成交总额（含退款前）' })
  text = await readFile(file, 'utf8')
  assert.match(text, /含退款前/)
  assert.match(text, /这段在表格外面，不能被抹掉/)
  assert.match(text, /\| 不该 \| 被删 \|/)

  await table.remove(file, target.id)
  text = await readFile(file, 'utf8')
  assert.doesNotMatch(text, /含退款前/)
  assert.match(text, /这段在表格外面，不能被抹掉/)
  assert.match(text, /\| 不该 \| 被删 \|/)
  assert.match(text, /文末的一句话/)
})

test('table: 新建文件时仍然写 heading 与 intro', async () => {
  const root = await mkdtemp(join(tmpdir(), 'growth-safety2-'))
  const file = join(root, '新建.md')
  const table = createTable({
    header: ['日期', '内容'],
    keys: ['date', 'text'],
    idKeys: ['date', 'text'],
    heading: '# 灵感箱',
    intro: '> 随手记，别怕乱。',
  })
  await table.add(file, { date: '2026-11-04', text: '一个想法' })
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# 灵感箱/)
  assert.match(text, /> 随手记，别怕乱。/)
  assert.match(text, /一个想法/)
})
