// 静态检查：client.js 里那类「只能靠看代码发现」的问题。
// 这些不跑被测代码，只扫源码 —— 但它们拦的正是线上已经出现过的事故：
// ① CopyRulesCard 的 useRef 写在 loading 早退之后，React #310，日志里崩了 26 次。
// ② 两个 CSS 变量名拼错，警告色整条丢失，界面上看不出来，只在代码里看得出。
// ③ PUSH_PROMPTS 定义了却没人调用的指令（推出去只有裸正文）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 别用 new URL().pathname：中文目录会被百分号编码，readFileSync 直接 ENOENT。
const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let pass = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    pass += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures.push(name)
    console.log('FAIL ' + name + '\n     ' + String(error?.message ?? error).split('\n')[0])
  }
}

// ── ① hook 顺序：早退的 return 之后不许再出现 hook ──
// 这条守卫曾经漏报过真事故：它把「缩进 <= 早退缩进」当成出了函数块，于是
//     if (openPath !== null) return h(...)
//     const rf = useRecordFilter(records)      ← 同缩进，被直接跳过
// 整类 bug 都没抓到（DataCard / ProductsCard / CampaignsCard 三张卡的详情页必崩）。
// 现在：① 同缩进的行也要检查；② 自定义 hook（useAsync 之类）也算；
// ③ 只认组件函数体顶层（缩进 6）的早退 —— 缩进 8 的是 useEffect 回调里的普通 return。
function hooksAfterEarlyReturn(source) {
  const rows = source.split('\n')
  // React.useXxx 和自定义 hook（useAsync / useRecordFilter …）都算。
  const isHook = (line) => /\buse[A-Z][A-Za-z0-9_]*\s*\(/.test(line)
  const bad = []
  let guard = null
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (indent === 6 && /^if \(.+\)[^{]*\breturn\b/.test(trimmed)) { guard = { at: i + 1 }; continue }
    if (guard === null) continue
    if (trimmed === '') continue
    if (indent <= 4) { guard = null; continue }
    if (indent === 6 && isHook(trimmed)) bad.push('client.js:' + (i + 1) + ' ' + trimmed.slice(0, 60) + '（早退在第 ' + guard.at + ' 行）')
  }
  return bad
}

test('no hook after an early return', () => {
  const bad = hooksAfterEarlyReturn(src)
  assert.deepEqual(bad, [], '早退之后还有 hook，会抛 React #310：\n' + bad.join('\n'))
})

test('hook 守卫本身能抓住回归样例', () => {
  // 拿真摔过的形状做自检：守卫自己退了等于没守。
  const broken = [
    '    function DataCard({ kind }) {',
    '      const [openPath, setOpenPath] = React.useState(null)',
    '      const list = useAsync(() => get("/x"), [])',
    '      if (openPath !== null) return h(NoteDetail, { kind })',
    '      const rf = useRecordFilter(list.data)',
    '      return h("div", null)',
    '    }',
  ].join('\n')
  assert.equal(hooksAfterEarlyReturn(broken).length, 1)

  // useEffect 回调里的 return 不该被当成组件早退。
  const ok = [
    '    function Card() {',
    '      React.useEffect(() => {',
    '        if (done) return',
    '        setCount(1)',
    '      }, [])',
    '      const rf = useRecordFilter([])',
    '      return h("div", null)',
    '    }',
  ].join('\n')
  assert.deepEqual(hooksAfterEarlyReturn(ok), [])
})

test('CopyRulesCard 的 activeSection state 排在 loading 早退之前', () => {
  const stateAt = src.indexOf("const [activeSection, setActiveSection] = React.useState('hard')")
  assert.ok(stateAt > 0, '找不到 activeSection —— 一屏三段布局被改掉了，用例要跟着重写')
  const guardAt = src.indexOf("h(Empty, null, t('loading'))", stateAt)
  assert.ok(guardAt > stateAt, 'activeSection 之后没有 loading 早退 —— 形状变了，用例要重写')
})

// ── ② CSS 变量白名单 ──
// 写错了浏览器不报错，只是静默丢弃整条声明。
// 这份名单以 F:\dsh\resources\app.asar 里真实定义过的 --dsw-alias-* 为准
// （用 `node -e` 把 asar 当 latin1 文本扫一遍就能列全），不是凭印象写的：
// 之前把 state-warn-primary 误写成 state-warning-primary，结果所有「未处理」类
// 胶囊整条 color/background 被丢弃 —— 颜色一直是灰的，代码看着却像是对的。
const KNOWN_TOKENS = new Set([
  'label-primary', 'label-secondary', 'label-tertiary', 'label-inverted',
  'label-primary-bluish', 'label-primary-dimmed', 'label-primary-inverted', 'label-caption',
  'label-dimmed', 'label-deep-diving',
  'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-base',
  'bg-overlay', 'bg-mask-1', 'bg-mask-2', 'bg-mask-3', 'bg-skeleton',
  'border-l1', 'border-l2', 'border-l3', 'border-l4', 'border-inverted',
  'brand-primary', 'brand-secondary', 'brand-text', 'brand-primary-invert',
  'link', 'font-mono',
  'interactive-bg-hover', 'interactive-bg-active', 'interactive-bg-hover-danger',
  'interactive-bg-hover-solid', 'interactive-bg-hover-accent',
  // 注意：真实 token 是 warn 不是 warning；success / error 则是全拼。
  'state-warn-primary', 'state-warn-secondary', 'state-warn-tertiary', 'state-warn-label',
  'state-success-primary', 'state-success-secondary', 'state-success-tertiary',
  'state-error-primary', 'state-error-secondary',
  'state-info-primary', 'state-business-primary', 'state-idle-primary', 'state-done-primary',
  'button-primary-fill', 'button-primary-hover', 'button-ghost-active-fill',
  'button-ghost-active-border', 'button-ghost-active-hover',
  'scrollbar-bg-l1', 'scrollbar-bg-l2', 'scrollbar-hover-l1', 'scrollbar-hover-l2',
  'toast-bg', 'toast-label', 'tooltip-bg', 'tooltip-key-bg',
  'markdown-citation', 'markdown-code-block', 'markdown-inline-code', 'markdown-tag',
  'menu-icon', 'settings-card-fill', 'settings-card-stroke',
])
test('every --dsw-alias-* reference is a real token', () => {
  const found = new Set()
  const re = /--dsw-alias-([a-z0-9-]+)/g
  let match = re.exec(src)
  while (match !== null) {
    found.add(match[1])
    match = re.exec(src)
  }
  const unknown = [...found].filter((name) => !KNOWN_TOKENS.has(name)).sort()
  assert.deepEqual(unknown, [], '用了不存在的 token（整条声明会被丢弃）：' + unknown.join(', '))
})

test('no state-warning / state-danger typo', () => {
  // 真实主题里只有 state-warn-primary（warn 不是 warning）、state-error-primary（没有 danger）。
  assert.equal(src.includes('--dsw-alias-state-warning-primary'), false, '主题里没有 state-warning-primary，应为 state-warn-primary')
  assert.equal(src.includes('--dsw-alias-state-danger-primary'), false, 'state-danger-primary 应为 state-error-primary')
})

// ── ③ PUSH_PROMPTS 每个 key 都要有调用点 ──
function promptBlock() {
  const start = src.indexOf('const PUSH_PROMPTS = {')
  assert.ok(start > 0, '找不到 PUSH_PROMPTS')
  return src.slice(start, start + 2400)
}

test('every PUSH_PROMPTS key has a call site', () => {
  const keys = [...promptBlock().matchAll(/^\s{6}([A-Za-z]+):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 4, 'PUSH_PROMPTS 没解析出来，keys=' + keys.length)
  // `topic` 走选题详情的单篇推送，`note` 由笔记详情底部按钮兜底，都没有字面量调用点。
  const skip = new Set(['topic', 'note'])
  const missing = keys.filter((key) => !skip.has(key) && !src.includes("promptKey: '" + key + "'"))
  assert.deepEqual(missing, [], '定义了却没人用的指令（推出去只有裸正文）：' + missing.join(', '))
})

test('pushListToAgent 不编造 .md 路径', () => {
  assert.equal(src.includes("pushToAgent(title + '.md'"), false, '汇总推送不该造一个不存在的 标题.md 路径')
})

test('PUSH_PROMPTS 里不出现不存在的动作名 write-back', () => {
  assert.equal(promptBlock().includes('write-back'), false, 'write-back 不是 growth_vault 的动作，真名是 write / replaceSection / setFront')
})

// ── ④ TDZ：组件体顶层先用了后面才声明的 const ──
// 真实事故（2026-11-07）：TopicsCard 里
//     if (openPath !== null) return h(TopicDetail, { ..., tagOptions, ... })
// 写在了 `const tagOptions = []` 之前。const 还在暂时性死区（TDZ）里，
// 一打开拆解笔记就抛 "Cannot access 'tagOptions' before initialization"，
// 整张卡片被 CardBoundary 拦下，用户只看到「这张卡片没能渲染出来」。
//
// 规则：同一个组件函数体内，缩进 6 的顶层语句里，出现了本函数后面才 const/let 的名字。
// 排除两种情况：
//   ① 注释行（注释里提到变量名不算引用）；
//   ② 同一行里位于 '=>' 之后的用法——那是回调体，声明之后才执行，不构成 TDZ。
function tdzUsesBeforeDeclaration(source) {
  const rows = source.split('\n')
  const bad = []
  for (let i = 0; i < rows.length; i++) {
    if (!/^ {4}function [A-Za-z0-9_$]*\s*\(/.test(rows[i])) continue
    // 函数体结束：下一个缩进 <= 4 的非空行。
    let end = rows.length
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].trim() === '') continue
      if (rows[j].length - rows[j].trimStart().length <= 4) { end = j; break }
    }
    // 组件体顶层的 const/let 声明（缩进 6）。
    const decl = new Map()
    for (let j = i + 1; j < end; j++) {
      const m = /^ {6}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(rows[j])
      if (m !== null && !decl.has(m[1])) decl.set(m[1], j)
    }
    for (const [name, at] of decl) {
      const re = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])')
      for (let j = i + 1; j < at; j++) {
        const line = rows[j]
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
        // 缩进 6 = 组件体顶层语句；嵌套块/回调体（更深缩进）不在本守卫范围。
        if (line.length - line.trimStart().length !== 6) continue
        const cut = line.indexOf('=>')
        const immediate = cut === -1 ? line : line.slice(0, cut)
        if (!re.test(immediate)) continue
        bad.push('client.js:' + (j + 1) + ' 在声明之前用了 ' + name + '（声明在第 ' + (at + 1) + ' 行）')
      }
    }
    i = end - 1
  }
  return bad
}

test('no const used before its declaration (TDZ)', () => {
  const bad = tdzUsesBeforeDeclaration(src)
  assert.deepEqual(bad, [], '先用了后面才声明的 const，会撞 TDZ 直接崩卡片：\n' + bad.join('\n'))
})

test('TDZ 守卫本身能抓住回归样例', () => {
  const broken = [
    '    function TopicsCard() {',
    '      const [openPath, setOpenPath] = React.useState(null)',
    '      if (openPath !== null) return h(TopicDetail, { tagOptions })',
    '      const tagOptions = []',
    '      return h("div", null)',
    '    }',
  ].join('\n')
  assert.equal(tdzUsesBeforeDeclaration(broken).length, 1)

  // 声明在前的正常写法不该报。
  const ok = [
    '    function Card() {',
    '      const tagOptions = []',
    '      if (openPath !== null) return h(TopicDetail, { tagOptions })',
    '      return h("div", null)',
    '    }',
  ].join('\n')
  assert.deepEqual(tdzUsesBeforeDeclaration(ok), [])

  // 回调体里的引用是延迟执行的，不算 TDZ。
  const deferred = [
    '    function Card() {',
    '      const go = () => laterConst',
    '      const laterConst = 1',
    '      return h("div", null, go)',
    '    }',
  ].join('\n')
  assert.deepEqual(tdzUsesBeforeDeclaration(deferred), [])
})

// ── ⑤ 两边手抄的表必须一致 ──
// 客户端不能 import 服务端的模块（每个包只认一个 exports["./client"]，加载器不解析相对路径），
// 所以状态机和平台表在 client.js 里各有一份副本。副本一定会漂移 —— 改了 lib 忘了改客户端，
// 界面上就会允许一个后端必然拒绝的动作。这条测试把两份钉在一起。
function listItemsOf(text, marker) {
  const start = text.indexOf(marker)
  assert.ok(start >= 0, '找不到 ' + marker)
  const open = text.indexOf('[', start)
  const close = text.indexOf(']', open)
  assert.ok(open >= 0 && close > open, marker + ' 不是数组字面量')
  return text.slice(open + 1, close)
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '')
}

function statusMapOf(text, marker) {
  const start = text.indexOf(marker)
  assert.ok(start >= 0, '找不到 ' + marker)
  const out = {}
  for (const line of text.slice(start).split('\n')) {
    // 收尾是单独一行的大括号（缩进不定）：不能靠 indexOf('\n}')，客户端那份缩进 4 格。
    if (line.trim() === '}') break
    const match = line.match(/^\s*([^\s:[][^:]*):\s*\[(.*)\]/)
    if (match === null) continue
    const items = match[2].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter((item) => item !== '')
    out[match[1].trim()] = items
  }
  return out
}

test('状态机：client.js 的 VARIANT_NEXT 与 lib/domain.js 的 VARIANT_TRANSITIONS 一致', () => {
  const domainSrc = fs.readFileSync(path.join(here, '..', 'lib', 'domain.js'), 'utf8')
  const server = statusMapOf(domainSrc, 'export const VARIANT_TRANSITIONS = {')
  const client = statusMapOf(src, 'const VARIANT_NEXT = {')
  assert.ok(Object.keys(server).length > 0, '服务端状态机解析为空')
  assert.deepEqual(client, server)
})

test('平台表：client.js 的 PLATFORMS 与 lib/platforms.js 的 PLATFORMS 一致', () => {
  const platformSrc = fs.readFileSync(path.join(here, '..', 'lib', 'platforms.js'), 'utf8')
  const server = listItemsOf(platformSrc, 'export const PLATFORMS = [')
  const client = listItemsOf(src, 'const PLATFORMS = [')
  assert.ok(server.length > 0, '服务端平台表解析为空')
  assert.deepEqual(client, server)
})

test('关卡片只有一个出口：setCardId(null) 只允许出现在 leaveCard 里', () => {
  assert.ok(src.includes('const leaveCard = (next) => {'), '找不到 leaveCard 出口函数')
  const hits = src.split('\n')
    .map((line, no) => ({ line, no: no + 1 }))
    .filter((row) => row.line.includes('setCardId(null)') && !row.line.trim().startsWith('//'))
  assert.equal(hits.length, 1, 'setCardId(null) 出现了 ' + hits.length + ' 次（只允许 leaveCard 内那一次）：\n'
    + hits.map((row) => row.no + ': ' + row.line.trim()).join('\n'))
})

console.log('\n' + pass + ' passed, ' + failures.length + ' failed')
process.exitCode = failures.length === 0 ? 0 : 1
