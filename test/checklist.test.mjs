// SOP 发布前检查清单的解析契约。
//
// 清单是发布门禁的唯一真源，解析错一条，要么把示例代码当成门槛，
// 要么让 `- [ ]` 的方括号跟着条目进界面。这里把几种真实写法都钉住。
import assert from 'node:assert/strict'
import {
  parseChecklist,
  checklistItemId,
  checkedIdsOf,
  checklistState,
  checklistPatch,
} from '../lib/checklist.js'

let pass = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    pass += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures.push(name)
    console.log('FAIL ' + name + '\n     ' + String(error?.stack ?? error).split('\n')[0])
  }
}

const markdown = [
  '# 发布前检查清单',
  '',
  '- 标题不超过平台字数上限，且含一个具体数字',
  '* 前 3 秒出现结论，不寒暄',
  '- [ ] 字幕错别字过一遍',
  '- [x] 封面文字 ≤ 8 个字，手机上看清',
  '',
  '```md',
  '- 这条是代码示例，不是自检项',
  '```',
  '',
  '~~~',
  '- 波浪线围栏里的也不是',
  '~~~',
  '',
  '> 发布后 3~7 天数据稳定，再回「待回流」填播放和点赞。',
  '| 字段 | 说明 |',
  '| --- | --- |',
  '',
].join('\n')

test('纯列表、任务列表都读成条目，勾选框标记被剥掉', () => {
  const items = parseChecklist(markdown)
  assert.equal(items.length, 4)
  assert.deepEqual(items.map((item) => item.text), [
    '标题不超过平台字数上限，且含一个具体数字',
    '前 3 秒出现结论，不寒暄',
    '字幕错别字过一遍',
    '封面文字 ≤ 8 个字，手机上看清',
  ])
})

test('围栏代码块、引用、表格和标题都不算自检项', () => {
  assert.deepEqual(parseChecklist('标题\n\n```\n- 示例\n```\n\n> 说明\n\n| a | b |\n| --- | --- |'), [])
  assert.deepEqual(parseChecklist('~~~js\n- 示例\n~~~'), [])
})

test('条目 id 只跟文本走：顺序变了、文档其它地方改了都不换 id', () => {
  const first = parseChecklist(markdown)
  const reordered = parseChecklist(['# 换个标题', '', ...first.map((item) => '- ' + item.text).reverse()].join('\n'))
  const ids = new Set(first.map((item) => item.id))
  assert.ok(reordered.every((item) => ids.has(item.id)))
  assert.equal(checklistItemId('  同一条  '), checklistItemId('同一条'))
  assert.notEqual(checklistItemId('A'), checklistItemId('B'))
})

test('重复文本只留一条，勾选 id 去重且只认清单里真实存在的项', () => {
  assert.equal(parseChecklist('- 同一条\n- 同一条').length, 1)
  assert.deepEqual(checkedIdsOf({ publishCheckItems: 'a, b;c a' }), ['a', 'b', 'c'])
  const items = parseChecklist(markdown)
  const state = checklistState({ publishCheckItems: [items[0].id, items[2].id].join(',') }, items)
  assert.equal(state.done, 2)
  assert.equal(state.total, 4)
  assert.equal(state.ratio, '2/4')
  assert.equal(state.complete, false)
  const patch = checklistPatch(items, [items[1].id, 'not-in-list'])
  assert.equal(patch.publishCheck, '1/4')
  assert.equal(patch.publishCheckItems, items[1].id)
})

test('空清单是 missing，不是 0/0 全过', () => {
  const state = checklistState({}, [])
  assert.equal(state.total, 0)
  assert.equal(state.done, 0)
  assert.equal(state.ratio, '')
  assert.equal(state.complete, false)
  assert.equal(state.missing, true)
  assert.equal(checklistPatch([], []).publishCheck, '')
})

if (failures.length > 0) {
  console.error('\n' + failures.length + ' checklist test(s) failed')
  process.exitCode = 1
} else {
  console.log('\n' + pass + ' checklist tests passed')
}
