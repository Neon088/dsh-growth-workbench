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
  let returnBlock = null
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (returnBlock !== null) {
      if (/\breturn\b/.test(trimmed)) returnBlock.returnAt = i + 1
      if (indent === 6 && trimmed === '}') {
        if (returnBlock.returnAt > 0) guard = { at: returnBlock.returnAt }
        returnBlock = null
      }
      continue
    }
    if (indent === 6 && /^if \(.+\)\s*\{\s*$/.test(trimmed)) {
      returnBlock = { at: i + 1, returnAt: 0 }
      continue
    }
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
  assert.deepEqual(bad, [], '早退之后还有 hook，会抛 React #310：' + JSON.stringify(bad))
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

  const brokenBlock = [
    '    function AccountsCard({ openPath }) {',
    '      const list = useAsync(() => get("/x"), [])',
    '      if (openPath !== null) {',
    '        return h(NoteDetail, {',
    '          path: openPath,',
    '        })',
    '      }',
    '      useObjectDraftGuard({ draft: 1 }, false)',
    '      return h("div", null)',
    '    }',
  ].join('\n')
  assert.equal(hooksAfterEarlyReturn(brokenBlock).length, 1)

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
        // 字符串里的路由 / 文案不是标识符读取；模板插值仍参与检查。
        const immediate = (cut === -1 ? line : line.slice(0, cut)).replace(/(["'])(?:\\.|(?!\1).)*?\1/g, '')
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

  const quotedRoutes = [
    '    function Card() {',
    "      const request = '/accounts/list?limit=300'",
    '      const accounts = []',
    '      return accounts',
    '    }',
  ].join('\n')
  assert.deepEqual(tdzUsesBeforeDeclaration(quotedRoutes), [])
  const interpolation = [
    '    function Card() {',
    '      const label = `items: ${tagOptions}`',
    '      const tagOptions = []',
    '    }',
  ].join('\n')
  assert.equal(tdzUsesBeforeDeclaration(interpolation).length, 1)
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

function actualFunction(name) {
  const start = src.indexOf('    function ' + name + '('), end = src.indexOf('\n    }', start)
  assert.ok(start >= 0 && end > start, 'actual ' + name + ' function exists')
  return src.slice(start, end + 6)
}
test('host client remains one module with no relative imports and 14 public cards', () => {
  assert.doesNotMatch(src, /(?:import\s+[\s\S]*?from\s*|import\s*\()\s*['"]\.{1,2}\//)
  const stages = src.slice(src.indexOf('    const CARD_STAGE = {'), src.indexOf('\n    }', src.indexOf('    const CARD_STAGE = {')))
  const ids = [...stages.matchAll(/(?:^|[,\n])\s*([a-z]\w*):/g)].map((match) => match[1])
  assert.deepEqual(ids.sort(), ['accounts', 'ideas', 'topics', 'products', 'studio', 'calendar', 'campaigns', 'pending', 'feedback', 'contentdata', 'data', 'sop', 'glossary', 'copyrules'].sort())
  const workspaces = src.slice(src.indexOf('    const WORKSPACES = ['), src.indexOf('\n    ]', src.indexOf('    const WORKSPACES = [')))
  assert.deepEqual([...workspaces.matchAll(/id: '([^']+)'/g)].map((match) => match[1]), ['ops', 'ecom', 'mkt', 'common'])
})
test('real Topics and Studio filters use paged q, not a second local text pass', () => {
  for (const name of ['TopicsCard', 'StudioCard']) {
    const body = actualFunction(name)
    assert.match(body, /useRecordFilter\(list\.data\?\.records \?\? \[\], list\)/)
    assert.doesNotMatch(body, /matchRecord\([^\n]+filter/)
  }
})
test('real six-column Studio header uses stable sort state and native sort components', () => {
  const body = actualFunction('StudioCard')
  assert.match(body, /sortCollectionRows/)
  assert.equal((body.match(/h\(CollectionSortHead,/g) ?? []).length, 1, 'one real six-column map renders the header')
  assert.match(body, /\['选题', '平台', '状态', '标签', '版本', '操作'\]\.map/)
  assert.match(body, /\['title', 'platform', 'status', 'tags', 'versions', null\]\[index\]/)
  const header = actualFunction('CollectionSortHead')
  assert.match(header, /aria-sort/)
  assert.match(header, /h\('button'/)
})
test('Calendar measures the real header lifetime, never a per-commit synchronous setter', () => {
  const body = actualFunction('CalendarCard')
  assert.match(body, /useMeasuredBlockHeight\(40\)/)
  assert.match(body, /ref: calHeadRef/)
  assert.doesNotMatch(body, /setCalHeadH|useLayoutEffect/)
  assert.match(body, /showAdd, setShowAdd\] = React\.useState\(false\)/)
  assert.doesNotMatch(src, /\.dsh-gw-cal-item\{[^}]*color:transparent!important/)
})
test('Pending retains eleven real columns, fourteen metric fields, and local sticky scrolling', () => {
  const body = actualFunction('PendingCard')
  const header = body.slice(body.indexOf("h('thead'"), body.indexOf("h('tbody'"))
  assert.match(header, /\['平台', '账号', '选题', '日期', '任务', '播放\/阅读', '赞\/收藏', '评论', '转发', '链接', '操作'\]\.map/)
  assert.match(body, /pendingWidths\.map/)
  assert.match(body, /\[64, 88, 176, 88, 76, 70, 70, 70, 70, 68, 88\]/)
  assert.match(body, /colSpan: 11/)
  assert.match(body, /reviewTask/)
  assert.match(src, /\.dsh-gw-tablebox\.dsh-gw-pending-box\{[^}]*overflow:auto/)
  assert.match(src, /\.dsh-gw-pending-table thead th\{[^}]*position:sticky;top:0/)
  assert.match(src, /td:not\(\[colspan\]\):nth-child\(-n\+3\)\{[^}]*position:sticky/)
  assert.match(src, /font-variant-numeric:tabular-nums/)
  for (const name of ['date', 'views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber']) assert.ok(body.includes(name), name)
})
test('creative palette uses actual host aliases; warning and typography stay distinct', () => {
  assert.match(src, /--gw-warm:light-dark\(#98672D,#DDB781\)/)
  assert.match(src, /--tone-attention:var\(--dsw-alias-state-warn-primary\)/)
  assert.match(actualFunction('installHostAccent'), /getComputedStyle\(probe\)/)
  assert.match(actualFunction('Panel'), /installHostAccent\(paletteRef\.current\)/)
  assert.match(src, /\.dsh-gw-note-preview,\.dsh-gw-note-editor\{font-size:14px;line-height:1\.55/)
  assert.match(src, /min-height:28px;height:28px;white-space:nowrap/)
})
test('Studio owns wide-table scrolling instead of expanding the page', () => {
  assert.match(actualFunction('StudioCard'), /dsh-gw-tablebox dsh-gw-topiclist-box/)
  assert.match(src, /\.dsh-gw-tablebox\.dsh-gw-topiclist-box(?:,[^{]+)?\{[^}]*overflow-x:auto;overflow-y:hidden/)
  assert.match(src, /\.dsh-gw-topiclist-box \.dsh-gw-topiclist thead th\{top:0\}/)
})
test('real version controls have whole-row selection, internal account search, separated native menu danger', () => {
  const body = actualFunction('PlatformVariantsPanel')
  assert.match(body, /data-current.*activeScriptId/)
  assert.match(body, /h\(ActionMenu,/)
  assert.match(actualFunction('AccountPicker'), /dsh-gw-account-candidates[\s\S]*h\(ListPager,/)
  const menu = actualFunction('ActionMenu')
  assert.match(menu, /aria-haspopup.*menu/)
  assert.match(menu, /role: 'menuitem'/)
  assert.match(menu, /data-separated/)
})
test('optional crumb callbacks never wrap conditional React hooks', () => {
  assert.doesNotMatch(src, /if\s*\(onCrumb\)\s*React\.use(?:Effect|LayoutEffect)/)
})
test('campaign detail renders one metrics editor and one note detail with stable distinct keys', () => {
  const body = actualFunction('CampaignsCard')
  assert.match(body, /if \(openPath !== null\) return h\('div', \{ key: openPath \}/)
  assert.match(body, /key: openPath \+ ':metrics'/)
  assert.match(body, /key: openPath \+ ':detail'/)
})
test('ideas linked action reports the real outcome kind instead of always offering 拆解', () => {
  const body = actualFunction('IdeasCard')
  assert.match(body, /outcomeKind = outcomeRecord\?\.front\?\.type === '选题' \? '选题' : '拆解'/)
  assert.match(body, /entry\.outcome \? '打开' \+ outcomeKind : statusOf\(entry\) === '已用' \? '已用' : '拆解'/)
  assert.match(body, /statusOf\(entry\) === '已用'/)
})
test('ideas card keeps one card-local search and a plain 灵感集 heading', () => {
  const body = actualFunction('IdeasCard')
  assert.doesNotMatch(body, /h\(ListPager, \{ list: topicList/)
  assert.doesNotMatch(body, /h\(Fold, \{ title: '灵感'/)
  assert.match(body, /className: 'dsh-gw-ideas-title'/)
  assert.match(body, /'灵感集'/)
})
test('account picker carries full-vault candidate records into its select', () => {
  const body = actualFunction('AccountPicker')
  assert.match(body, /selected\.current = record/)
  assert.match(body, /pickerOptions = selected\.current && !options\.some/)
})
test('calendar resolves legacy name-only account rows to their account record', () => {
  const helper = actualFunction('resolveCalendarAccount')
  assert.match(helper, /entry\?\.account/)
  assert.match(helper, /entry\?\.accountId/)
  assert.match(helper, /normalizePlatform/)
  const body = actualFunction('CalendarCard')
  assert.match(body, /resolveCalendarAccount\(entry, allAccounts\)/)
  assert.match(body, /entryAccountOptions/)
})
test('card filters search their own collection and do not expose a duplicate pager search', () => {
  for (const name of ['AccountsCard', 'ProductsCard', 'CampaignsCard']) assert.match(actualFunction(name), /const rf = useRecordFilter\(records, list\)/, name)
  const pager = actualFunction('ListPager')
  assert.doesNotMatch(pager, /搜索全库/)
  assert.match(pager, /搜索' \+ scopeLabel \+ '（含正文）/)
})
test('feedback full-vault search exposes clickable source results for create and edit', () => {
  const body = actualFunction('FeedbackCard')
  assert.match(body, /FeedbackSourceResults, \{ list: sourceTopicList/)
  assert.match(body, /FeedbackSourceResults, \{ list: sourceProductList/)
  assert.match(body, /function pickSource\(value\)[\s\S]*saveEditSilent\(next\)/)
  const helper = actualFunction('FeedbackSourceResults')
  assert.match(helper, /list\.query/)
  assert.match(helper, /records\.slice\(0, 12\)/)
})
test('account rows and product rollups have bounded identity layout and stable platform badges', () => {
  assert.match(src, /\.dsh-gw-account-row\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-row-main\{[^}]*grid-template-columns:90px minmax\(0,1fr\)[^}]*column-gap:8px/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-row-name\{[^}]*grid-column:1[^}]*width:100%[^}]*max-width:100%[^}]*background:color-mix\(in srgb,var\(--gw-accent\) 7%,var\(--gw-paper\)\)[^}]*font-size:16px[^}]*font-weight:700/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-row-name-text\{[^}]*text-overflow:ellipsis/)
  const accountCard = actualFunction('AccountsCard')
  assert.match(accountCard, /className: 'dsh-gw-row-name' \}, h\('span', \{ className: 'dsh-gw-row-name-text' \}/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-account-flags\{[^}]*grid-column:2/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-account-meta-lead\{[^}]*grid-column:1/)
  assert.match(src, /\.dsh-gw-account-row \.dsh-gw-row-meta\{[^}]*grid-column:2/)
  assert.match(src, /\.dsh-gw-platform-badge\{[^}]*white-space:nowrap/)
  assert.match(src, /\.dsh-gw-rollup-topic\{[^}]*text-overflow:ellipsis/)
})
test('workbench tab fills its sidebar without scaling the canvas', () => {
  assert.doesNotMatch(src, /dsh-gw-fit|FitSidebarStage|GW_FIT_WIDTH/)
  const tab = actualFunction('TabBody')
  assert.match(tab, /h\('div', \{ className: 'dsh-gw-pane' \}, h\(Panel, \{ onClose: null \}\)\)/)
})
test('sticky top rows keep square corners in every card', () => {
  assert.match(src, /\.dsh-gw-panel:has\(> \.dsh-gw-body > \.dsh-gw-card-crumb\),\.dsh-gw-panel:has\(\.dsh-gw-body \.dsh-gw-card-crumb\)[^\{]*\{border-top-left-radius:0!important;border-top-right-radius:0!important\}/)
  assert.match(src, /\.dsh-gw-body>\.dsh-gw-card-crumb,\.dsh-gw-card-top,\.dsh-gw-rules-sticky,\.dsh-gw-note-sectionhead,\.dsh-gw-cal-week:first-child\{border-radius:0!important\}/)
})
test('all list tables use the shared local-scroll and resize contract', () => {
  for (const name of ['StudioCard', 'UpcomingQueue', 'ProductsCard', 'CampaignMetricsPanel']) {
    const body = actualFunction(name)
    assert.match(body, /dsh-gw-adjustable-box/, name + ' local scroll wrapper')
    assert.match(body, /dsh-gw-adjustable-table/, name + ' shared table class')
    assert.match(body, /dsh-gw-col-grip/, name + ' visible resize grip')
  }
  const pending = actualFunction('PendingCard')
  assert.match(pending, /pixelColResizeStart\(pendingWidths, setPendingWidths/)
  assert.match(src, /\.dsh-gw-rules-scroll>\.dsh-gw-rules-frame\{overflow:visible;min-width:680px\}/)
  assert.match(src, /\.dsh-gw-rules thead th\{[^}]*position:sticky;top:0/)
})

test('account picker keeps a readable select width and wraps the create button', () => {
  assert.match(src, /\.dsh-gw-account-picker>span:first-child\{flex-wrap:wrap\}/)
  assert.match(src, /\.dsh-gw-account-picker select\{[^}]*height:32px;padding:4px 24px 4px 8px;line-height:1\.35;[^}]*flex:1 1 160px;min-width:140px;max-width:100%;width:auto;text-overflow:ellipsis/)
  const body = actualFunction('AccountPicker')
  assert.match(body, /flexWrap: 'wrap'/)
  assert.match(body, /flex: '1 1 160px', minWidth: 140, maxWidth: '100%', width: 'auto'/)
})

test('upcoming schedule table can shrink below the generic adjustable minimum', () => {
  assert.match(src, /\.dsh-gw-table\.dsh-gw-upcoming\{min-width:0;table-layout:fixed;width:100%\}/)
  assert.match(actualFunction('UpcomingQueue'), /dsh-gw-table dsh-gw-upcoming dsh-gw-adjustable-table/)
})

test('upcoming schedule list paginates at ten rows with explicit pager controls', () => {
  const body = actualFunction('UpcomingQueue')
  assert.match(body, /UPCOMING_PAGE_SIZE = 10/)
  assert.match(body, /const pageItems = items\.slice\(/)
  assert.match(body, /pageItems\.map\(/)
  assert.match(body, /dsh-gw-upcoming-pager/)
  assert.match(body, /'上一页'/)
  assert.match(body, /'下一页'/)
  assert.match(body, /'第 ' \+ currentPage \+ ' \/ ' \+ pageCount \+ ' 页'/)
})

test('glossary keeps delete inside the note cell instead of an empty action column', () => {
  const body = actualFunction('GlossaryCard')
  assert.doesNotMatch(body, /c-act/)
  assert.doesNotMatch(body, /key: 'act'/)
  assert.match(body, /className: 'dsh-gw-gloss-note'/)
  assert.match(body, /className: 'dsh-gw-ibtn dsh-gw-gloss-del'/)
  assert.match(src, /\.dsh-gw-gloss-table td\.dsh-gw-gloss-note\{position:relative;padding-right:30px\}/)
  assert.match(src, /\.dsh-gw-gloss-table tr:hover \.dsh-gw-gloss-del/)
})

test('calendar controls wrap and the only schedule action is a direct delete button', () => {
  assert.match(src, /\.dsh-gw-cal-row-links\{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px;min-width:0;font-size:12px\}/)
  assert.match(src, /\.dsh-gw-cal-row-links>select,\.dsh-gw-cal-row-links>\.dsh-gw-field\{flex:1 1 160px;max-width:100%;min-width:140px;margin:4px\}/)
  assert.match(src, /\.dsh-gw-cal-row-links select\{height:32px;padding:4px 24px 4px 8px;line-height:1\.35;font-size:12\.5px;box-sizing:border-box\}/)
  const calendar = actualFunction('CalendarCard')
  assert.match(calendar, /className: 'dsh-gw-row-act', 'data-tone': 'danger'/)
  assert.match(calendar, /'删除排期'/)
  assert.doesNotMatch(calendar, /排期更多操作/)
  assert.doesNotMatch(calendar, /maxWidth: 150/)
})

test('platform multi-select flips its menu upward near a scroll boundary', () => {
  assert.match(src, /\.dsh-gw-platmulti-drop\.is-up\{top:auto;bottom:calc\(100% \+ 3px\)\}/)
  const body = actualFunction('PlatformMultiInput')
  assert.match(body, /const \[dropUp, setDropUp\] = React\.useState\(false\)/)
  assert.match(body, /const chooseDropDirection = \(\) =>/)
  assert.match(body, /dsh-gw-platmulti-drop' \+ \(dropUp \? ' is-up' : ''\)/)
})

test('topic template no longer duplicates the three frontmatter fields in 选题卡', () => {
  const indexSource = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  assert.match(indexSource, /选题卡三件套只挂 frontmatter，正文不再重复同一组值/)
  assert.doesNotMatch(indexSource, /## 选题卡\\n\\n- 目标人群/)
  const body = actualFunction('TopicDetail')
  assert.match(src, /function stripDuplicateTopicCard/)
  assert.match(body, /const bodyForView = React\.useMemo/)
})

test('closing the platform-version fold also closes the active script editor', () => {
  const body = actualFunction('PlatformVariantsPanel')
  assert.match(body, /next === false && String\(activeScriptId \?\? ''\) !== ''/)
  assert.match(body, /if \(onCloseScript\(\) === false\) \{ setPanelOpen\(true\); return \}/)
  const topic = actualFunction('TopicDetail')
  assert.match(topic, /function closeVariantScript\(options = null\)/)
  assert.match(topic, /if \(doc === null && !scriptLoading\) return true/)
  assert.match(topic, /if \(options\?\.discardConfirmed !== true && !allowLeave\([^)]*\)\) return false/)
  assert.match(topic, /return true/)
})

test('new topic form removes account creation/search and lists topic/product matches', () => {
  const calendar = actualFunction('CalendarCard')
  assert.doesNotMatch(calendar, /NewAccountFields/)
  assert.doesNotMatch(calendar, /list: accountList, onCreated/)
  assert.doesNotMatch(calendar, /dsh-gw-account-candidates/)
  assert.match(calendar, /topicSearchRecords/)
  assert.match(calendar, /productSearchRecords/)
  assert.match(calendar, /className: 'dsh-gw-cal-candidates'/)
  assert.match(calendar, /'先建选题'/)
  assert.match(calendar, /'先建平台版本'/)
  assert.match(src, /\.dsh-gw-cal-party\{[^}]*repeat\(auto-fit,minmax\(190px,1fr\)\)/)
  const picker = actualFunction('AccountPicker')
  assert.match(picker, /'暂空'/)
  assert.doesNotMatch(picker, /'（不指定）'/)
  for (const name of ['StudioCard', 'PlatformVariantsPanel', 'TopicDetail', 'CalendarCard']) {
    const body = actualFunction(name)
    assert.doesNotMatch(body, /list: accountList|NewAccountFields/)
    assert.match(body, /hideCreate: true/)
  }
  // Every account picker lists the whole account archive, not just the current platform.
  assert.match(actualFunction('StudioCard'), /options: accounts\b/)
  assert.match(actualFunction('PlatformVariantsPanel'), /options: accountRecords\b/)
  assert.match(actualFunction('TopicDetail'), /const options = accountRecords\b/)
  assert.match(calendar, /options: allAccounts\b/)
  assert.match(calendar, /const entryAccountOptions = allAccounts\b/)
})

test('new-topic and new-platform creation use separate bordered cards', () => {
  const studio = actualFunction('StudioCard')
  assert.match(studio, /const newTopicForm = h\(React\.Fragment/)
  assert.match(studio, /title: '新建选题', className: 'dsh-gw-create-card'/)
  const topic = actualFunction('TopicDetail')
  assert.match(topic, /newTopicForm = null/)
  assert.match(topic, /newTopicForm,/)
  const variants = actualFunction('PlatformVariantsPanel')
  assert.match(variants, /newTopicForm = null/)
  assert.match(variants, /title: '新建选题'/)
  assert.match(variants, /className: 'dsh-gw-create-card dsh-gw-platform-create'/)
  assert.match(variants, /className: 'dsh-gw-create-card-head' \}, '新建平台版本'/)
  assert.match(src, /\.dsh-gw-create-card,\.dsh-gw-fold\.dsh-gw-create-card\{[^}]*border:1px solid/)
})

test('version script heading shares the sticky action bar', () => {
  const markdown = actualFunction('LiveMarkdown')
  assert.match(markdown, /hideFirstHeading/)
  assert.match(markdown, /blocks\[0\]\?\.type === 'h'/)
  const topic = actualFunction('TopicDetail')
  assert.match(topic, /className: 'dsh-gw-note-title' \}, '版本脚本'/)
  assert.match(topic, /hideFirstHeading: doc === null \? undefined : '版本脚本'/)
  assert.match(src, /\.dsh-gw-note-title\{[^}]*font-size:var\(--gw-fz-2,13px\)[^}]*font-weight:600/)
})

test('calendar PUT preflights a version advance before it writes the table', () => {
  const index = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  const putAt = index.indexOf("route === 'calendar' && method === 'PUT'")
  assert.ok(putAt !== -1, 'PUT calendar route not found')
  const resolveAt = index.indexOf('resolveCalendarAdvance', putAt)
  const updateAt = index.indexOf('cal.table.update', putAt)
  const applyAt = index.indexOf('applyCalendarAdvance', putAt)
  assert.ok(resolveAt > putAt, 'resolve not inside calendar PUT')
  assert.ok(updateAt > resolveAt, 'calendar table is written before resolve (must not)')
  assert.ok(applyAt > updateAt, 'version advance not ordered after the calendar write')
  assert.match(index.slice(putAt, updateAt), /blocking === true/, 'blocking advance must refuse before the write')
})
test('the swallowing calendar-advance helper is gone', () => {
  const index = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  assert.doesNotMatch(index, /function\s+advanceVariantForCalendar\b/, 'old helper returned ok:false instead of failing')
  assert.match(index, /function\s+resolveCalendarAdvance\b/)
  assert.match(index, /function\s+applyCalendarAdvance\b/)
  assert.match(index, /function\s+syncCalendarStatusForVariant\b/, 'version transition must project onto the calendar row')
  assert.match(index, /CALENDAR_STATUS_RANK/)
})
test('a calendar row carries one platform and a fan-out spreads platforms', () => {
  const index = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  assert.match(index, /日历一行只能放一个平台/)
  assert.match(index, /assertSinglePlatformCell\(body\?\.platform\)/, 'POST /calendar not guarded')
  assert.match(index, /assertSinglePlatformCell\(next\.platform/)
  assert.match(index, /normalizePlatform, platformOptions, splitPlatforms/)
})
test('domain: one platform version = one platform; gate preflights without writing', () => {
  const domain = fs.readFileSync(path.join(here, '..', 'lib', 'domain.js'), 'utf8')
  assert.match(domain, /一个平台版本只能对应一个平台/)
  assert.match(domain, /function\s+preflightSteps\b/)
  assert.doesNotMatch(domain, /clean\(riskLevel,20\)==='高' && clean\(publishCheck,40\)!=='7\/7'/, '7/7 hard gate must be gone')
  assert.match(domain, /但没找到这份清单/)
})
test('calendar client sends multi-platform drafts through one fanout call', () => {
  const calendar = actualFunction('CalendarCard')
  assert.match(calendar, /draftPlatformList/)
  assert.match(calendar, /'\/calendar\/fanout'/, 'multi-platform scheduling must call the fanout endpoint')
  assert.match(calendar, /platforms\.length > 1/)
  assert.match(calendar, /names\.length !== 1/, 'row platform edit must stay single-platform')
  assert.match(calendar, /PlatformInput, \{\s*value: platformEdit\.value/)
})
test('platform versions show a side-by-side comparison with completion and duration', () => {
  const body = actualFunction('PlatformVariantsPanel')
  assert.match(body, /dsh-gw-vcompare/)
  assert.match(body, /formatPercent\(metric\?\.completion\)/)
  assert.match(body, /formatDuration\(metric\?\.avgDuration\)/)
})
test('platform-version checklist is per-version and missing SOP is explicit', () => {
  const body = actualFunction('PlatformVariantsPanel')
  // 勾选状态曾写成面板级 useState(() => readCheckSelection(variant?.front))：
  // 那个 variant 只有在 row(variant) 里才有，面板首屏直接 ReferenceError。
  assert.doesNotMatch(body, /selectedCheckIds/, 'checklist selection must not be panel-level state')
  assert.match(body, /const toggleCheck = async \(variant, id, on\)/)
  assert.match(body, /readCheckSelection\(variant\?\.front\)/)
  assert.match(body, /toggleCheck\(variant, String\(item\.id\)/)
  // 清单缺失时 status 必须落到 missing；全写成 done 会让「没找到清单」永远不显示。
  assert.match(body, /status: missing \? 'missing' : 'done'/)
})
test('ledger groups by platform variant and flags missing source/caliber', () => {
  const body = actualFunction('LedgerTable')
  assert.match(body, /variantId !== '' \? 'v:' \+ variantId/)
  assert.match(body, /dsh-gw-ledger-miss/)
  assert.match(body, /⚠ 未填/)
})
test('pending card closes a review against a concrete metric snapshot', () => {
  const body = actualFunction('PendingCard')
  assert.match(body, /closeItem/)
  assert.match(body, /normalizeStatus\(variant\.status\) === '待回填'/)
  assert.match(body, /\/close-review'/)
  assert.match(body, /metricId: String\(row\.metricId \|\| row\.id\)/)
})
test('idea promote form never falls back to a deconstruction note', () => {
  const body = actualFunction('IdeasCard')
  const submit = body.slice(body.indexOf('async function submitPromote'), body.indexOf('async function makeTopic'))
  assert.match(submit, /post\('\/ideas\/promote'/, 'submitPromote must call the promote endpoint')
  assert.match(submit, /type: '选题'/, 'submitPromote must explicitly create a topic')
  assert.doesNotMatch(submit, /type: '拆解'/, 'the inline → 选题 form must not create a deconstruction')
  assert.match(body, /建一篇自己的选题/)
})
test('calendar stores GMV and conversion as structured fields', () => {
  const body = actualFunction('CalendarCard')
  assert.match(body, /label: 'GMV'/)
  assert.match(body, /label: '转化率（%）'/)
  assert.match(body, /saveMetric\(entry, 'gmv'/)
  assert.match(body, /saveMetric\(entry, 'conv'/)
  assert.match(body, /gmv: draft\.gmv, conv: draft\.conv/, 'fanout must carry both metrics')
})
test('feedback card has a real promote-to-topic action', () => {
  const body = actualFunction('FeedbackCard')
  assert.match(body, /post\('\/feedback\/promote'/, 'feedback card must call the promote endpoint')
  assert.match(body, /updated === false/, 'partial write must not be presented as full success')
  assert.match(body, /openCard\('studio'/, 'successful promotion should open the new topic')
})
test('topic detail can review against rules and jump to the release SOP', () => {
  const body = actualFunction('TopicDetail')
  assert.match(body, /promptKey: 'copyrules'/, 'review button must use the copyrules prompt')
  assert.match(body, /get\('\/v2\/checklist'\)/, 'SOP button must resolve the real checklist path')
  assert.match(body, /openCard\('sop', \{ path: target \}\)/, 'SOP button must open the checklist note directly')
  assert.match(body, /按规则审稿/)
  assert.match(body, /打开发布 SOP/)
})
test('SOP card honors a requested note path', () => {
  const body = actualFunction('SopCard')
  assert.match(body, /function SopCard\(\{ notify, onCrumb, crumb, closeTicket, preset \}\)/)
  assert.match(body, /preset\.path \?\? preset\.note/)
  assert.match(body, /setActivePath\(target\)/)
})
console.log('\n' + pass + ' passed, ' + failures.length + ' failed')
process.exitCode = failures.length === 0 ? 0 : 1
