// 静态检查：client.js 里那类「只能靠看代码发现」的问题。
// 这些不跑被测代码，只扫源码 —— 但它们拦的正是线上已经出现过的事故：
// ① CopyRulesCard 的 useRef 写在 loading 早退之后，React #310，日志里崩了 26 次。
// ② 两个 CSS 变量名拼错，警告色整条丢失，界面上看不出来，只在代码里看得出。
// ③ PUSH_PROMPTS 定义了却没人调用的指令（推出去只有裸正文）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('Calendar empty search copy matches the explicit creation flow', () => {
  assert.equal(src.includes('没有匹配选题，保存时会新建。'), false, '保存要求先关联选题，不能声称会自动新建')
  assert.match(src, /没有匹配选题。请先新建选题，再创建平台版本并排期。/)
  assert.match(src, /'先建选题'/)
  assert.match(src, /disabled: busy \|\| draft\.topicPath === ''/)
})

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
// 所以状态机在 client.js 里还有一份副本。副本一定会漂移 —— 改了 lib 忘了改客户端，
// 界面上就会允许一个后端必然拒绝的动作。这条测试把两份钉在一起。
//
// 平台表不同：它是「生成」出来的（scripts/build-client.mjs），所以这里直接问生成器
// 两边有没有漂移，而不是自己再解析一遍字面量 —— 生成器和测试用同一个判断。
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

test('平台表：client.js 的内联块与 lib/platforms.js 一致（npm run check:client）', () => {
  assert.match(src, /@generated lib\/platforms\.js start/, 'client.js 里找不到平台表的生成标记块')
  const result = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'build-client.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, '平台表漂移了：\n' + String(result.stderr || result.stdout).trim())
  // 生成块里必须真的带着这三样，否则客户端会在运行时缺函数。
  for (const name of ['normalizePlatform', 'splitPlatforms', 'joinPlatforms']) {
    assert.match(src.slice(src.indexOf('@generated lib/platforms.js start'), src.indexOf('@generated lib/platforms.js end')), new RegExp('function ' + name + '\\('), '生成块里缺 ' + name)
  }
})

test('关卡片只有一个出口：setCardId(null) 只允许出现在 leaveCard 里', () => {
  assert.ok(src.includes('const leaveCard = (next) => {'), '找不到 leaveCard 出口函数')
  const hits = src.split('\n')
    .map((line, no) => ({ line, no: no + 1 }))
    .filter((row) => row.line.includes('setCardId(null)') && !row.line.trim().startsWith('//'))
  assert.equal(hits.length, 1, 'setCardId(null) 出现了 ' + hits.length + ' 次（只允许 leaveCard 内那一次）：\n'
    + hits.map((row) => row.no + ': ' + row.line.trim()).join('\n'))
})

test('navigation keeps iconless card tabs visible and uses a guarded selector only for the current project', () => {
  const breadcrumb = actualFunction('Breadcrumb')
  const picker = actualFunction('BreadcrumbSelect')
  assert.match(breadcrumb, /selectors/)
  assert.match(picker, /aria-label': label/)
  assert.match(src, /className: 'dsh-gw-card-tabs'.+aria-label': '卡片'/)
  assert.match(src, /className: 'dsh-gw-card-tab'/)
  assert.match(src, /workspaceCards\.map\(\(card, index\)/)
  assert.match(src, /}, card\.title\)\)\) : null/)
  assert.doesNotMatch(src, /className: 'dsh-gw-card-tab'[\s\S]{0,900}\(card\.icon \?\? ''\) \+ ' ' \+ card\.title/)
  assert.match(src, /\.dsh-gw-card-tabs\{[^}]*flex-wrap:wrap;[^}]*overflow:visible/)
  assert.match(src, /\.dsh-gw-card-tab::before\{content:'';[^}]*width:2px/)
  assert.match(src, /\.dsh-gw-card-tab\[data-on=true\]\{[^}]*box-shadow:[^}]*/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] \.dsh-gw-card-tab\[data-on=true\]\{[^}]*background:color-mix\([^}]*box-shadow:none/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] \.dsh-gw-card-tab\[data-on=true\]::before\{[^}]*width:2px;[^}]*background:var\(--gw-accent\)/)
  assert.doesNotMatch(src, /counter\(gw-card|counter-reset:gw-card|counter-increment:gw-card/)
  assert.match(src, /level: 'detail'.+detailSelector\.label/s)
  assert.doesNotMatch(src, /level: 'workspace'|level: 'card'/)
  assert.match(src, /nextPath === detailPath \|\| !draftRegistry\.allow\(\)/)
  assert.equal((src.match(/^      useDetailCrumb\(onCrumb/gm) ?? []).length, 8, 'eight detail-capable cards report selectors')
  assert.doesNotMatch(src, /onCrumb\(openPath\)|onCrumb\(activePath\)/)
})

function actualFunction(name) {
  const start = src.indexOf('    function ' + name + '('), end = src.indexOf('\n    }', start)
  assert.ok(start >= 0 && end > start, 'actual ' + name + ' function exists')
  return src.slice(start, end + 6)
}
test('host client remains one module with no relative imports and 14 public cards', () => {
  assert.doesNotMatch(src, /(?:import\s+[\s\S]*?from\s*|import\s*\()\s*['"]\.{1,2}\//)
  const cardOrder = src.slice(src.indexOf('    const CARD_ORDER = {'), src.indexOf('\n    }', src.indexOf('    const CARD_ORDER = {')))
  const ids = [...cardOrder.matchAll(/'([a-z]\w*)'/g)].map((match) => match[1])
  assert.deepEqual(ids.sort(), ['accounts', 'ideas', 'topics', 'products', 'studio', 'calendar', 'campaigns', 'pending', 'feedback', 'contentdata', 'data', 'sop', 'glossary', 'copyrules'].sort())
  assert.match(cardOrder, /ops:\s*\['accounts', 'ideas', 'topics', 'studio', 'calendar', 'pending', 'contentdata'\]/)
  assert.match(cardOrder, /ecom:\s*\['feedback', 'products', 'data'\]/)
  assert.match(cardOrder, /common:\s*\['sop', 'copyrules', 'glossary'\]/)
  assert.doesNotMatch(src, /爆款拆解（别人的）/)
  assert.match(src, /\.dsh-gw-panel\[data-tight=true\] \.dsh-gw-tabs\{[^}]*gap:4px/)
  assert.match(src, /\.dsh-gw-tabs\{[^}]*flex-wrap:nowrap/)
  assert.match(src, /\.dsh-gw-tablist\{[^}]*flex-wrap:nowrap;[^}]*overflow:hidden/)
  assert.match(src, /\.dsh-gw-tabs \.dsh-gw-search\{[^}]*flex:0 1 184px;[^}]*width:clamp\(116px,22vw,184px\)/)
  assert.match(src, /\.dsh-gw-panel\[data-tight=true\] \.dsh-gw-tabs \.dsh-gw-search\{[^}]*flex:0 1 126px;[^}]*min-width:104px/)
  assert.match(src, /\.dsh-gw-listfilter-input\{[^}]*max-width:100%;min-width:0/)
  assert.match(src, /\.dsh-gw-body\[data-narrow=true\] \.dsh-gw-account-row\{[^}]*grid-template-columns:minmax\(0,1fr\)/)
  assert.match(src, /\.dsh-gw-body\[data-narrow=true\] \.dsh-gw-sop-head\{[^}]*flex-wrap:wrap/)
  assert.match(src, /\.dsh-gw-body\[data-tight=true\] \.dsh-gw-ms-pop\{max-width:calc\(100% - 8px\)/)
  assert.match(src, /\.dsh-gw-notetable\{[^}]*overflow:auto/)
  assert.match(src, /\.dsh-gw-tablebox\{[^}]*overflow:auto;overscroll-behavior:contain/)
  // 不许预留常显滚动条槽：scrollbar-gutter:stable 会在表格右边留一条 12px 的纯空白。
  assert.doesNotMatch(src, /scrollbar-gutter/)
  assert.match(src, /\.dsh-gw-tablebox>\.dsh-gw-table>thead>tr>th,\.dsh-gw-tablebox>\.dsh-gw-matrix>thead>tr>th\{top:0\}/)
  assert.doesNotMatch(src, /\.dsh-gw-tablebox\{[^}]*overflow:visible/)
  assert.match(src, /className: 'dsh-gw-tablebox dsh-gw-gloss-box'[^\n]+aria-label': '术语表：可横向滚动'/)
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
test('Studio keeps status and platform filters together and hides the loaded-count row', () => {
  const body = actualFunction('StudioCard')
  assert.match(body, /platformFilters, setPlatformFilters\] = React\.useState\(\[\]\)/)
  assert.match(body, /for \(const variant of allVariants\)/)
  assert.match(body, /className: 'dsh-gw-card-top dsh-gw-studio-filters'/)
  assert.match(body, /h\(MultiSelect, \{ label: '状态'[\s\S]{0,220}h\(MultiSelect, \{ label: '平台'/)
  assert.match(src, /\.dsh-gw-studio-filters\{display:flex;align-items:center;gap:6px;flex-wrap:nowrap\}/)
  assert.match(body, /platformTopicRows = platformFilters\.length === 0/)
  assert.match(body, /rowPlatforms\.some\(\(platform\) => platformFilters\.includes\(platform\)\)/)
  assert.doesNotMatch(body, /h\(ListPager, \{ list \}\)/)
  assert.match(body, /list\.data\?\.truncated[^\n]+onClick: list\.loadMore[^\n]+载入更多/)
  assert.match(body, /没有符合状态或平台筛选的选题/)
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
  assert.match(body, /\[64, 88, 176, 88, 76, 70, 70, 70, 70, 68, 104\]/)
  assert.match(body, /colSpan: 11/)
  assert.match(body, /reviewTask/)
  assert.match(src, /\.dsh-gw-tablebox\.dsh-gw-pending-box\{[^}]*overflow:auto/)
  assert.match(src, /\.dsh-gw-pending-table thead th\{[^}]*position:sticky;top:0/)
  assert.match(src, /td:not\(\[colspan\]\):nth-child\(-n\+3\)\{[^}]*position:sticky/)
  assert.match(src, /font-variant-numeric:tabular-nums/)
  for (const name of ['date', 'views', 'likes', 'comments', 'shares', 'link', 'completion', 'avgDuration', 'followers', 'orders', 'gmv', 'returnReason', 'source', 'caliber']) assert.ok(body.includes(name), name)
})
test('creative palette uses actual host aliases; warning and typography stay distinct', () => {
  assert.match(src, /--gw-warm:light-dark\(#B95F42,#F0A07E\)/)
  assert.match(src, /--tone-attention:var\(--dsw-alias-state-warn-primary\)/)
  assert.match(actualFunction('installHostAccent'), /getComputedStyle\(probe\)/)
  assert.match(actualFunction('Panel'), /installHostAccent\(paletteRef\.current, window, document, theme\)/)
  assert.match(src, /\.dsh-gw-note-preview,\.dsh-gw-note-editor\{font-size:14px;line-height:1\.55/)
  assert.match(src, /min-height:28px;height:28px;white-space:nowrap/)
})
test('sunlit editorial theme uses warm white paper, soft orange, and restrained component chrome', () => {
  assert.equal((src.match(/\.dsh-gw-panel\[data-gw-scheme=light\]\{/g) ?? []).length, 1)
  assert.equal((src.match(/\.dsh-gw-panel\[data-gw-scheme=dark\]\{/g) ?? []).length, 1)
  assert.match(src, /data-gw-scheme=light[^}]*--gw-canvas:#f8f3ea;[^}]*--gw-paper:#fffaf2;[^}]*--gw-ink:#352d28;[^}]*--gw-accent:var\(--gw-warm,#b95f42\);--gw-accent-soft:#d97757/)
  assert.match(src, /data-gw-scheme=dark[^}]*--gw-canvas:#241c18;[^}]*--gw-paper:#2c231e;[^}]*--gw-ink:#f7eee8;[^}]*--gw-accent:var\(--gw-warm,#f0a07e\);--gw-accent-soft:#d98260/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] \.dsh-gw-card-tabs\{gap:2px 8px;padding:4px 12px 5px/)
  assert.match(src, /\.dsh-gw-panel\[data-tight=true\]\[data-gw-scheme\] \.dsh-gw-card-tabs\{padding:4px 10px 5px;gap:2px 6px/)
  assert.match(src, /const LS_THEME = 'dsh-growth:theme'/)
  assert.match(src, /className: 'dsh-gw-ibtn dsh-gw-ibtn-big dsh-gw-theme-toggle'/)
  assert.match(src, /settings: \['M12\.22 2h-\.44[^\]]*'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'\]/)
  assert.match(actualFunction('Panel'), /h\(Icon, \{ name: 'settings' \}\)/)
  assert.match(src, /'aria-pressed': theme === 'dark'/)
  assert.match(src, /setTheme\(\(current\) => writeTheme\(current === 'light' \? 'dark' : 'light'\)\)/)
  assert.doesNotMatch(src, /transition:all/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] :is\(\.dsh-gw-chip:hover,\.dsh-gw-pill-btn:hover\)\{[^}]*transform:none;box-shadow:none/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] \.dsh-gw-row\{[^}]*border:0;[^}]*border-bottom:1px solid var\(--gw-rule\);[^}]*border-radius:0/)
  assert.match(src, /\.dsh-gw-panel\[data-gw-scheme\] :is\(\.dsh-gw-ms-pop,[^}]*box-shadow:var\(--gw-shadow-pop\)/)
  assert.match(src, /\.dsh-gw-theme-toggle\{border-color:var\(--gw-rule-strong\);background:var\(--gw-paper-raised\);color:var\(--gw-muted\)\}/)
  assert.match(src, /const BUILD = '2026-11-14k'/)
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
test('feedback table keeps status visible in a real column and expands later boundaries together', () => {
  const body = actualFunction('FeedbackCard')
  assert.match(body, /\['c-body', 'c-fix', 'c-fix', 'c-state', 'c-act'\]/)
  assert.match(body, /\['c-date', 'c-channel', 'c-source', 'c-mood', 'c-body', 'c-tags', 'c-fix', 'c-fix', 'c-state', 'c-act'\]/)
  assert.match(body, /\['原文', '处理意见', '处理结果', '状态', '操作'\]/)
  assert.match(body, /\['日期', '渠道', '来源', '情感', '原文', '标签', '处理意见', '处理结果', '状态', '操作'\]/)
  assert.match(body, /className: 'dsh-gw-fb-state-cell'[\s\S]*className: 'dsh-gw-fb-state'/)
  assert.match(body, /className: 'dsh-gw-fb-actions-cell'[\s\S]*className: 'dsh-gw-acts'/)
  assert.match(body, /expandingPixelColResizeStart\(fbFullWidths/)
  assert.match(body, /expandedPixelColumnWidths\(current, index, delta/)
  assert.match(body, /width: 'max\(100%, ' \+ fbWidths\.reduce\(\(sum, width\) => sum \+ width, 0\) \+ 'px\)'/)
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
test('workbench fills the main page and its own chat column hosts the native conversation', () => {
  assert.doesNotMatch(src, /dsh-gw-fit|FitSidebarStage|GW_FIT_WIDTH/)
  // 工作台只占主区域（左侧栏那一页），对话画在同一页的右列里。
  // 右栏页签那条路是死的：宿主在全局面板占着主区域时会把右侧栏整列隐藏。
  assert.doesNotMatch(src, /sidebarRightTabs|sidebar\.right\.pane\.tab|openTabIn/)
  // 会话域必须是严格的 session：工作台占住主区域时主区域里没有 conversation 条目在跑，
  // session-maybe 继承到的是空绑定，格子里一片白。乔木 RSS 同样用 scope:"session"
  // 加自己 retain 的引用，这里照做。
  assert.doesNotMatch(src, /scope: 'session-maybe'/)
  const page = actualFunction('MainPanel')
  assert.match(page, /className: 'dsh-gw-pane dsh-gw-page' \+ \(column === null \? '' : ' dsh-gw-page-split'\)/)
  assert.match(page, /h\('div', \{ className: 'dsh-gw-page-main' \}, h\(Panel, \{/)
  // 自己 retain 的那份引用由宿主的 SessionProvider 包住子槽——这一步不能省，
  // 少了它子槽拿不到 sessionId，宿主的 embedded 对话也不认这份会话。
  assert.match(page, /h\(kit\.SessionProvider, \{ session: chatSession\.reference \}, kit\.renderSlot\(CHAT_SLOT, \{\}\)\)/)
  // 会话从「当前这一场」来；主区域没有会话时新建一场。
  assert.match(src, /uiSession\.current\.getSnapshot\(\)/)
  assert.match(src, /sessions\.create\(\{ workspaceId \}\)/)
  assert.match(src, /sessions\.retain\(sessionId, \{ source: CHAT_SOURCE \}\)/)
  assert.match(src, /ctx\.inject\(\['sessions', 'uiSession', 'uiWorkspace'\]/)
  // 主条目必须声明 session 子槽，否则页面 kit 里根本没有 renderSlot / SessionProvider。
  assert.match(src, /children: \{ \[CHAT_SLOT\]: \{ kind: 'single', scope: 'session' \} \}/)
  assert.match(src, /ctx\.slots\.inject\(CHAT_SLOT, /)
  // 那一格渲染的是这一场会话的原生对话：宿主的 conversation.content embedded 工厂。
  const chat = actualFunction('WorkbenchChat')
  assert.match(chat, /renderFactorySlot\('conversation\.content'/)
  assert.match(chat, /variant: 'embedded'/)
  assert.match(chat, /phase: settling \? 'settling' : hero \? 'hero' : 'active'/)
  // 只认工厂入口：组件自己不去 renderSlot conversation.session，钉死视图那层由工厂的
  // local slot（ChatView）来做。
  assert.doesNotMatch(chat, /renderSlot\(/)
  assert.doesNotMatch(chat, /h\(Panel,/)
  const view = actualFunction('ChatView')
  assert.match(view, /renderSlot\('conversation\.session', \{ view: 'chat' \}\)/)
  // 对话栏要能拖宽度：分隔条 + 自定义属性 + 本地持久化，窄屏退成上下排时隐藏分隔条。
  assert.match(page, /h\(ChatSplitter, \{ onResize: resizeChat \}\)/)
  assert.match(page, /style: \{ '--dsh-gw-chat-w': chatWidth \+ 'px' \}/)
  assert.match(src, /\.dsh-gw-chat-split\{[^}]*cursor:col-resize/)
  assert.match(src, /\.dsh-gw-chatcol\{[^}]*flex:0 0 var\(--dsh-gw-chat-w,420px\)/)
  // 专注时 Panel 是 fixed；打开 Agent 后，对话栏也必须升到专注层上方，且工作台让出相同宽度。
  assert.match(src, /\.dsh-gw-page-split:has\(\.dsh-gw-panel\[data-zen=true\]\) \.dsh-gw-panel\[data-zen=true\]\{right:var\(--dsh-gw-chat-w,420px\)\}/)
  assert.match(src, /\.dsh-gw-page-split:has\(\.dsh-gw-panel\[data-zen=true\]\) \.dsh-gw-chatcol\{position:fixed;[^}]*z-index:8801;[^}]*width:var\(--dsh-gw-chat-w,420px\)/)
  assert.match(page, /style: column === null \? undefined : \{ '--dsh-gw-chat-w': chatWidth \+ 'px' \}/)
  assert.match(src, /@media \(max-width:900px\)\{[\s\S]*?\.dsh-gw-chat-split\{display:none\}/)
  const splitter = actualFunction('ChatSplitter')
  assert.match(splitter, /parentElement/)
  assert.match(splitter, /rect\.right - event\.clientX/)
})
test('page mode neutralizes the panel veil so it cannot cover the app', () => {
  // 2026-11-15 事故：页面模式把 Panel 包进 .dsh-gw-page-main 之后，veil 不再是
  // .dsh-gw-pane 的直接子节点，`.dsh-gw-pane > .dsh-gw-veil` 失效，veil 退回
  // position:fixed + inset:0 + z-index:9000 的遮罩 —— 一打开工作台，整个 DSH
  // 主界面连同左侧栏都被盖住。这两条规则缺一条就会重现。
  assert.match(src, /\.dsh-gw-pane > \.dsh-gw-veil\{position:absolute;inset:0;padding:0;background:transparent/)
  assert.match(src, /\.dsh-gw-page-main > \.dsh-gw-veil,\.dsh-gw-page > \.dsh-gw-veil\{position:absolute;inset:0;padding:0;background:transparent/)
  // 绝对定位要有参照物：page-main 必须是 position:relative，否则 veil 会相对视口铺满。
  assert.match(src, /\.dsh-gw-page-main\{position:relative;/)
})
test('sticky top rows keep square corners in every card', () => {
  assert.match(src, /\.dsh-gw-panel:has\(> \.dsh-gw-body > \.dsh-gw-card-crumb\),\.dsh-gw-panel:has\(\.dsh-gw-body \.dsh-gw-card-crumb\)[^\{]*\{border-top-left-radius:0!important;border-top-right-radius:0!important\}/)
  assert.match(src, /\.dsh-gw-body>\.dsh-gw-card-crumb,\.dsh-gw-card-top,\.dsh-gw-rules-sticky,\.dsh-gw-note-sectionhead,\.dsh-gw-cal-week:first-child\{border-radius:0!important\}/)
})
test('home exposes truthful next actions and workspace tabs use roving keyboard navigation', () => {
  const panel = actualFunction('Panel')
  const actions = actualFunction('homeActions')
  assert.match(panel, /'下一步'/)
  assert.match(panel, /homeActions\(workspaceCards, summary\)/)
  assert.match(actions, /pendingCount/)
  assert.match(actions, /feedbackNegativeOpen/)
  assert.match(actions, /calendarPending/)
  assert.match(actions, /topicsDoing/)
  assert.match(panel, /tabIndex: workspace === item\.id \? 0 : -1/)
  assert.match(panel, /workspaceTabTarget\(WORKSPACES, item\.id, event\.key\)/)
  assert.match(panel, /'aria-controls': 'dsh-gw-workspace-panel'/)
  assert.match(panel, /role: 'tabpanel'/)
  assert.match(panel, /leaveCard\(\(\) => \{[\s\S]*setWorkspace\(target\)/)
})
test('narrow and touch layouts preserve actions, focus and usable target sizes', () => {
  assert.match(src, /\.dsh-gw-body\[data-narrow=true\] \.dsh-gw-next-grid\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}/)
  assert.match(src, /\.dsh-gw-body\[data-tight=true\] \.dsh-gw-next-grid\{grid-template-columns:minmax\(0,1fr\)\}/)
  assert.match(src, /@media \(hover:none\),\(pointer:coarse\)\{/)
  assert.match(src, /\.dsh-gw-panel :is\(\.dsh-gw-btn,\.dsh-gw-tab,\.dsh-gw-row-act[^}]+min-height:40px/)
  assert.match(src, /\.dsh-gw-panel :is\(button,\[role=button\],\[role=tab\],\[role=separator\],input,select,textarea,a\):focus-visible/)
  assert.match(src, /\.dsh-gw-col-grip\{[^}]*touch-action:none/)
})

test('errors persist until dismissed and settings expose truthful read-only health', () => {
  const panel = actualFunction('Panel')
  const settings = actualFunction('SettingsView')
  assert.match(panel, /if \(!error\) toastTimer\.current = window\.setTimeout/)
  assert.match(panel, /onClick: dismissToast/)
  assert.match(panel, /'aria-label': '关闭提示'/)
  assert.doesNotMatch(panel, /error \? 6000/)
  assert.match(settings, /get\('\/health'\)/)
  assert.match(settings, /'连接体检'/)
  assert.match(settings, /'只读检查，没有创建或改写文件'/)
  assert.match(settings, /const initialSettings = state\?\.operationalSettings/)
  assert.match(settings, /expectedRevision: settings\.revision, replace: true, profile/)
  assert.match(settings, /replace: copyCurrent && profile !== null, activate: true, profile: base/)
  assert.doesNotMatch(settings, /expectedRevision: result\.revision, rules: profileRulesOf\(profile\)/)
  assert.doesNotMatch(settings, /expectedRevision: result\.revision, cardLayout: profile\.cardLayout/)
  assert.match(settings, /settingsLoadError === null \? null/)
  assert.match(src, /\.dsh-gw-settings-layout\{display:grid;grid-template-columns:minmax\(124px,154px\) minmax\(0,1fr\)/)
  assert.match(src, /\.dsh-gw-settings-navbtn\[data-on=true\]\{[^}]*box-shadow:inset 2px 0 0 var\(--gw-accent\)/)
  assert.match(src, /\.dsh-gw-settings-savebar\{position:sticky;bottom:0/)
  assert.match(src, /async function publicationDetails\(\) \{[\s\S]{0,180}operationalReviewDays\(operationalSettingsSnapshot\)/)
  assert.match(src, /async function pushVariantWithBrief\(\) \{[\s\S]{0,900}runAutomationPolicy\(operationalSettingsSnapshot, 'suggestCopy'/)
  assert.match(settings, /已停止写入以避免覆盖/)
})

test('read hooks and search physically cancel superseded requests', () => {
  const asyncHook = actualFunction('useAsync')
  const pagedHook = actualFunction('usePagedList')
  const panel = actualFunction('Panel')
  assert.match(asyncHook, /const controller = new AbortController\(\)/)
  assert.match(asyncHook, /loader\(controller\.signal\)/)
  assert.match(asyncHook, /controller\.abort\(\)/)
  assert.match(pagedHook, /loaderRef\.current\([^\n]+\{ signal: controller\.signal \}\)/)
  assert.match(pagedHook, /controller\.abort\(\)/)
  assert.match(panel, /get\('\/search\?q='[\s\S]+\{ signal: controller\.signal \}\)/)
  assert.match(panel, /alive = false; controller\.abort\(\)/)
})

test('all list tables use the shared local-scroll and resize contract', () => {

  for (const name of ['StudioCard', 'UpcomingQueue', 'ProductsCard', 'CampaignMetricsPanel']) {
    const body = actualFunction(name)
    assert.match(body, /dsh-gw-adjustable-box/, name + ' local scroll wrapper')
    assert.match(body, /dsh-gw-adjustable-table/, name + ' shared table class')
    assert.match(body, /h\(ColumnGrip,/, name + ' visible accessible resize grip')
  }
  const grip = actualFunction('ColumnGrip')
  assert.match(grip, /role: 'separator'/)
  assert.match(grip, /tabIndex: 0/)
  assert.match(grip, /'aria-orientation': 'vertical'/)
  assert.match(grip, /columnResizeDelta\(event, pixel\)/)
  const gripUses = (src.match(/h\(ColumnGrip,/g) ?? []).length
  assert.ok(gripUses >= 11, 'expected every adjustable table to use ColumnGrip; found ' + gripUses)
  assert.equal((src.match(/className: 'dsh-gw-col-grip'/g) ?? []).length, 1, 'raw grip markup must stay centralized')
  const pending = actualFunction('PendingCard')
  assert.match(pending, /expandingPixelColResizeStart\(pendingWidths, setPendingWidths/)
  assert.match(src, /\.dsh-gw-rules-scroll>\.dsh-gw-rules-frame\{overflow:visible;min-width:0\}/)
  assert.match(src, /\.dsh-gw-rules thead th\{[^}]*position:sticky;top:0/)
  // 推动式列宽契约：所有拖宽都走 expandedPixelColumnWidths（只改被拖列，右侧列整体平移），旧「此消彼长」函数必须保持删除状态。
  assert.doesNotMatch(src, /shiftedColumnWidths|shiftedPixelColumnWidths|colResizeStart|pixelColResizeStart|installColumnDrag|installPixelColumnDrag/)
  assert.match(src, /function expandingPixelColResizeStart/)
  assert.match(src, /function usePixelColumnWidths/)
})

test('account picker keeps a readable select width and wraps the create button', () => {
  assert.match(src, /\.dsh-gw-account-picker>span:first-child\{flex-wrap:wrap\}/)
  assert.match(src, /\.dsh-gw-account-picker select\{[^}]*height:32px;padding:4px 24px 4px 8px;line-height:1\.35;[^}]*flex:1 1 160px;min-width:140px;max-width:100%;width:auto;text-overflow:ellipsis/)
  const body = actualFunction('AccountPicker')
  assert.match(body, /flexWrap: 'wrap'/)
  assert.match(body, /flex: '1 1 160px', minWidth: 140, maxWidth: '100%', width: 'auto'/)
})

test('upcoming schedule table can shrink below the generic adjustable minimum', () => {
  assert.match(src, /\.dsh-gw-adjustable-table\{min-width:0\}/)
  assert.match(actualFunction('UpcomingQueue'), /dsh-gw-table dsh-gw-upcoming dsh-gw-adjustable-table/)
})

test('tables refit into one screen and every scrollbar stays visible', () => {
  // 滚动条：12px 宽高 + 可见轨道 + 悬停加深，溢出时用户看得见（宿主默认细条几乎不可见）。
  assert.match(src, /\.dsh-gw-panel ::-webkit-scrollbar\{width:12px;height:12px\}/)
  assert.match(src, /\.dsh-gw-panel ::-webkit-scrollbar-track\{background:color-mix\(in srgb, var\(--dsw-alias-border-l1\) 26%, transparent\);border-radius:6px\}/)
  assert.match(src, /\.dsh-gw-panel ::-webkit-scrollbar-thumb\{background-color:var\(--dsw-alias-scrollbar-bg-l2\);border:3px solid transparent;border-radius:6px;background-clip:content-box;min-height:32px;min-width:32px\}/)
  assert.match(src, /\.dsh-gw-panel ::-webkit-scrollbar-thumb:hover,.dsh-gw-panel ::-webkit-scrollbar-thumb:active\{background-color:var\(--dsw-alias-scrollbar-hover-l2\)\}/)
  // 正文格允许折行，把长文本压回格内，而不是撑出横向滚动。
  assert.match(src, /\.dsh-gw-adjustable-table td\{white-space:normal;overflow-wrap:anywhere\}/)
  // 列宽拟合按容器宽度重跑（不再只在首屏跑一次），拖过的宽度只在放不下时收回。
  const hook = actualFunction('usePixelColumnWidths')
  // 必须观察滚动容器：表格是行内像素宽，容器变窄时表格自身尺寸不变，观察它收不到通知。
  assert.match(hook, /table\.closest\('\.dsh-gw-tablebox, \.dsh-gw-rules-frame, \.dsh-gw-rules-scroll'\)/)
  assert.match(hook, /Math\.abs\(available - fitted\) < 8/)
  assert.match(hook, /watchSize\(box, \(\) => fit\(\)\)/)
  assert.match(hook, /draggedRef\.current \|\| savedRef\.current !== null/)
  // 变宽时富余只补给最宽那列；操作列保持设计宽度，否则最后一列被摊宽、按钮右边空一截。
  assert.match(hook, /const next = fitPixelColumnWidths\(reference, minimums, available\)/)
  assert.doesNotMatch(hook, /if \(pinned && available >= total\) return current/)
  const fit = actualFunction('fitPixelColumnWidths')
  assert.match(fit, /Math\.max\(28, Math\.round\(Number\(minimums\[index\] \?\? 48\) \|\| 48\)\)/)
  assert.match(fit, /Math\.max\(28, Math\.floor\(\(width \* available\) \/ scaledTotal\)\)/)
  // 不再有钉死超宽的表格：台账 1080px 的横向溢出必须去掉（正文改折行）；
  // 拆解笔记 / 榜单这种带数字或标题的窄表保留一个适度的下限（≤640px），
  // 超出时靠加粗的横向滚动条提示，而不是把数字压成省略号。
  assert.doesNotMatch(src, /\.dsh-gw-ledger-table\{min-width:1080px\}/)
  assert.match(src, /\.dsh-gw-ledger-table\{min-width:0\}/)
  assert.match(src, /\.dsh-gw-ledger-table td\{white-space:normal;overflow-wrap:anywhere\}/)
  // 表格必须铺满所在容器：宽度取 max(100%, 各列之和)，列宽和小于容器时由浏览器
// 把余量分给各列，右缘不留一条空白；列宽和大于容器时才横向滚动。
  assert.equal((src.match(/width: 'max\(100%, ' \+/g) ?? []).length, 10, 'every adjustable table must fill its box')
  // 待回填表同理：宽度跟着列宽变量走，但至少铺满容器；伸缩时前三列的 sticky 偏移跟着列宽走。
  assert.match(src, /\.dsh-gw-pending-box \.dsh-gw-pending-table\{width:max\(100%,var\(--gw-pending-width,852px\)\);min-width:0\}/)
  assert.match(src, /left:var\(--gw-pending-left-2,64px\)/)
  assert.match(src, /left:var\(--gw-pending-left-3,152px\)/)
  for (const rule of [/\.dsh-gw-notetable-head,\.dsh-gw-notetable-row\{width:100%;min-width:(\d+)px\}/, /\.dsh-gw-rank-table\{width:100%;min-width:(\d+)px;/]) {
    const found = rule.exec(src)
    assert.ok(found !== null, 'expected a bounded min-width rule: ' + rule)
    assert.ok(Number(found[1]) <= 900, 'table min-width must stay bounded: ' + found[0])
  }
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

test('new-topic creation stays at list level while detail keeps only platform creation', () => {
  const studio = actualFunction('StudioCard')
  assert.match(studio, /const newTopicForm = h\(React\.Fragment/)
  assert.match(studio, /title: '新建选题', className: 'dsh-gw-create-card'/)
  assert.doesNotMatch(studio, /variantOnly:[\s\S]{0,140}newTopicForm/)
  const topic = actualFunction('TopicDetail')
  assert.doesNotMatch(topic, /newTopicForm/)
  const variants = actualFunction('PlatformVariantsPanel')
  assert.doesNotMatch(variants, /newTopicForm/)
  assert.doesNotMatch(variants, /title: '新建选题'/)
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
  assert.match(calendar, /fanoutPartialReceipt\(error\?\.payload\)/, 'thrown partial payload must become an actionable receipt')
  assert.match(calendar, /刷新核对/)
  assert.match(calendar, /只保留失败平台/)
  assert.match(calendar, /names\.length !== 1/, 'row platform edit must stay single-platform')
  assert.match(calendar, /PlatformInput, \{\s*value: platformEdit\.value/)
})
test('platform versions use one actionable list with metrics and script controls', () => {
  const body = actualFunction('PlatformVariantsPanel')
  assert.doesNotMatch(body, /dsh-gw-vcompare|同题多版对照/)
  assert.equal((body.match(/variants\.map\(row\)/g) ?? []).length, 1)
  assert.match(body, /最近数据 /)
  assert.match(body, /formatPercent\(latest\.completion\)/)
  assert.match(body, /formatDuration\(latest\.avgDuration\)/)
  assert.match(body, /'版本脚本'/)
})
test('platform version rows are compact: one line per version', () => {
  const body = actualFunction('PlatformVariantsPanel')
  // 平台版本曾排成三行（标题 / 平台·账号·发布·自检 / 最近数据），四个版本就要滚一屏。
  // 现在标题和 meta 同排，最近数据只作为 meta 的悬停提示存在。
  assert.match(body, /className: 'dsh-gw-row-line'/, 'title and meta must share one row line')
  assert.match(body, /dsh-gw-variant-meta/)
  assert.equal((body.match(/最近数据 /g) ?? []).length, 1, 'latest metrics must not render a second row')
  assert.match(body, /title: dataLine === '' \? undefined : dataLine/, 'latest metrics belong in the meta tooltip')
})
test('platform version row CSS keeps one line and ellipsizes meta', () => {
  assert.match(src, /\.dsh-gw-variant-row\{flex-wrap:nowrap/)
  assert.match(src, /\.dsh-gw-row-line\{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:nowrap\}/)
  assert.match(src, /\.dsh-gw-variant-meta\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
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
test('pending true-empty state leads to my topics while filtered-empty stays local', () => {
  const body = actualFunction('PendingCard')
  assert.match(body, /platformFilters\.length === 0 && accountFilters\.length === 0 && v2items\.length === 0/)
  assert.match(body, /先到「我的选题」创建平台版本并推进发布/)
  assert.match(body, /openCard\('studio'\)/)
  assert.match(body, /没有符合筛选的平台版本/)
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

test('focus mode turns the panel itself into a full-window layer', () => {
  const panel = actualFunction('Panel')
  // 开关在页头图标排里，任何卡片都能进来（不是 SOP 专属）；Esc 在面板层退出。
  assert.doesNotMatch(panel, /cardId === 'sop' \? h\('button', \{/, 'focus toggle is no longer SOP-only')
  assert.match(panel, /h\(Icon, \{ name: 'expand' \}\)/)
  assert.doesNotMatch(panel, /h\(Icon, \{ name: zenOn \? 'collapse' : 'expand' \}\)/)
  assert.match(panel, /'data-zen': zenOn \? 'true' : undefined/)
  assert.match(panel, /if \(event\.key === 'Escape'\) setZenOn\(false\)/)
  assert.doesNotMatch(panel, /if \(cardId !== 'sop' && zenOn\) setZenOn\(false\)/, 'leaving SOP must not drop focus mode')
  const sop = actualFunction('SopCard')
  assert.doesNotMatch(sop, /◉ 专注模式/)
  assert.doesNotMatch(sop, /setZen\(/)
  // 不再把 shell 搬出去（portal 到 body 会丢面板配色、背景变透明；挂进面板又容易在
  // 祖先容器里打架）。专注全由面板自己变成 fixed 层承担。
  assert.doesNotMatch(sop, /createPortal\(/)
  assert.match(sop, /return shell/)
  assert.equal((sop.match(/h\('button', \{ className: 'dsh-gw-btn', 'data-tone': 'primary', onClick: \(\) => setCreating/) ?? []).length, 1, '新建 stays the only card-header action')
  // SOP 卡片头在专注时也是普通形态；退出按钮统一放面板头第一行，卡片头不重复。
  assert.doesNotMatch(sop, /dsh-gw-sop-zenhead/)
  assert.doesNotMatch(sop, /dsh-gw-sop-zenhint/)
  assert.doesNotMatch(sop, /dsh-gw-zenexit/)
  assert.match(sop, /h\('div', \{ className: 'dsh-gw-sop-head' \}/)
  // 共享开关 + 面板自己 fixed 铺满主区域 + 实色背景。
  assert.match(src, /const zenStore = \{ on: false, listeners: new Set\(\) \}/)
  assert.match(src, /function useZenOn\(\)/)
  // 专注层应覆盖标题栏以下的整个网页，包括宿主左侧栏；Windows 原生标题栏仍保留。
  assert.match(src, /\.dsh-gw-panel\[data-zen=true\]\{position:fixed;top:var\(--dsh-windows-titlebar-height,0\);left:0;right:0;bottom:0/)
  assert.doesNotMatch(src, /--gw-zen-left/, 'focus mode must not reserve space for the host sidebar')
  // 面板头、工作区页签和卡片页签都留着：进得去也出得来，还能在专注里切换「运营 / 电商」等卡片。
  assert.doesNotMatch(src, /\.dsh-gw-panel\[data-zen=true\] \.dsh-gw-tabs\{display:none\}/)
  assert.doesNotMatch(src, /\.dsh-gw-panel\[data-zen=true\] \.dsh-gw-head,/)
  assert.doesNotMatch(src, /\.dsh-gw-panel\[data-zen=true\] \.dsh-gw-card-tabs,/)
  assert.match(src, /\.dsh-gw-panel\[data-zen=true\] \.dsh-gw-body\{max-width:none;margin-left:0;margin-right:0;padding:12px 16px 16px\}/)
  // 退出专注就在第一行（替换掉那颗专注图标），文字 + 图标，不是浮在右上角的兜底小按钮。
  assert.match(panel, /zenOn\s*\n\s*\? h\('button', \{\s*\n\s*className: 'dsh-gw-zenexit'/)
  assert.match(panel, /h\('span', null, '退出专注'\)/)
  assert.equal((panel.match(/className: 'dsh-gw-zenexit'/g) ?? []).length, 1, '只有一颗退出按钮')
  assert.doesNotMatch(panel, /dsh-gw-zen-chip/)
  assert.doesNotMatch(src, /\.dsh-gw-zen-chip\{position:absolute/)
  assert.match(src, /--gw-reading:82ch/)
  // 正文阅读列贴左（用户明确要求「编辑区内容还是靠左」）。
  assert.match(src, /\.dsh-gw-md\{max-width:min\(var\(--gw-reading\),100%\);margin-left:0;margin-right:auto\}/)
  assert.doesNotMatch(src, /\.dsh-gw-md\{max-width:min\(var\(--gw-reading\),100%\);margin-left:auto/)
})

test('agent chat is open by default and the head button mirrors that state', () => {
  // 默认开：localStorage 里没有记录时返回 true；关掉之后会记住。
  assert.match(src, /function readChatOpen\(\) \{/)
  assert.match(src, /if \(raw === null\) return true/)
  assert.match(src, /localStorage\.setItem\('dsh-growth\.chat\.open', on === true \? '1' : '0'\)/)
  const main = actualFunction('MainPanel')
  assert.match(main, /const \[open, setOpen\] = React\.useState\(readChatOpen\)/, '对话框默认展开')
  assert.match(main, /saveChatOpen\(false\)/, '关掉时记住')
  assert.match(main, /saveChatOpen\(true\)/, '打开时记住')
  assert.match(main, /chatOpen: open/)
  // 页头那颗按钮：开着时写「关闭 Agent 对话框」，关掉后写「开启 Agent 对话框」，前面带小图标。
  const panel = actualFunction('Panel')
  assert.match(panel, /'data-on': chatOpen === true \? 'true' : 'false'/)
  assert.match(panel, /'关闭 Agent 对话框' : '开启 Agent 对话框'/)
  assert.match(panel, /h\(Icon, \{ name: 'chat', size: 14 \}\)/)
  assert.match(src, /\.dsh-gw-chatbtn\[data-on="false"\]\{border-color:color-mix\(in srgb,var\(--gw-accent/)
})
test('列表随磁盘变化自动重取，切回窗口有兜底', () => {
  const serverSrc = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  // 客户端：一个总闸 + 列表订阅它；整库 SSE 换票走 path=*；可见性/焦点兜底
  assert.match(src, /const VaultChangeContext = React\.createContext\(0\)/, '缺少文件变化总闸')
  assert.match(src, /const vaultChange = React\.useContext\(VaultChangeContext\)/, '列表没订阅文件变化')
  assert.match(src, /\[path, query, state\.request, refresh, vaultChange\]/, '列表的依赖里没有文件变化')
  assert.match(src, /'\/v2\/events\?path=\*&ticket='/, '没有整库事件订阅')
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisible\)/, '缺少切回页面的兜底刷新')
  // 服务端：path=* 走整库，且只认 .md（排除 .bak / .obsidian / 隐藏目录）
  assert.match(serverSrc, /const WATCH_ALL = '\*'/)
  assert.match(serverSrc, /entry\.path === WATCH_ALL && broad/)
  assert.match(serverSrc, /IGNORED_EVENT_SEGMENTS = new Set\(\['\.obsidian'/)
  assert.match(serverSrc, /JSON\.stringify\(\{ changed: true \}\)/)
})

test('来源预览浮窗四边四角都能拖，旧的单角把手已撤掉', () => {
  assert.match(src, /\['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'\]\.map\(\(dir\) => h\('div'/, '八个缩放把手不在')
  assert.match(src, /className: 'dsh-gw-chat-preview-handle'/)
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.ok(src.includes('.dsh-gw-chat-preview-handle[data-dir="' + dir + '"]'), '缺少 ' + dir + ' 方向的把手样式')
  }
  assert.ok(!src.includes("className: 'dsh-gw-chat-preview-grip'"), '旧的单角把手还留着')
  assert.match(src, /function resizeRect\(start, dir, dx, dy, bounds\)/, '缺少缩放几何函数')
})

test('来源预览只拿能定位到具体内容的链接，裸域名不算数', () => {
  const serverSrc = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  assert.match(src, /function concreteLinkOf\(values\)/, '缺少链接判定助手')
  assert.match(src, /const sourceLink = concreteLinkOf\(\[front\.sourceUrl, front\.link, front\.url\]\)/, '预览来源没走判定')
  assert.match(src, /const sourceOf = \(item\) => concreteLinkOf\(/, '列表来源行没走判定')
  assert.match(serverSrc, /function usableSourceLink\(\.\.\.values\)/, '服务端缺少同样的判定')
  assert.match(serverSrc, /link: usableSourceLink\(source\.front\?\.sourceUrl, source\.front\?\.link\)/, '派生选题没走判定')
})

test('拖动光标挂在窗口上，不改写 document.body', () => {
  assert.match(src, /const \[dragDir, setDragDir\] = React\.useState\(''\)/)
  assert.match(src, /'data-drag': dragDir === '' \? undefined : dragDir/)
  assert.match(src, /\.dsh-gw-chat-preview\[data-drag\] \.dsh-gw-chat-preview-frame\{pointer-events:none\}/)
  assert.ok(!src.includes('document.body.style.cursor = dir === \'move\''), '仍在改写 body 光标')
  assert.ok(!src.includes("className: 'dsh-gw-chat-preview-resize'"), '死掉的隐藏缩放条还在')
})

test('预览浮窗的 state 声明齐全，补丁不许再把 anchor 吃掉', () => {
  const start = src.indexOf('    function ChatSourcePreviewDock(')
  assert.ok(start > 0, '找不到预览浮窗组件')
  const dock = src.slice(start, src.indexOf('\n    }\n', start))
  for (const line of [
    "const [floating, setFloating] = React.useState(true)",
    "const [fullscreen, setFullscreen] = React.useState(false)",
    "const [floatRect, setFloatRect] = React.useState(null)",
    "const [dragDir, setDragDir] = React.useState('')",
    'const previewRef = React.useRef(null)',
  ]) assert.ok(dock.includes(line), '预览浮窗缺少声明：' + line)
})

test('编辑界面的操作行钉在下方的悬浮条里', () => {
  assert.match(src, /className: 'dsh-gw-note-footbar'/, '缺少底部操作条')
  assert.match(src, /\.dsh-gw-note-footbar\{position:sticky;bottom:0/, '底部操作条没钉住')
  const at = src.indexOf("className: 'dsh-gw-note-footbar'")
  const block = src.slice(at, src.indexOf('h(ConflictDialog', at))
  for (const label of ['dsh-gw-note-acts', 'dsh-gw-note-acts-sep', 'AnnotationPill']) {
    assert.ok(block.includes(label), '悬浮条里缺少 ' + label)
  }
  // 框头里不该再留一份操作行（否则屏幕上会出现两组一样的按钮）
  const head = src.slice(src.indexOf("className: 'dsh-gw-note-headleft'"), at)
  assert.ok(!head.includes("h('span', { className: 'dsh-gw-note-acts' }"), '框头里还留着操作行')
})

test('四个板块的操作行也钉在底部（SOP / 文案规则 / 术语表 / 营销方案）', () => {
  // client.js 是 CRLF，比对前先归一，否则 '\n' 永远对不上。
  const srcLf = src.replace(/\r\n/g, '\n')
  assert.match(srcLf, /\.dsh-gw-footbar\{position:sticky;bottom:0/, '缺少通用底部条样式')
  const count = (srcLf.match(/className: 'dsh-gw-actions dsh-gw-footbar'/g) || []).length
  assert.ok(count >= 15, '新建类表单 + 四个板块共 15 处以上要贴底，现在只有 ' + count + ' 处')
  // SOP 预览区：操作行搬进了底部悬浮条，笔记头只剩标题和路径
  const headAt = srcLf.indexOf("className: 'dsh-gw-note-head'")
  const footAt = srcLf.indexOf("className: 'dsh-gw-note-footbar' },", headAt)
  assert.ok(headAt > 0 && footAt > headAt, 'SOP 底部悬浮条不在笔记头之后')
  assert.ok(!srcLf.slice(headAt, footAt).includes('dsh-gw-note-actions'), 'SOP 笔记头里还留着操作行')
  assert.ok(srcLf.slice(footAt).includes("className: 'dsh-gw-note-actions'"), 'SOP 操作行没进悬浮条')
})

console.log('\n' + pass + ' passed, ' + failures.length + ' failed')
process.exitCode = failures.length === 0 ? 0 : 1
