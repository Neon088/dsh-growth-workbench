/** Real React + system Chrome integration checks, with an entirely in-memory API.
 * No live DSH URL, real vault, user browser profile, installation or new dependency.
 * Run separately: node test/browser-safety.test.mjs [--smoke]
 * Optional GROWTH_TEST_PROFILE / GROWTH_TEST_CHROME choose existing test tools.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const calendarOnly = process.argv.includes('--calendar-warning-only')
const traceCalendar = process.argv.includes('--trace-calendar-height')
if (calendarOnly && process.argv.includes('--smoke')) throw new Error('Choose smoke or the single calendar diagnostic, not both')
if (traceCalendar && !calendarOnly) throw new Error('Height instrumentation is diagnostic-only; use --calendar-warning-only')
const outputBase = join(repo, 'test', '.artifacts', 'browser')
const profile = process.env.GROWTH_TEST_PROFILE || join(homedir(), '.dsh', 'profiles', 'desktop')
const candidates = [createRequire(join(repo, 'package.json')), createRequire(join(profile, 'package.json'))]
const requireExisting = (name) => {
  for (const req of candidates) { try { return { value: req(name), req } } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error } }
  throw new Error(`Existing ${name} is unavailable. No installation attempted; use GROWTH_TEST_PROFILE.`)
}
const { value: playwright } = requireExisting('playwright')
const reactRequire = requireExisting('react').req
const domRequire = requireExisting('react-dom').req
const reactSource = readFileSync(join(dirname(reactRequire.resolve('react/package.json')), 'umd', 'react.development.js'), 'utf8')
const domSource = readFileSync(join(dirname(domRequire.resolve('react-dom/package.json')), 'umd', 'react-dom.development.js'), 'utf8')
// An explicitly selected immutable artifact can diagnose an older Git snapshot
// without racing the implementation that is currently being edited.
const clientPath = process.env.GROWTH_TEST_CLIENT ? resolve(process.env.GROWTH_TEST_CLIENT) : join(repo, 'client.js')
const clientSource = readFileSync(clientPath, 'utf8')
const hash = (text) => createHash('sha256').update(text).digest('hex')
const clientHash = hash(clientSource)
const chrome = process.env.GROWTH_TEST_CHROME || [
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
if (!chrome || !existsSync(chrome)) throw new Error('System Chrome not found. No browser downloaded; use GROWTH_TEST_CHROME.')
mkdirSync(outputBase, { recursive: true })
const runDir = mkdtempSync(join(outputBase, 'run-'))
const chromeProfile = join(runDir, 'chrome-profile')
const fixturePath = join(runDir, 'fixture.html')
const reportPath = join(runDir, 'report.json')
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const month = day.slice(0, 7)
const title = '隔离测试选题'
const topicPath = 'Topics/隔离测试选题.md'
const cards = [
  ['accounts', 'ops', '账号档案'], ['ideas', 'ops', '灵感箱'], ['topics', 'ops', '爆款拆解（别人的）'], ['studio', 'ops', '我的选题'],
  ['calendar', 'ops', '内容日历'], ['pending', 'ops', '待回填数据'], ['contentdata', 'ops', '数据复盘'],
  ['products', 'ecom', '商品 / 竞品库'], ['data', 'ecom', '电商数据复盘'], ['feedback', 'ecom', '客户反馈库'],
  ['campaigns', 'mkt', '营销方案库'], ['sop', 'common', 'SOP 树'], ['glossary', 'common', '术语表'], ['copyrules', 'common', '文案规则 / 语调库'],
].map(([id, workspace, title]) => ({ id, workspace, title, icon: '', enabled: true }))
const fixtures = {
  cards, month, day, title, topicPath,
  topics: [
    { id: 'master-1', path: topicPath, title, sha1: 'master-0', body: '# 主选题\n\nORIGINAL_MASTER', front: { id: 'master-1', title, type: '选题', platform: '抖音', status: '在写', audience: '旧人群', purpose: '旧目的', materials: '旧素材', accountId: 'account-1', account: '隔离账号' } },
    { id: 'master-2', path: 'Topics/隔离测试拆解.md', title: '隔离测试拆解', sha1: 'case-0', body: '# 案例\n\nCASE_BODY', front: { id: 'master-2', title: '隔离测试拆解', type: '拆解', platform: '抖音' } },
  ],
  variants: ['A', 'B'].map((name) => ({ id: 'variant-' + name, path: 'Workbench/平台版本/master-1/抖音-' + name + '.md', sha1: 'variant-' + name + '-0', body: '## 版本脚本\n\nSCRIPT_' + name, front: { id: 'variant-' + name, masterId: 'master-1', title: '隔离测试选题', platform: '抖音', status: '在写', accountId: 'account-1', account: '隔离账号', audience: '版本人群' } })),
  accounts: [
    { path: 'Accounts/隔离账号.md', title: '隔离账号', sha1: 'account-0', body: '# 账号', front: { id: 'account-1', name: '隔离账号', platform: '抖音', status: '启用', positioning: '测试用的', audience: '帅哥', note: 'admin' } },
    { path: 'Accounts/test-2.md', title: 'test2', sha1: 'account-2-0', body: '# 账号', front: { id: 'account-2', name: 'test2', platform: '视频号', status: '启用', positioning: '备用账号', audience: '新客', note: '' } },
  ],
  products: [{ path: 'Products/隔离商品.md', title: '隔离商品', sha1: 'product-0', body: '# 商品', front: { id: 'product-1', name: '隔离商品', kind: '竞品', category: '测试', price: 20 } }],
  data: [{ path: 'Data/隔离复盘.md', title: '隔离复盘', sha1: 'data-0', body: '# 复盘\n\nDATA_BODY', front: { id: 'data-1', period: month, channel: '内容', platform: '抖音', views: 1200, likes: 50 } }],
  campaigns: [
    { path: 'Campaigns/隔离方案.md', title: '隔离方案', sha1: 'campaign-0', body: '# 方案\n\n### 效果对比\n\n| 指标 | 预期 | 实际 |\n|---|---|---|\n| 播放 | 1000 | 800 |\n', front: { id: 'campaign-1', title: '隔离方案', platform: '抖音', status: '筹备' } },
    { path: 'Campaigns/隔离方案B.md', title: '隔离方案B', sha1: 'campaign-b-0', body: '# 方案B\n\n### 效果对比\n\n| 指标 | 预期 | 实际 |\n|---|---|---|\n| 转化 | 50 | 42 |\n', front: { id: 'campaign-2', title: '隔离方案B', platform: '小红书', status: '筹备' } },
  ],
  glossary: [
    { id: 'gloss-1', zh: '隔离术语', en: 'isolated term', domain: '通用', tags: '测试', note: '只用于隔离回归。' },
  ],
  ideas: [
    { id: 'idea-1', date: day, source: '评论区', sourceUrl: 'https://example.invalid/idea-1', content: '把读者最关心的一个问题放在开头，再给判断依据。', status: '已用', outcome: topicPath },
    { id: 'idea-2', date: day, source: '同事', sourceUrl: '', content: '同一款产品做三条不同人群的版本，分别验证开头。', status: '新', outcome: '' },
  ],
  feedback: [
    { id: 'fb-1', date: day, channel: '私信', source: '抖音 · 隔离账号', sentiment: '负', content: '价格有点贵，想先看真实使用效果。', tags: '价格,信任', status: '未处理', advice: '补充真实使用过程与对比。', resolution: '' },
    { id: 'fb-2', date: day, channel: '评论', source: 'B站 · 隔离测试账号二', sentiment: '正', content: '这个选题角度很清楚。', tags: '内容', status: '已处理', advice: '', resolution: '已回复感谢。' },
  ],
  rules: {
    items: [
      { id: 'H1', section: 'hard', title: '不承诺绝对效果', fields: { 内容: '避免“保证”“一定”“100%”等绝对化承诺。', 证据: '平台规则与广告法。', 来源: '合规检查', 强度: '高', 反例: '保证一周见效。', 改法: '改成可验证的经历描述。' } },
      { id: 'H2', section: 'hard', title: '不虚构身份', fields: { 内容: '不编造专家、机构或使用经历。', 证据: '真实内容原则。', 来源: '编辑规范', 强度: '高', 反例: '我是十年皮肤科医生。', 改法: '只写真实身份和可核实信息。' } },
      { id: 'S1', section: 'soft', title: '开头先给读者一个判断', fields: { 内容: '前三句交代读者能得到什么。', 证据: '历史完读率。', 来源: '内容复盘', 强度: '中', 反例: '从背景铺垫开始。', 改法: '先结论，再解释。' } },
      { id: 'W1', section: 'watch', title: '价格段的表达方式', fields: { 内容: '观察价格段是否影响收藏。', 证据: '待补数据。', 来源: '待观察', 强度: '低', 反例: '直接报最低价。', 改法: '换成使用场景对比。' } },
    ],
    counts: { hard: 2, soft: 1, watch: 1 },
    sha1: 'rules-0',
  },
  productRollup: {
    products: [{
      productPath: 'Products/隔离商品.md', gmv: 678.9,
      items: [{ id: 'rollup-1', month: month, date: day, platform: '抖音', topic: '隔离商品：一条长标题用来验证平台标签不会挤成两行', views: 123456, gmv: 678.9, topicPath }],
    }],
  },
}
fixtures.rules.items.push(...Array.from({ length: 10 }, (_, index) => ({
  id: 'H' + (index + 3), section: 'hard', title: '隔离规则 ' + (index + 3),
  fields: { 内容: '这一条用来验证长规则表在本地面板内滚动时表头仍然固定。', 证据: '浏览器回归样本。', 来源: '隔离测试', 强度: '高', 反例: '无。', 改法: '保持表头可见。' },
})))
fixtures.rules.counts.hard += 10
function inBrowser(fixture) {
  const copy = (value) => JSON.parse(JSON.stringify(value))
  const params = new URL(location.href).searchParams
  // Simulate host aliases, not a claimed capture of the user's current theme.
  // The OS preference stays light in both cases so manual dark mode is exercised.
  window.__applyTestTheme = (theme) => {
    const dark = theme === 'dark'
    const tokens = dark ? {
      '--dsw-alias-bg-base': '#1f2126', '--dsw-alias-bg-container': '#282c31', '--dsw-alias-bg-container-alt': '#2d3239', '--dsw-alias-bg-overlay': '#282c31', '--dsw-alias-bg-raised': '#313640', '--dsw-alias-bg-layer-1': '#282c31', '--dsw-alias-bg-layer-2': '#313640', '--dsw-alias-border-l1': '#414852', '--dsw-alias-border-l2': '#515966', '--dsw-alias-border-l3': '#66717f', '--dsw-alias-link': '#88b5f2', '--dsw-alias-interactive-bg-hover': '#313640',
      '--dsw-alias-label-primary': '#e8ebef', '--dsw-alias-label-secondary': '#a6abb3', '--dsw-alias-label-tertiary': '#8d949f', '--dsw-alias-label-quaternary': '#858d99', '--dsw-alias-border-1': '#414852', '--dsw-alias-bg-mask': 'rgba(0,0,0,.6)',
      '--dsw-alias-state-warn-primary': '#e4b258', '--dsw-alias-state-success-primary': '#6cb99a', '--dsw-alias-state-error-primary': '#e88986', '--dsw-alias-state-info-primary': '#88b5f2', '--dsw-alias-brand-primary': '#88b5f2', '--dsw-alias-brand-secondary': '#b497d9',
    } : {
      '--dsw-alias-bg-base': '#f6f7f9', '--dsw-alias-bg-container': '#ffffff', '--dsw-alias-bg-container-alt': '#f4f6f8', '--dsw-alias-bg-overlay': '#ffffff', '--dsw-alias-bg-raised': '#ffffff', '--dsw-alias-bg-layer-1': '#ffffff', '--dsw-alias-bg-layer-2': '#f4f6f8', '--dsw-alias-border-l1': '#e0e4e9', '--dsw-alias-border-l2': '#d2d7de', '--dsw-alias-border-l3': '#bdc5cf', '--dsw-alias-link': '#326db7', '--dsw-alias-interactive-bg-hover': '#f4f6f8',
      '--dsw-alias-label-primary': '#27303a', '--dsw-alias-label-secondary': '#66717f', '--dsw-alias-label-tertiary': '#75808d', '--dsw-alias-label-quaternary': '#76818e', '--dsw-alias-border-1': '#e0e4e9', '--dsw-alias-bg-mask': 'rgba(30,40,50,.4)',
      '--dsw-alias-state-warn-primary': '#ad7508', '--dsw-alias-state-success-primary': '#348967', '--dsw-alias-state-error-primary': '#bf4e46', '--dsw-alias-state-info-primary': '#326db7', '--dsw-alias-brand-primary': '#326db7', '--dsw-alias-brand-secondary': '#76679a',
    }
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body.style.backgroundColor = dark ? '#15181c' : '#eceff2'
    document.body.style.color = 'var(--dsw-alias-label-primary)'
    const root = document.getElementById('root')
    root.style.backgroundColor = 'var(--dsw-alias-bg-base)'
    root.style.borderColor = 'var(--dsw-alias-border-1)'
  }
  window.__applyTestTheme(params.get('theme') || 'light')
  const frameWidth = Number(params.get('width') || 600)
  if (![440, 520, 600].includes(frameWidth)) throw new Error('Unsupported isolated frame width')
  document.getElementById('root').style.width = frameWidth + 'px'
  fixture.pendingItems = []; fixture.ledgerRows = []; fixture.calendarEntries = []
  if (params.get('filled') === '1') {
    const longTitle = '长标题：把读者关心的问题写清楚，再保留平台和账号的完整身份'
    fixture.topics[0].title = longTitle; fixture.topics[0].front.title = longTitle
    fixture.variants[1].front.status = '已发'
    for (let index = 0; index < 5; index++) {
      const id = 'layout-master-' + index, platform = index % 2 ? 'B站' : '抖音', accountId = index % 2 ? 'account-2' : 'account-1'
      const record = { id, path: 'Topics/隔离长标题-' + index + '.md', title: longTitle + ' · ' + (index + 1), sha1: id + '-0', body: '# 隔离正文\n\nLAYOUT_SCRIPT_' + index, _mtime: Date.now() - index * 86400000, front: { id, title: longTitle + ' · ' + (index + 1), type: '选题', platform, status: '已发', accountId, account: index % 2 ? '隔离测试账号二' : '隔离账号' } }
      fixture.topics.push(record)
      fixture.variants.push({ id: 'layout-variant-' + index, path: 'Workbench/平台版本/' + id + '/' + platform + '.md', sha1: id + '-variant-0', body: '# 版本\n\n' + record.body, front: { id: 'layout-variant-' + index, masterId: id, title: record.title, platform, accountId, account: record.front.account, status: '已发' } })
    }
    fixture.accounts.push({ path: 'Accounts/隔离测试账号二.md', title: '隔离测试账号二', sha1: 'account-2-0', body: '# 账号', front: { id: 'account-2', name: '隔离测试账号二', platform: 'B站', status: '启用', positioning: 'AI 高科技', audience: '年轻人 AI 爱好者', note: '无' } })
    for (const variant of fixture.variants.filter((item) => item.front.status === '已发')) {
      const master = fixture.topics.find((item) => item.front.id === variant.front.masterId)
      fixture.pendingItems.push({ master: copy(master), variant: copy(variant) })
      const index = fixture.pendingItems.length
      fixture.ledgerRows.push({ id: 'layout-metric-' + index, variantId: variant.id, date: fixture.day, views: 345678 + index, likes: 2345 + index, comments: 678 + index, shares: 321 + index, link: 'https://example.invalid/content/' + index, completion: 0.65, avgDuration: 32, followers: 18, orders: 12, gmv: 1888.5, source: '平台后台', caliber: '自然流量' })
      fixture.calendarEntries.push({ id: 'layout-calendar-' + index, date: fixture.day, platform: variant.front.platform, topic: master.title, status: '待发', note: '保留长备注、账号与链接，不在七列月格强塞全文。', link: 'https://example.invalid/content/' + index, topicPath: master.path, topicId: master.front.id, productPath: '', variantId: variant.id, account: variant.front.account, accountId: variant.front.accountId })
    }
  }
  const requests = [], rules = [], held = new Map(), unknown = []
  let serial = 0, writes = 0
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const list = (items, query) => {
    const q = String(query.get('q') || '').trim().toLowerCase()
    const filtered = items.filter((item) => !q || JSON.stringify(item).toLowerCase().includes(q))
    const offset = Math.max(0, Number(query.get('offset') || 0)), limit = Number(query.get('limit') || 300)
    const records = copy(filtered.slice(offset, offset + limit))
    return { ok: true, records, schema: [], total: filtered.length, offset, limit, truncated: offset + records.length < filtered.length }
  }
  function route(path, method, query, body) {
    if (path === '/token') return { ok: true, token: 'isolated-only-token' }
    if (path === '/client-log') return { ok: true }
    if (path === '/state') return { ok: true, configured: true, config: { vaultRoot: 'D:\\IsolatedNotes', sopDir: 'SOP' }, dataDir: 'isolated-test-only', cards: fixture.cards }
    if (path === '/overview') return { ok: true, summary: { sopNotes:0, contentDataCount:0, contentDataLatest:'', topics:fixture.topics.length, topicsDoing:1, topicsScripted:0, campaignsActive:0, campaignsTotal:fixture.campaigns.length, productsMine:0, productsRival:fixture.products.length, dataLatest:fixture.month, dataCount:fixture.data.length, ideasNew:0, ideasTotal:0, accountsTotal:fixture.accounts.length, glossary:0, feedbackNegativeOpen:0, feedbackTotal:0, pendingCount:fixture.pendingItems.length, calendarMonth:fixture.month, calendarPending:fixture.calendarEntries.filter((entry) => entry.status === '待发').length, calendarTotal:fixture.calendarEntries.length, ruleCounts:{hard:0,soft:0,watch:0} } }
    const collection = path.match(/^\/(topics|products|data|campaigns|accounts)\/(list|record)$/)
    if (collection) {
      const items = fixture[collection[1]]
      if (collection[2] === 'list') return list(items, query)
      const record = items.find((item) => query.get('path') ? item.path === query.get('path') : item.front.id === query.get('id'))
      if (!record) return { ok: false, code: 'not_found', message: 'isolated record missing' }
      if (method === 'PUT') {
        if (body.expectedSha1 && body.expectedSha1 !== record.sha1) return { ok: false, code: 'conflict', message: 'isolated conflict', current: copy(record) }
        if ('body' in body) record.body = String(body.body)
        Object.assign(record.front, body.front || {})
        record.sha1 = collection[1] + '-' + (++writes)
        return { ok: true, written: { path: record.path, sha1: record.sha1 }, record: copy(record) }
      }
      return { ok: true, record: copy(record), schema: [] }
    }
    if (path === '/v2/variants') return { ok: true, variants: copy(fixture.variants) }
    if (/^\/v2\/masters\/[^/]+\/variants$/.test(path)) return { ok: true, variants: copy(fixture.variants.filter((item) => item.front.masterId === path.split('/')[3])) }
    const variantMatch = path.match(/^\/v2\/variants\/([^/]+)$/)
    if (variantMatch) {
      const variant = fixture.variants.find((item) => item.id === decodeURIComponent(variantMatch[1]))
      if (!variant) return { ok: false, code: 'not_found', message: 'isolated variant missing' }
      if (method === 'DELETE') {
        if (body.expectedSha1 !== variant.sha1) return { ok: false, code: 'conflict', message: 'isolated delete conflict' }
        fixture.variants = fixture.variants.filter((item) => item !== variant)
        return { ok: true, removed: true }
      }
      if (method === 'PUT') {
        if (body.expectedSha1 && body.expectedSha1 !== variant.sha1) return { ok: false, code: 'conflict', message: 'isolated variant conflict' }
        if ('body' in body) variant.body = String(body.body)
        Object.assign(variant.front, body.front || {})
        variant.sha1 = variant.id + '-' + (++writes)
        return { ok: true, written: { path: variant.path, sha1: variant.sha1 }, variant: copy(variant) }
      }
      return { ok: true, variant: copy(variant) }
    }
    if (path === '/v2/ledger') return { ok: true, rows: copy(fixture.ledgerRows), schema: [] }
    if (path === '/v2/pending') return { ok: true, items: copy(fixture.pendingItems) }
    if (path === '/calendar') {
      const requestedMonth = query.get('month') || fixture.month
      return { ok: true, rows: [], entries: copy(fixture.calendarEntries.filter((entry) => entry.date.startsWith(requestedMonth))), schema: [], month: requestedMonth, path: 'Calendar/' + requestedMonth + '.md', sha1: 'calendar-0' }
    }
    if (path === '/ideas') return { ok: true, entries: copy(fixture.ideas), rows: [], schema: [], path: 'Workbench/isolated.md', sha1: 'table-0' }
    if (path === '/feedback') return { ok: true, entries: copy(fixture.feedback), rows: [], schema: [], path: 'Workbench/isolated.md', sha1: 'table-0' }
    if (path === '/glossary') return { ok: true, entries: copy(fixture.glossary), rows: [], schema: [], path: 'Workbench/isolated.md', sha1: 'table-0' }
    if (path === '/rules') return { ok: true, items: copy(fixture.rules.items), counts: copy(fixture.rules.counts), sha1: 'rules-0', body: '# 硬规则\n\n# 软规则\n\n# 待观察' }
    if (path === '/sop') return { ok: true, root: 'SOP', notes: [], entries: [], tree: [] }
    if (path === '/sop/search') return { ok: true, matches: [] }
    if (path === '/boards') return { ok: true, content: [], unmeasured: [], roi: [] }
    if (path === '/product-rollup') return { ok: true, rows: copy(fixture.productRollup.products), products: copy(fixture.productRollup.products) }
    if (path === '/search') return { ok: true, matches: [], total: 0, scope: query.get('scope') || 'workbench' }
    unknown.push({ path, method }); return { ok: false, code: 'bad_request', message: 'Unhandled isolated route: ' + method + ' ' + path }
  }
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), 'http://isolated.invalid')
    const path = url.pathname.replace(/^\/api\/dsh-growth/, '')
    const method = String(options.method || 'GET').toUpperCase()
    const body = options.body ? JSON.parse(options.body) : {}
    const request = { id: ++serial, path, query: url.search, method, body: copy(body), completed: false }
    requests.push(request)
    const at = rules.findIndex((rule) => rule.path === path && (!rule.method || rule.method === method))
    const rule = at === -1 ? null : rules.splice(at, 1)[0]
    request.fixtureRule = rule ? { error: rule.error || '', warning: rule.response?.warning || '', hold: Boolean(rule.hold) } : null
    if (rule?.error) { request.completed = true; request.responseSummary = { ok: false, code: rule.code || 'read_failed' }; return response({ ok: false, code: rule.code || 'read_failed', message: rule.error }, 500) }
    const result = copy(rule?.response === undefined ? route(path, method, url.searchParams, body) : rule.response)
    request.responseSummary = { ok: result.ok, code: result.code || '', warning: result.warning || '' }
    if (rule?.hold) return new Promise((resolve) => { held.set(request.id, { request, result, resolve }) })
    request.completed = true
    return response(result, result.ok === false ? (result.code === 'conflict' ? 409 : 400) : 200)
  }
  window.EventSource = class {
    constructor(url) { this.url = url; this.listeners = new Map(); window.__eventSources.push(this) }
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    removeEventListener(name) { this.listeners.delete(name) }
    close() { this.closed = true }
  }
  window.__eventSources = []
  window.__calendarMeasurements = []
  window.__fixture = {
    fixture, requests, unknown,
    queue(rule) { rules.push(rule) },
    queuedRules() { return copy(rules) },
    pending() { return Array.from(held.values(), ({ request }) => request) },
    release(id, result) { const item = held.get(id); if (!item) throw new Error('No held request ' + id); held.delete(id); item.request.completed = true; item.resolve(response(result || item.result, result?.ok === false ? 500 : 200)) },
    updateMaster(patch) { Object.assign(fixture.topics[0], patch) },
  }
  const requestedCard = new URL(location.href).searchParams.get('card')
  localStorage.clear()
  if (requestedCard) {
    localStorage.setItem('dsh-growth:card', requestedCard)
    const card = fixture.cards.find((item) => item.id === requestedCard)
    localStorage.setItem('dsh-growth:workspace', card?.workspace || 'ops')
  }
  window.__exports = null
  window.__ModuleLoader__ = { load({ factory }) { window.__exports = factory((name) => { if (name === 'react') return window.React; if (name === 'react-dom') return window.ReactDOM; throw new Error('Unexpected module ' + name) }) } }
}
const escapeScript = (text) => text.replace(/<\/script/gi, '<\\/script')
// Only expose private components in this test HTML. The plugin file and component
// implementations stay untouched; the regular Panel/card tour uses public exports.
let browserClient = clientSource.replace('const exports_ = {', 'const exports_ = { __test: { TopicDetail, PlatformVariantsPanel, NoteDetail, CalendarCard, GlossaryCard, CampaignsCard, ConfirmDialog, DraftContext, RefreshContext, createDraftRegistry },')
assert.notEqual(browserClient, clientSource, 'Private test export anchor changed; update the fixture explicitly')
if (traceCalendar) {
  const marker = 'if (el !== null) setCalHeadH(Math.round(el.getBoundingClientRect().height))'
  assert.equal(clientSource.split(marker).length, 2, 'The archived calendar measurement anchor must match exactly once')
  browserClient = browserClient.replace(marker, `if (el !== null) {
    const measured = el.getBoundingClientRect()
    window.__calendarMeasurements.push({ height: measured.height, calHeadH, bodyWidth: document.querySelector('.dsh-gw-body')?.clientWidth ?? 0, entryCount: entries.length, warning: cal.error?.code ?? '', time: performance.now() })
    setCalHeadH(Math.round(measured.height))
  }`)
}
const boot = `
window.__registered = {};
const cleanup = [];
const slots = { inject(name, fn) { return fn(); }, register(def, component) { window.__registered[def.id || def.key || def.name] = component; return () => {}; } };
const ctx = { slots, get(name) { return name === 'slots' ? slots : undefined; }, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; }, inject(names, fn) { return fn(ctx); } };
window.__exports.apply(ctx);
window.__root = ReactDOM.createRoot(document.getElementById('root'));
window.__root.render(React.createElement('div', {className:'dsh-gw-pane'}, React.createElement(window.__exports.Panel, {onClose:null})));
window.__notices = []; window.__confirmMessages = []; window.__discardConfirmed = false; window.__detailRefresh = 0;
const tested = window.__exports.__test;
window.__testRegistry = tested.createDraftRegistry((message) => { window.__confirmMessages.push(message); return window.__discardConfirmed; }, () => window.__notices.push('busy'));
let topicProps = null, noteProps = null;
const withContext = (child) => React.createElement('div', {className:'dsh-gw-pane'}, React.createElement(tested.DraftContext.Provider, {value:window.__testRegistry}, React.createElement(tested.RefreshContext.Provider, {value:window.__detailRefresh}, child)));
window.__mountTopic = (options = {}) => {
  topicProps = {...(topicProps || {path:window.__fixture.fixture.topicPath, initial:JSON.parse(JSON.stringify(window.__fixture.fixture.topics[0])), studio:true, studioReady:true, studioRecords:window.__fixture.fixture.topics, openBody:true, autoEdit:true, tagOptions:[], notify:(message) => window.__notices.push(String(message)), onBack:() => window.__notices.push('back'), showOwnCrumb:false}), ...options};
  window.__root.render(withContext(React.createElement(tested.TopicDetail, topicProps)));
};
window.__mountCalendar = (options = {}) => {
  const { height = 720, ...cardOptions } = options;
  const card = React.createElement(tested.CalendarCard, {notify:(message) => window.__notices.push(String(message)), onCrumb:null, openCard:() => {}, preset:null, ...cardOptions});
  window.__root.render(withContext(React.createElement('div', {className:'dsh-gw-body', style:{height:height + 'px', overflow:'auto'}}, card)));
};
window.__mountVariants = (options = {}) => {
  const props = {
    masterId: 'master-1', topicPath: window.__fixture.fixture.topicPath, topicTitle: window.__fixture.fixture.title, topicLink: '',
    notify: (message) => window.__notices.push(String(message)), openCard: () => {},
    onOpenScript: () => {}, onCloseScript: () => true, activeScriptId: '', createRequest: 1, createPlatform: '抖音',
    onChanged: () => {}, getVariantBaseline: () => undefined, onVariantWriting: () => {}, onVariantSaved: () => {}, onScriptDeleted: () => {},
    ...options,
  };
  window.__root.render(withContext(React.createElement(tested.PlatformVariantsPanel, props)));
};
window.__mountNote = (options = {}) => {
  noteProps = {...(noteProps || {kind:'data', path:window.__fixture.fixture.data[0].path, notify:(message) => window.__notices.push(String(message)), onBack:() => window.__notices.push('back'), showOwnCrumb:false}), ...options};
  window.__root.render(withContext(React.createElement(tested.NoteDetail, noteProps)));
};
window.__refreshDetail = () => { window.__detailRefresh += 1; if (topicProps) window.__mountTopic(); else window.__mountNote(); };
window.__mountConfirm = () => {
  const target = document.createElement('button'); target.id = 'focus-restore-target'; target.textContent = 'restore'; document.body.appendChild(target); target.focus();
  window.__dialogDone = null;
  window.__root.render(React.createElement(tested.ConfirmDialog, {request:{message:'隔离焦点测试'}, onDone:(value) => { window.__dialogDone = value; window.__root.render(null); }}));
};
`
// Complete simulated light-theme aliases. These are test values, not the user's live DSH theme.
const palette = `:root{--dsw-alias-label-primary:#232527;--dsw-alias-label-secondary:#70757a;--dsw-alias-label-tertiary:#8a9096;--dsw-alias-label-quaternary:#a4a9ad;--dsw-alias-bg-base:#f6f7f9;--dsw-alias-bg-overlay:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f1f2f3;--dsw-alias-border-l1:#e0e2e4;--dsw-alias-border-l2:#e8eaec;--dsw-alias-border-l3:#c8cdd2;--dsw-alias-link:#1268b5;--dsw-alias-brand-primary:#1268b5;--dsw-alias-state-warn-primary:#95671f;--dsw-alias-state-error-primary:#ae3030;--dsw-alias-state-success-primary:#367944;--dsw-alias-error:#ae3030;--dsw-alias-success:#367944;}html,body{margin:0;height:100%;background:#eceff2;color:#232527;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;}#root{width:600px;height:800px;margin:16px auto;overflow:hidden;background:#f6f7f9;border:1px solid #dadde0}.dsh-gw-pane{height:100%;}`
writeFileSync(fixturePath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离增长工作台测试</title><style>${palette}</style><div id="root"></div><script>${escapeScript(reactSource)}</script><script>${escapeScript(domSource)}</script><script>(${inBrowser.toString()})(${JSON.stringify(fixtures).replace(/</g, '\\u003c')});</script><script>${escapeScript(browserClient)}</script><script>${boot}</script></html>`, 'utf8')
const outcomes = [], pageErrors = [], warnings = []
let browser, context, chromeError
// stdio ignore intentionally avoids the confined Windows named-pipe boundary.
const processHandle = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + chromeProfile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', 'about:blank'], { stdio: 'ignore', windowsHide: true })
processHandle.on('error', (error) => { chromeError = error })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function newPage(card, { width = 600, theme = 'light', filled = false } = {}) {
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  page.on('pageerror', (error) => pageErrors.push({ card, width, theme, message: error.message }))
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') warnings.push({ card, width, theme, message: message.text() }) })
  await page.route('**/*', (route) => route.request().url().startsWith('file:') ? route.continue() : route.abort())
  const url = pathToFileURL(fixturePath)
  if (card) url.searchParams.set('card', card)
  url.searchParams.set('width', String(width)); url.searchParams.set('theme', theme)
  if (filled) url.searchParams.set('filled', '1')
  await page.goto(url.href)
  await page.waitForSelector('.dsh-gw-body')
  await page.waitForFunction(() => !document.body.textContent.includes('连接工作台…'))
  return page
}
// Run inside Chrome so color(srgb), color-mix and alpha surfaces are resolved
// by the actual rendering engine instead of guessed from CSS source strings.
function layoutAudit() {
  const root = document.getElementById('root'), body = document.querySelector('.dsh-gw-body')
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (color) => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0,0,0,0)'; context.fillStyle = color; context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  }
  const blend = (top, bottom) => {
    const alpha = top[3] / 255
    return [0, 1, 2].map((index) => top[index] * alpha + bottom[index] * (1 - alpha)).concat(255)
  }
  const luminance = (color) => color.slice(0, 3).map((value) => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  const creators = Array.from(document.querySelectorAll('button')).filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && !node.disabled && (node.getAttribute('data-tone') === 'primary' || /^(创作|写脚本|继续写|开始写|写这一版|写稿)$/.test(node.textContent.trim()))
  }).map((node) => {
    const style = getComputedStyle(node), ancestors = []
    for (let element = node; element; element = element.parentElement) ancestors.unshift(element)
    let background = [255, 255, 255, 255]
    for (const element of ancestors) background = blend(rgba(getComputedStyle(element).backgroundColor), background)
    const foreground = blend(rgba(style.color), background), light = luminance(foreground), dark = luminance(background)
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); const textNodes = []
    while (walker.nextNode()) if (walker.currentNode.textContent.trim()) textNodes.push(walker.currentNode)
    const longest = textNodes.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0]
    const range = document.createRange(); if (longest) range.selectNodeContents(longest)
    const lines = longest ? new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size : 0
    const rect = node.getBoundingClientRect()
    return { text: node.textContent.trim(), width: rect.width, height: rect.height, lines, fontSize: parseFloat(style.fontSize), foreground, background, contrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) }
  })
  return {
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: body.scrollWidth - body.clientWidth,
    frameWidth: root.getBoundingClientRect().width,
    bodyWidth: body.clientWidth,
    creatorToken: getComputedStyle(body.closest('.dsh-gw-pane') || root).getPropertyValue('--gw-warm').trim(),
    warningToken: getComputedStyle(body.closest('.dsh-gw-pane') || root).getPropertyValue('--dsw-alias-state-warn-primary').trim(),
    creators,
  }
}
async function check(name, fn) {
  try { const evidence = await fn(); outcomes.push({ name, status: 'passed', ...(evidence && typeof evidence === 'object' ? { evidence } : {}) }); console.log('✓ ' + name) }
  catch (error) {
    const evidence = { name, status: 'failed', error: String(error.stack || error) }
    const page = context?.pages().at(-1)
    if (page) {
      evidence.screenshot = join(runDir, 'failed-' + outcomes.length + '.png')
      await page.screenshot({ path: evidence.screenshot }).catch(() => {})
      evidence.dom = await page.evaluate(() => ({ text: document.body.innerText, buttons: Array.from(document.querySelectorAll('button'), (node) => ({ text: node.textContent, label: node.getAttribute('aria-label'), title: node.title })), requests: window.__fixture?.requests || [], queuedRules: window.__fixture?.queuedRules() || [], heldRequests: window.__fixture?.pending() || [] })).catch(() => null)
      if (traceCalendar) {
        evidence.measurements = await page.evaluate(() => window.__calendarMeasurements).catch(() => null)
        writeFileSync(join(runDir, 'calendar-measurements.json'), JSON.stringify(evidence.measurements, null, 2) + '\n')
      }
      await page.close().catch(() => {})
    }
    outcomes.push(evidence); console.error('✗ ' + name + ': ' + error.message)
  }
}
try {
  const portFile = join(chromeProfile, 'DevToolsActivePort')
  const deadline = Date.now() + 15000
  while (!existsSync(portFile)) {
    if (chromeError) throw chromeError
    if (processHandle.exitCode !== null) throw new Error('Isolated Chrome exited before CDP became ready: ' + processHandle.exitCode)
    if (Date.now() > deadline) throw new Error('Isolated Chrome CDP startup timed out')
    await pause(100)
  }
  const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
  browser = await playwright.chromium.connectOverCDP('http://127.0.0.1:' + port)
  context = await browser.newContext({ viewport: { width: 900, height: 900 }, timezoneId: 'Asia/Shanghai' })
  if (!calendarOnly) {
  await check('真实 React 挂载首页；Esc 不调用空 onClose', async () => {
    const page = await newPage()
    await page.getByText('账号档案', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.dsh-gw-crash').count(), 0)
    await page.screenshot({ path: join(runDir, 'home-600.png') })
    await page.close()
  })
  for (const card of cards) {
    await check('卡片真实挂载：' + card.title, async () => {
      const page = await newPage(card.id)
      await page.waitForFunction(() => document.querySelector('.dsh-gw-card-crumb') !== null)
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.dsh-gw-crash').count(), 0, 'CardBoundary caught a rendering exception')
      assert.deepEqual(await page.evaluate(() => window.__fixture.unknown), [], 'Mock route missing: update fixture, never call the live API')
      if (['topics', 'studio', 'calendar', 'pending'].includes(card.id)) await page.screenshot({ path: join(runDir, card.id + '-600.png') })
      if (card.id === 'studio') {
        writeFileSync(join(runDir, 'studio-dom.json'), JSON.stringify(await page.evaluate(() => ({ buttons: Array.from(document.querySelectorAll('button'), (node) => ({ text: node.textContent, label: node.getAttribute('aria-label'), title: node.title })), text: document.body.innerText })), null, 2))
      }
      await page.close()
    })
  }
  for (const theme of ['light', 'dark']) {
    await check('截图回归：灵感去向 / 反馈关联 / 商品徽标 / 账号对齐 / 规则表头 ' + theme, async () => {
      let page = await newPage('ideas', { width: 600, theme, filled: true })
      await page.locator('.dsh-gw-ideas tbody tr').first().waitFor()
      assert.equal(await page.getByRole('button', { name: '打开选题', exact: true }).count(), 1, 'Linked idea must show its real outcome action')
      assert.equal(await page.getByRole('button', { name: '拆解', exact: true }).count(), 1, 'Only the unused idea may offer 拆解')
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-ideas.png') })
      await page.close()

      page = await newPage('feedback', { width: 600, theme, filled: true })
      await page.locator('.dsh-gw-fb-row').first().waitFor()
      await page.locator('.dsh-gw-range-search').first().fill('隔离')
      await page.locator('.dsh-gw-source-result').first().waitFor()
      assert.ok(await page.locator('.dsh-gw-source-result').count() >= 1, 'Full-vault feedback association must offer clickable results')
      await page.locator('.dsh-gw-source-result').first().click()
      assert.equal(await page.locator('.dsh-gw-source-result').first().getAttribute('data-selected'), 'true', 'Clicking a full-vault result must select it for the new feedback')
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-feedback.png') })
      await page.close()

      page = await newPage('products', { width: 600, theme, filled: true })
      await page.locator('.dsh-gw-fold > summary').filter({ hasText: '带过内容' }).first().click()
      await page.locator('.dsh-gw-platform-badge').first().waitFor()
      const badge = await page.locator('.dsh-gw-platform-badge').first().evaluate((node) => { const rect = node.getBoundingClientRect(); return { text: node.textContent.trim(), height: rect.height, whiteSpace: getComputedStyle(node).whiteSpace } })
      assert.equal(badge.text, '抖音')
      assert.equal(badge.whiteSpace, 'nowrap')
      assert.ok(badge.height < 30, 'Platform badge must stay a single compact line: ' + JSON.stringify(badge))
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-products.png') })
      await page.close()

      page = await newPage('accounts', { width: 600, theme, filled: true })
      const accountRow = page.locator('.dsh-gw-account-row').filter({ has: page.locator('.dsh-gw-row-meta') }).first()
      await accountRow.waitFor()
      assert.equal(await page.locator('.dsh-gw-range-search').count(), 0, 'Account card must use its one card-local search, not a duplicate full-vault input')
      const account = await accountRow.evaluate((node) => {
        const nameNode = node.querySelector('.dsh-gw-row-name')
        const name = nameNode.getBoundingClientRect()
        const flags = node.querySelector('.dsh-gw-account-flags').getBoundingClientRect()
        const meta = node.querySelector('.dsh-gw-row-meta')
        const lead = node.querySelector('.dsh-gw-account-meta-lead').getBoundingClientRect()
        const tail = node.querySelector('.dsh-gw-account-meta-tail').getBoundingClientRect()
        const row = node.getBoundingClientRect()
        return { nameWidth: name.width, nameLeft: name.left, flagsLeft: flags.left, leadLeft: lead.left, tailLeft: tail.left, nameSize: parseFloat(getComputedStyle(nameNode).fontSize), nameWash: getComputedStyle(nameNode).backgroundColor, metaSize: parseFloat(getComputedStyle(meta).fontSize), rowHeight: row.height }
      })
      assert.ok(account.nameWidth <= 221, 'Account name must not run into actions: ' + JSON.stringify(account))
      assert.ok(Math.abs((account.flagsLeft - account.nameLeft) - (account.tailLeft - account.leadLeft)) <= 2, 'Account badges must start at the audience value: ' + JSON.stringify(account))
      assert.ok(account.nameSize >= 15.9, 'Account name must be more prominent: ' + JSON.stringify(account))
      assert.ok(account.nameWash !== 'rgba(0, 0, 0, 0)' && account.nameWash !== 'transparent', 'Account name needs a background wash: ' + JSON.stringify(account))
      assert.ok(account.metaSize >= 12.4, 'Account positioning text is too small: ' + JSON.stringify(account))
      assert.ok(account.rowHeight >= 58, 'Account row is shorter than the shared card rhythm: ' + JSON.stringify(account))
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-accounts.png') })
      await page.close()

      page = await newPage('copyrules', { width: 600, theme })
      await page.locator('.dsh-gw-rules').waitFor()
      const sticky = await page.locator('.dsh-gw-rules thead th').first().evaluate((node) => getComputedStyle(node).position)
      assert.equal(sticky, 'sticky', 'Copy Rules header must stay fixed')
      const scroller = page.locator('.dsh-gw-rules-scroll')
      await scroller.evaluate((node) => { node.scrollTop = 200 })
      await page.waitForTimeout(250)
      const headerOffset = await page.evaluate(() => {
        const box = document.querySelector('.dsh-gw-rules-scroll').getBoundingClientRect()
        const head = document.querySelector('.dsh-gw-rules thead th').getBoundingClientRect()
        return { boxTop: box.top, headTop: head.top }
      })
      assert.ok(Math.abs(headerOffset.headTop - headerOffset.boxTop) <= 2, 'Copy Rules header scrolled away: ' + JSON.stringify(headerOffset))
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-copyrules.png') })
      await page.close()

      page = await newPage('campaigns', { width: 600, theme })
      await page.locator('.dsh-gw-row-name').filter({ hasText: '隔离方案' }).first().click()
      const metricsTitle = page.locator('.dsh-gw-fold > summary').filter({ hasText: '效果对比（结构化编辑）' })
      await metricsTitle.first().waitFor()
      await page.locator('.dsh-gw-crumb-back').first().click()
      await page.locator('.dsh-gw-row-name').filter({ hasText: '隔离方案B' }).first().click()
      await metricsTitle.first().waitFor()
      assert.equal(await metricsTitle.count(), 1, 'Opening a second campaign must not accumulate structure editors')
      await page.screenshot({ path: join(runDir, 'ui-600-' + theme + '-campaign-detail.png') })
      await page.close()
    })
  }
  }
  await check('第二批：账号摘要 / 单类目术语 / 方案平台多选与信息顺序', async () => {
    let page = await newPage()
    await page.getByText('账号档案', { exact: true }).waitFor()
    const home = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.dsh-gw-row')).find((node) => node.querySelector('.dsh-gw-row-title')?.textContent.trim() === '账号档案')
      return row ? { meta: row.querySelector('.dsh-gw-row-meta')?.textContent.trim() ?? '', height: row.getBoundingClientRect().height } : null
    })
    assert.ok(home !== null && home.meta === '平台 / 定位 / 目标人群', 'Home account row must expose its collection summary: ' + JSON.stringify(home))
    assert.ok(home.height >= 55, 'Home account row must keep the shared two-line rhythm: ' + JSON.stringify(home))
    await page.close()

    page = await newPage('glossary', { width: 600, filled: true })
    await page.locator('.dsh-gw-rules-card').waitFor()
    await page.locator('.dsh-gw-tablebox table').waitFor()
    assert.equal(await page.locator('.dsh-gw-fold > summary').filter({ hasText: '术语' }).count(), 0, 'A single-category glossary must not keep a redundant 术语 fold')
    await page.getByText('隔离术语', { exact: true }).waitFor()
    const glossaryHeaders = await page.locator('.dsh-gw-gloss-table thead th').allTextContents()
    assert.deepEqual(glossaryHeaders.map((text) => text.replace(/[▲▼]/g, '').trim()), ['领域', '标签', '中文', '英文', '备注'], 'Glossary must not reserve an empty action column')
    assert.equal(await page.locator('.dsh-gw-gloss-table tbody tr').first().locator('td').count(), 5, 'Glossary row must have five content cells')
    const glossaryDelete = page.locator('.dsh-gw-gloss-del').first()
    const deleteIdle = await glossaryDelete.evaluate((node) => ({ opacity: parseFloat(getComputedStyle(node).opacity), pointerEvents: getComputedStyle(node).pointerEvents }))
    assert.ok(deleteIdle.opacity <= 0.1 && deleteIdle.pointerEvents === 'none', 'Glossary delete must stay hidden until hover: ' + JSON.stringify(deleteIdle))
    await page.locator('.dsh-gw-gloss-table tbody tr').first().hover()
    const deleteHover = await glossaryDelete.evaluate((node) => ({ opacity: parseFloat(getComputedStyle(node).opacity), pointerEvents: getComputedStyle(node).pointerEvents }))
    assert.ok(deleteHover.opacity >= 0.6 && deleteHover.pointerEvents === 'auto', 'Glossary delete must appear on row hover: ' + JSON.stringify(deleteHover))
    await page.screenshot({ path: join(runDir, 'ui-600-light-glossary-single.png') })
    await page.close()

    page = await newPage('campaigns', { width: 600 })
    await page.locator('.dsh-gw-row-name').filter({ hasText: '隔离方案' }).first().click()
    await page.locator('.dsh-gw-platmulti input').first().waitFor()
    const campaign = await page.evaluate(() => {
      const grid = document.querySelector('.dsh-gw-grid2')
      const fold = Array.from(document.querySelectorAll('.dsh-gw-fold')).find((node) => node.textContent.includes('效果对比（结构化编辑）'))
      const input = document.querySelector('.dsh-gw-platmulti input')
      return {
        gridBeforeMetrics: Boolean(grid && fold && (grid.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING)),
        platformValue: input?.value ?? '',
        platformInputTag: input?.tagName ?? '',
        platformMultiCount: document.querySelectorAll('.dsh-gw-platmulti').length,
      }
    })
    assert.equal(campaign.gridBeforeMetrics, true, 'Platform information must render before the metrics editor: ' + JSON.stringify(campaign))
    assert.equal(campaign.platformValue, '抖音')
    assert.equal(campaign.platformInputTag, 'INPUT')
    assert.ok(campaign.platformMultiCount > 0, 'Campaign platform must expose a typeable multi-select control')
    await page.screenshot({ path: join(runDir, 'ui-600-light-campaign-platform.png') })
    await page.close()
  })
  await check('第二批：日历预填不自动展开 / 新建账号直接选择 / 新建表单可滚到底', async () => {
    const page = await newPage('calendar', { width: 600, filled: true })
    const entry = await page.evaluate(() => window.__fixture.fixture.calendarEntries[0])
    assert.ok(entry, 'Filled calendar fixture must contain an existing schedule')
    await page.evaluate((preset) => window.__mountCalendar({ preset }), { date: entry.date, topic: entry.topic, topicPath: entry.topicPath, platform: entry.platform })
    await page.locator('.dsh-gw-cal-addform').waitFor({ state: 'attached' })
    await page.waitForTimeout(350)
    assert.equal(await page.locator('.dsh-gw-cal-addform').evaluate((node) => getComputedStyle(node).display), 'none', 'A calendar preset for an already scheduled topic must keep 新建 closed')
    await page.getByRole('button', { name: '＋ 新建排期', exact: true }).first().click()
    await page.waitForTimeout(150)
    const addForm = page.locator('.dsh-gw-cal-addform')
    assert.equal(await addForm.locator('.dsh-gw-account-candidates').count(), 0, '新建排期 must not render the account candidate search')
    const accountOptions = await addForm.locator('.dsh-gw-account-picker select').first().locator('option').allTextContents()
    assert.ok(accountOptions.some((text) => /test2 · 视频号/.test(text)), 'Account picker must list accounts from every platform: ' + JSON.stringify(accountOptions))
    await addForm.locator('.dsh-gw-account-picker select').first().selectOption('account-1')
    assert.equal(await addForm.locator('.dsh-gw-account-picker select').first().inputValue(), 'account-1', 'Account select must bind directly')
    assert.match(await addForm.locator('.dsh-gw-account-picker select').first().locator('option:checked').textContent(), /隔离账号/, 'Selected account must remain visible')
    const scroll = await page.evaluate(() => {
      const body = document.querySelector('.dsh-gw-body')
      body.scrollTop = body.scrollHeight
      return { scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }
    })
    assert.ok(scroll.scrollHeight > scroll.clientHeight, 'Calendar new form must contribute to the panel scroll height: ' + JSON.stringify(scroll))
    assert.ok(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2, 'Calendar new form must be reachable at the bottom: ' + JSON.stringify(scroll))
    await page.screenshot({ path: join(runDir, 'ui-600-light-calendar-addform-bottom.png') })
    await page.close()
  })
  await check('第六批：选题和商品搜索直接列出候选，点击即关联', async () => {
    const page = await newPage('calendar', { width: 600, filled: true })
    await page.evaluate(() => window.__mountCalendar({ height: 720 }))
    await page.locator('.dsh-gw-cal-cell[data-today="true"]').click()
    await page.getByRole('button', { name: '＋ 新建排期', exact: true }).first().click()
    const form = page.locator('.dsh-gw-cal-addform')
    const topicInput = form.locator('input[aria-label="选题名称 / 全库搜索"]')
    await topicInput.fill('长标题')
    const topicCandidate = form.locator('.dsh-gw-cal-candidate').filter({ hasText: '长标题' }).first()
    await topicCandidate.waitFor()
    assert.ok(await form.locator('.dsh-gw-cal-candidate').count() >= 2, 'Topic search must list matching candidates')
    await topicCandidate.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(runDir, 'ui-600-light-calendar-topic-candidates.png') })
    await topicCandidate.click()
    await page.waitForTimeout(80)
    assert.ok((await topicInput.inputValue()).includes('长标题'), 'Clicking a topic candidate must fill its title')
    assert.equal(await form.locator('.dsh-gw-cal-candidates').count(), 0, 'Chosen topic must close its candidate list')
    const productInput = form.locator('input[aria-label="搜索商品（含正文）"]')
    await productInput.fill('隔离商品')
    const productCandidate = form.locator('.dsh-gw-cal-candidate').filter({ hasText: '隔离商品' }).first()
    await productCandidate.waitFor()
    await productCandidate.click()
    assert.equal(await form.locator('select').filter({ has: page.locator('option[value="Products/隔离商品.md"]') }).inputValue(), 'Products/隔离商品.md', 'Clicking a product candidate must bind the product')
    await page.screenshot({ path: join(runDir, 'ui-600-light-calendar-search-candidates.png') })
    await page.close()
  })
  await check('第五批：旧选题卡不重复渲染，账号选择保留完整文本', async () => {
    const page = await newPage('calendar', { width: 600 })
    const record = await page.evaluate(() => {
      const item = {
        path: 'Topics/旧选题卡.md',
        title: '旧选题卡',
        sha1: 'old-topic-card-0',
        body: '# 主选题\n\nORIGINAL_MASTER\n\n## 选题卡\n\n- 目标人群：旧人群\n- 内容目标：旧目的\n- 一句话角度：旧角度\n',
        front: { id: 'old-topic-card', title: '旧选题卡', type: '选题', platform: '抖音', status: '在写', audience: '旧人群', goal: '旧目的', angle: '旧角度', accountId: 'account-1', account: '隔离账号' },
      }
      window.__fixture.fixture.topics.push(item)
      return item
    })
    await page.evaluate((item) => window.__mountTopic({ path: item.path, initial: item, studio: true, studioReady: true, openBody: true }), record)
    await page.locator('.dsh-gw-note-preview').waitFor()
    const preview = await page.locator('.dsh-gw-note-preview').innerText()
    assert.doesNotMatch(preview, /选题卡/, 'Legacy 选题卡 section must be hidden in the topic view')
    assert.match(preview, /ORIGINAL_MASTER/)
    const accountSelect = page.locator('.dsh-gw-account-picker select').first()
    await accountSelect.waitFor()
    const accountSelectBox = await accountSelect.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    assert.ok(accountSelectBox.width >= 120, 'Account select must be wide enough to read the full name, got ' + JSON.stringify(accountSelectBox))
    assert.ok(accountSelectBox.height >= 30, 'Account select must be tall enough to show the full line, got ' + JSON.stringify(accountSelectBox))
    await page.screenshot({ path: join(runDir, 'ui-600-light-topic-card-clean.png') })
    await page.close()
  })
  await check('第五批：排期表能随窄侧栏收缩，平台下拉贴近底部时向上展开', async () => {
    const page = await newPage('calendar', { width: 600, filled: true })
    await page.evaluate(() => window.__mountCalendar({ height: 420 }))
    const upcomingSummary = page.locator('.dsh-gw-fold > summary').filter({ hasText: '排期列表' }).first()
    await upcomingSummary.click({ position: { x: 14, y: 10 } })
    await page.locator('.dsh-gw-upcoming').waitFor()
    const fit = await page.evaluate(() => {
      const table = document.querySelector('.dsh-gw-upcoming')
      const box = table?.closest('.dsh-gw-adjustable-box')
      return table && box ? { table: table.getBoundingClientRect().width, box: box.clientWidth } : null
    })
    assert.ok(fit !== null && fit.table <= fit.box + 1, 'Upcoming table must fit its local viewport: ' + JSON.stringify(fit))
    const weekRadius = await page.locator('.dsh-gw-cal-week').first().evaluate((node) => getComputedStyle(node).borderTopLeftRadius)
    assert.equal(weekRadius, '0px', 'Calendar sticky week header must be square-cornered')
    await page.locator('.dsh-gw-cal-cell[data-today="true"]').click()
    const row = page.locator('.dsh-gw-cal-row').first()
    await row.waitFor()
    await row.locator('.dsh-gw-cal-row-links summary').click()
    assert.equal(await row.locator('.dsh-gw-more-trigger').count(), 0, 'Single schedule action must not sit behind a More menu')
    assert.equal(await row.getByRole('button', { name: '删除排期', exact: true }).count(), 1, 'Delete schedule must be directly visible')
    const linkSelectBoxes = await row.locator('.dsh-gw-cal-row-links select').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }))
    assert.ok(linkSelectBoxes.length > 0 && linkSelectBoxes.every((box) => box.width >= 120 && box.height >= 26), 'Calendar row selects must keep readable size: ' + JSON.stringify(linkSelectBoxes))
    await row.locator('.dsh-gw-cal-row-links button').first().click()
    const platform = row.locator('.dsh-gw-platmulti').first()
    await platform.waitFor()
    await platform.scrollIntoViewIfNeeded()
    await page.evaluate(() => { const body = document.querySelector('.dsh-gw-body'); body.scrollTop = body.scrollHeight })
    await page.waitForTimeout(100)
    await platform.locator('input').click()
    await page.locator('.dsh-gw-platmulti-drop').waitFor()
    const drop = await page.locator('.dsh-gw-platmulti-drop').first().boundingBox()
    const bodyBox = await page.locator('.dsh-gw-body').first().boundingBox()
    assert.ok(drop !== null && bodyBox !== null && drop.y >= bodyBox.y - 1 && drop.y + drop.height <= bodyBox.y + bodyBox.height + 1, 'Platform dropdown must stay inside the scroll viewport')
    const option = page.locator('.dsh-gw-platmulti-drop').getByRole('button', { name: '快手', exact: true })
    await option.click()
    assert.match(await platform.locator('input').inputValue(), /快手/, 'Platform option must be selectable from the open menu')
    await page.screenshot({ path: join(runDir, 'ui-600-light-calendar-platform-picker.png') })
    await page.close()
  })
  await check('排期列表每页最多 10 条，翻页按钮能切到下一页', async () => {
    const page = await newPage('calendar', { width: 600, filled: true })
    await page.evaluate(() => {
      const seed = window.__fixture.fixture.calendarEntries[0]
      window.__fixture.fixture.calendarEntries = Array.from({ length: 13 }, (_, index) => ({
        ...seed,
        id: 'pager-calendar-' + index,
        topic: '分页排期 ' + (index + 1),
      }))
      window.__mountCalendar({ height: 720 })
    })
    const summary = page.locator('.dsh-gw-fold > summary').filter({ hasText: '排期列表' }).first()
    await summary.waitFor()
    await summary.click({ position: { x: 14, y: 10 } })
    await page.locator('.dsh-gw-upcoming tbody tr').first().waitFor()
    assert.equal(await page.locator('.dsh-gw-upcoming tbody tr').count(), 10, 'First page must show at most ten schedules')
    assert.match(await page.locator('.dsh-gw-upcoming-pager-info').textContent(), /共 13 条 · 每页 10 条/)
    assert.match(await page.locator('.dsh-gw-upcoming-pager-now').textContent(), /第 1 \/ 2 页/)
    await page.locator('.dsh-gw-upcoming-pager').getByRole('button', { name: '下一页', exact: true }).click()
    assert.equal(await page.locator('.dsh-gw-upcoming tbody tr').count(), 3, 'Second page must show the remaining three schedules')
    assert.match(await page.locator('.dsh-gw-upcoming-pager-now').textContent(), /第 2 \/ 2 页/)
    await page.screenshot({ path: join(runDir, 'ui-600-light-upcoming-pager.png') })
    await page.close()
  })
  await check('日历旧排期按账号名回填账号，不再显示未指定', async () => {
    const page = await newPage('calendar', { width: 600 })
    await page.evaluate(() => {
      const fixture = window.__fixture.fixture
      fixture.calendarEntries = [{
        id: 'legacy-account-calendar',
        date: fixture.day,
        platform: '抖音',
        topic: '旧排期账号回填',
        status: '已发',
        note: '旧数据只有账号名，没有 accountId。',
        topicPath: '',
        topicId: '',
        productPath: '',
        variantId: '',
        account: '隔离账号',
        accountId: '',
      }]
      window.__mountCalendar({ height: 720 })
    })
    await page.locator('.dsh-gw-cal-cell[data-today="true"]').click()
    const row = page.locator('.dsh-gw-cal-row').first()
    await row.waitFor()
    await row.locator('.dsh-gw-cal-row-links > summary').first().click()
    const select = row.locator('.dsh-gw-account-picker select').first()
    await select.waitFor()
    assert.equal(await select.inputValue(), 'account-1', 'Legacy account name must resolve to the account record id')
    assert.match(await select.locator('option:checked').textContent(), /隔离账号/, 'Resolved account must be visible in the picker')
    await page.screenshot({ path: join(runDir, 'ui-600-light-calendar-account-resolved.png') })
    await page.close()
  })
  await check('灵感箱：只保留卡片内搜索，灵感集不再折叠', async () => {
    const page = await newPage('ideas', { width: 600, filled: true })
    await page.locator('.dsh-gw-ideas-title').waitFor()
    assert.equal((await page.locator('.dsh-gw-ideas-title').textContent()).trim(), '灵感集')
    assert.equal(await page.locator('.dsh-gw-fold > summary').filter({ hasText: '灵感' }).count(), 0, '灵感集 must not be a collapsible Fold')
    assert.equal(await page.locator('input.dsh-gw-range-search').count(), 0, '灵感箱 must not expose a second full-vault search')
    assert.equal(await page.locator('.dsh-gw-idea-search').count(), 1, '灵感箱 must keep its card-local search')
    await page.screenshot({ path: join(runDir, 'ui-600-light-ideas-clean.png') })
    await page.close()
  })
  await check('统一列表：真实拖拽列宽后仍局内滚动且不撑破页面', async () => {
    const page = await newPage('studio', { width: 600, filled: true })
    const table = page.locator('.dsh-gw-adjustable-table').first()
    await table.waitFor()
    const grips = table.locator('.dsh-gw-col-grip')
    assert.ok(await grips.count() >= 2, 'Adjustable list must expose resize grips')
    const firstTh = table.locator('thead th').first()
    const beforeWidth = (await firstTh.boundingBox()).width
    const grip = await grips.first().boundingBox()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + grip.height / 2, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(150)
    const afterWidth = (await firstTh.boundingBox()).width
    assert.ok(afterWidth <= beforeWidth - 20, 'Dragging a column edge must narrow its column: ' + beforeWidth + ' -> ' + afterWidth)
    const geometry = await page.evaluate(() => {
      const box = document.querySelector('.dsh-gw-adjustable-box')
      const cells = Array.from(document.querySelectorAll('.dsh-gw-adjustable-table td')).slice(0, 20)
      return {
        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
        localScroll: box.scrollWidth > box.clientWidth,
        confined: cells.every((cell) => getComputedStyle(cell).overflow === 'hidden'),
      }
    })
    assert.ok(geometry.bodyOverflow <= 1, 'Resized table must not widen the page: ' + JSON.stringify(geometry))
    assert.ok(geometry.confined, 'Resized cells must clip or ellipsize content: ' + JSON.stringify(geometry))
    await page.screenshot({ path: join(runDir, 'ui-600-light-studio-resized.png') })
    await page.close()
  })
  if (!process.argv.includes('--smoke')) {
    await check('日历读取软 warning 显式显示；重试恢复而非假装空表', async () => {
      const page = await newPage('calendar')
      // Associate the warning with the deliberate refresh, never with an initial
      // load that a newer successful read is legitimately allowed to supersede.
      await page.waitForFunction(() => { const reads = window.__fixture.requests.filter((request) => request.path === '/calendar' && request.method === 'GET'); return reads.length > 0 && reads.every((request) => request.completed) })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const before = await page.evaluate(() => window.__fixture.requests.at(-1)?.id || 0)
      await page.evaluate(() => window.__fixture.queue({path:'/calendar', method:'GET', response:{ok:true, entries:[], exists:true, path:'Workbench/发布排期/2026-11.md', sha1:'calendar-warning', warning:'ISOLATED_TABLE_READ_FAILED', code:'read_failed'}}))
      await page.getByRole('button', {name:'刷新', exact:true}).click()
      await page.waitForFunction((checkpoint) => window.__fixture.requests.some((request) => request.id > checkpoint && request.path === '/calendar' && request.completed && request.fixtureRule?.warning === 'ISOLATED_TABLE_READ_FAILED'), before)
      await page.getByText('ISOLATED_TABLE_READ_FAILED', {exact:false}).first().waitFor()
      const warningRead = await page.evaluate(() => window.__fixture.requests.find((request) => request.fixtureRule?.warning === 'ISOLATED_TABLE_READ_FAILED'))
      assert(warningRead.id > before, 'The warning must belong to the explicit refresh, not the initial request')
      await page.getByRole('button', {name:'重试', exact:true}).first().click()
      await page.waitForFunction((warningId) => !document.body.textContent.includes('ISOLATED_TABLE_READ_FAILED') && window.__fixture.requests.some((request) => request.id > warningId && request.path === '/calendar' && request.method === 'GET' && request.completed && !request.responseSummary?.warning), warningRead.id)
      assert.deepEqual(await page.evaluate(() => window.__fixture.unknown), [])
      if (traceCalendar) writeFileSync(join(runDir, 'calendar-measurements.json'), JSON.stringify(await page.evaluate(() => window.__calendarMeasurements), null, 2) + '\n')
      await page.close()
    })
    if (!calendarOnly) {
    await check('超过首批上限可继续载入；过滤重新向服务端搜索全库', async () => {
      const page = await newPage('topics')
      await page.evaluate(() => { window.__fixture.fixture.topics = Array.from({length:401}, (_, index) => ({path:'Topics/案例' + index + '.md', title:'案例' + index, sha1:'case-' + index, body:'CASE_' + index, front:{id:'case-' + index, title:'案例' + index, type:'拆解', platform:'抖音'}})) })
      await page.getByRole('button', {name:'刷新', exact:true}).click()
      await page.waitForFunction(() => document.querySelector('.dsh-gw-list-range')?.textContent.includes('/ 401 条'))
      for (let count = 0; count < 5 && await page.getByRole('button', {name:'载入下一批', exact:true}).count(); count += 1) {
        await page.getByRole('button', {name:'载入下一批', exact:true}).click()
        await page.waitForFunction(() => !document.querySelector('.dsh-gw-list-range button')?.disabled)
      }
      await page.waitForFunction(() => document.querySelector('.dsh-gw-list-range')?.textContent.includes('401 / 401'))
      await page.locator('.dsh-gw-listfilter-btn').first().click()
      await page.locator('.dsh-gw-listfilter-input').fill('案例400')
      await page.waitForFunction(() => window.__fixture.requests.some((item) => item.path === '/topics/list' && new URLSearchParams(item.query).get('q') === '案例400'))
      await page.waitForFunction(() => document.querySelector('.dsh-gw-list-range')?.textContent.includes('1 / 1'))
      assert.deepEqual(await page.evaluate(() => window.__fixture.unknown), [])
      await page.close()
    })
    await check('表头支持键盘排序；440 / 520 窄面板没有外溢内容', async () => {
      const page = await newPage('studio')
      const header = page.locator('th[aria-sort]').first()
      await header.waitFor()
      const before = await header.getAttribute('aria-sort')
      const button = header.locator('button').first()
      if (await button.count()) await button.press('Enter'); else await header.press('Enter')
      assert.notEqual(await header.getAttribute('aria-sort'), before)
      for (const width of [440, 520]) {
        await page.evaluate((value) => { document.getElementById('root').style.width = value + 'px' }, width)
        await page.waitForTimeout(100)
        const geometry = await page.evaluate(() => { const node = document.querySelector('.dsh-gw-body'); return {width:node.clientWidth, scroll:node.scrollWidth} })
        assert.ok(geometry.scroll <= geometry.width + 2, 'Unintended body overflow at ' + width + ': ' + JSON.stringify(geometry))
        await page.screenshot({path:join(runDir, 'studio-' + width + '.png')})
      }
      await page.close()
    })
    await check('真实失焦保存只发字段；第二次保存使用成功响应的 sha1', async () => {
      const page = await newPage()
      await page.evaluate(() => { window.__fixture.queue({ path:'/topics/record', method:'PUT', hold:true }); window.__mountTopic() })
      const audience = page.getByPlaceholder('这条说给谁听')
      const goal = page.getByPlaceholder('想让他看完做什么')
      await audience.fill('新的目标人群')
      await goal.fill('新的内容目标')
      await page.getByPlaceholder('这条凭什么值得看').focus()
      await page.waitForFunction(() => window.__fixture.pending().some((item) => item.method === 'PUT'))
      const first = await page.evaluate(() => window.__fixture.pending().find((item) => item.method === 'PUT'))
      assert.deepEqual(Object.keys(first.body).sort(), ['expectedSha1', 'front'])
      assert.deepEqual(first.body.front, { audience:'新的目标人群' })
      assert.equal(first.body.expectedSha1, 'master-0')
      assert.equal(await page.evaluate(() => window.__fixture.requests.filter((item) => item.method === 'PUT' && item.path === '/topics/record').length), 1, 'Second patch escaped the FIFO queue')
      await page.evaluate((id) => window.__fixture.release(id), first.id)
      await page.waitForFunction(() => window.__fixture.requests.filter((item) => item.method === 'PUT' && item.path === '/topics/record').length === 2)
      const second = await page.evaluate(() => window.__fixture.requests.filter((item) => item.method === 'PUT' && item.path === '/topics/record')[1])
      assert.deepEqual(Object.keys(second.body).sort(), ['expectedSha1', 'front'])
      assert.deepEqual(second.body.front, { goal:'新的内容目标' })
      assert.equal(second.body.expectedSha1, 'topics-1')
      assert.equal(await page.evaluate(() => window.__fixture.fixture.topics[0].body), '# 主选题\n\nORIGINAL_MASTER')
      await page.waitForFunction(() => window.__testRegistry.allow('test successful save'))
      await page.close()
    })
    await check('字段保存失败保留输入和草稿；再次失焦可以重试', async () => {
      const page = await newPage()
      await page.evaluate(() => { window.__fixture.queue({ path:'/topics/record', method:'PUT', error:'模拟保存失败' }); window.__mountTopic() })
      const input = page.getByPlaceholder('这条说给谁听')
      await input.fill('失败也要保留的草稿')
      await page.getByPlaceholder('想让他看完做什么').focus()
      await page.waitForFunction(() => window.__notices.some((text) => text.includes('模拟保存失败')) || document.body.innerText.includes('模拟保存失败'))
      assert.equal(await input.inputValue(), '失败也要保留的草稿')
      assert.equal(await page.evaluate(() => window.__testRegistry.allow('unsafe close')), false)
      assert.equal(await page.evaluate(() => window.__fixture.fixture.topics[0].front.audience), '旧人群')
      await input.focus()
      await page.getByPlaceholder('想让他看完做什么').focus()
      await page.waitForFunction(() => window.__fixture.fixture.topics[0].front.audience === '失败也要保留的草稿')
      await page.close()
    })
    await check('首屏迟到的权威读取不覆盖已经编辑的正文', async () => {
      const page = await newPage()
      await page.evaluate(() => {
        const initial = JSON.parse(JSON.stringify(window.__fixture.fixture.topics[0]))
        window.__fixture.updateMaster({ sha1:'remote-new', body:'# 外部版本\n\nREMOTE_MASTER' })
        window.__fixture.queue({ path:'/topics/record', method:'GET', hold:true })
        window.__mountTopic({ initial })
      })
      const editor = page.locator('.dsh-gw-live-body[contenteditable="true"]').first()
      await editor.fill('DRAFT_KEEP')
      const read = await page.evaluate(() => window.__fixture.pending().find((item) => item.path === '/topics/record' && item.method === 'GET'))
      assert.ok(read, 'Controlled initial read not held')
      await page.evaluate((id) => window.__fixture.release(id), read.id)
      await page.waitForTimeout(100)
      assert.match(await editor.innerText(), /DRAFT_KEEP/)
      assert.doesNotMatch(await editor.innerText(), /REMOTE_MASTER/)
      assert.equal(await page.evaluate(() => window.__testRegistry.allow('unsafe close')), false)
      await page.close()
    })
    await check('版本 A/B 读取反序完成，只显示最后选择的 B', async () => {
      const page = await newPage()
      await page.evaluate(() => {
        window.__fixture.queue({ path:'/v2/variants/variant-A', method:'GET', hold:true })
        window.__fixture.queue({ path:'/v2/variants/variant-B', method:'GET', hold:true })
        window.__mountTopic({ openVariantId:'variant-A', openVariantRequest:1 })
      })
      await page.waitForFunction(() => window.__fixture.pending().some((item) => item.path === '/v2/variants/variant-A'))
      await page.evaluate(() => window.__mountTopic({ openVariantId:'variant-B', openVariantRequest:2 }))
      await page.waitForFunction(() => window.__fixture.pending().some((item) => item.path === '/v2/variants/variant-B'))
      const pending = await page.evaluate(() => window.__fixture.pending())
      await page.evaluate((id) => window.__fixture.release(id), pending.find((item) => item.path.endsWith('variant-B')).id)
      const bodySelector = '.dsh-gw-note-preview .dsh-gw-live-md'
      // LiveMarkdown renders one live-body per block: the first block is the
      // heading, not the entire script. Assert the current document container.
      await page.waitForFunction((selector) => Array.from(document.querySelectorAll(selector), (node) => node.textContent).join('\n').includes('SCRIPT_B'), bodySelector)
      await page.evaluate((id) => window.__fixture.release(id), pending.find((item) => item.path.endsWith('variant-A')).id)
      await page.waitForTimeout(100)
      const renderedBody = (await page.locator(bodySelector).allTextContents()).join('\n')
      assert.match(renderedBody, /SCRIPT_B/)
      assert.doesNotMatch(renderedBody, /SCRIPT_A/)
      await page.close()
    })
    await check('新建平台版本的账号只从下拉框选择', async () => {
      const page = await newPage('calendar', { width: 600 })
      await page.evaluate(() => window.__mountVariants())
      const accountPicker = page.locator('.dsh-gw-account-picker').last()
      await accountPicker.locator('select').waitFor()
      assert.equal(await accountPicker.locator('button').count(), 0, 'Platform version account must not offer a create button')
      assert.equal(await page.locator('summary', { hasText: '查找账号' }).count(), 0, 'Platform version account must not offer account search')
      const box = await accountPicker.locator('select').evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      })
      assert.ok(box.width >= 120 && box.height >= 30, 'Platform version account select must be readable, got ' + JSON.stringify(box))
      await page.screenshot({ path: join(runDir, 'ui-600-light-version-account-picker.png') })
      await page.close()
    })
    await check('我的选题详情能正常打开，并显示两张新建卡片', async () => {
      const page = await newPage('studio', { width: 600 })
      await page.locator('button[title="隔离测试选题"]').click()
      await page.getByRole('button', { name: '＋ 新建' }).waitFor()
      assert.equal(await page.locator('.dsh-gw-crash').count(), 0, 'Opening a topic must not hit the crash boundary')
      assert.ok(await page.locator('.dsh-gw-create-card').count() >= 1, 'New-topic card should render in the detail')
      await page.getByRole('button', { name: '＋ 新建' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.dsh-gw-create-card').length >= 2)
      assert.match(await page.locator('.dsh-gw-create-card').first().innerText(), /新建选题/)
      assert.match(await page.locator('.dsh-gw-platform-create').innerText(), /新建平台版本/)
      await page.screenshot({ path: join(runDir, 'ui-600-light-studio-create-cards.png') })
      await page.close()
    })
    await check('新建选题和新建平台版本分成两个独立卡片', async () => {
      const page = await newPage('calendar', { width: 600 })
      await page.evaluate(() => window.__mountVariants({ newTopicForm: React.createElement('div', { className: 'fake-topic-form' }, '新建选题表单') }))
      const cards = page.locator('.dsh-gw-create-card')
      await cards.first().waitFor()
      await page.waitForFunction(() => document.querySelectorAll('.dsh-gw-create-card').length >= 2)
      const cardTexts = await cards.allTextContents()
      assert.ok(cardTexts.length >= 2, 'Expected separate new-topic and new-platform cards, got ' + JSON.stringify(cardTexts))
      assert.match(cardTexts[0], /新建选题/)
      assert.match(cardTexts[1], /新建平台版本/)
      assert.ok((await cards.nth(0).getAttribute('class')).includes('dsh-gw-create-card'))
      await page.screenshot({ path: join(runDir, 'ui-600-light-create-cards.png') })
      await page.close()
    })
    await check('版本脚本标题与操作按钮合并成一行', async () => {
      const page = await newPage('studio', { width: 600 })
      await page.evaluate(() => window.__mountTopic({ openVariantId: 'variant-A', openVariantRequest: 1, openBody: true }))
      await page.waitForFunction(() => document.querySelector('.dsh-gw-note-title')?.textContent === '版本脚本')
      await page.waitForFunction(() => (document.querySelector('.dsh-gw-note-preview')?.textContent || '').includes('SCRIPT_A'))
      const head = page.locator('.dsh-gw-note-sectionhead')
      assert.match(await head.innerText(), /版本脚本/)
      assert.equal(await head.locator('.dsh-gw-note-title').count(), 1)
      assert.match(await head.innerText(), /已保存|发送至Agent/)
      const preview = page.locator('.dsh-gw-note-preview')
      assert.doesNotMatch(await preview.innerText(), /^版本脚本$/m)
      await page.screenshot({ path: join(runDir, 'ui-600-light-version-script-header.png') })
      await page.close()
    })
    await check('普通笔记也注册草稿守卫；重新读取不丢编辑内容', async () => {
      const page = await newPage()
      await page.evaluate(() => window.__mountNote())
      const editor = page.locator('.dsh-gw-live-body[contenteditable="true"]').first()
      await editor.fill('NOTE_DRAFT_KEEP')
      assert.equal(await page.evaluate(() => window.__testRegistry.allow('unsafe close')), false)
      await page.evaluate(() => { window.__fixture.fixture.data[0].body = 'REMOTE_NOTE'; window.__fixture.fixture.data[0].sha1 = 'remote-note'; window.__refreshDetail() })
      await page.waitForTimeout(100)
      assert.match(await editor.innerText(), /NOTE_DRAFT_KEEP/)
      await page.close()
    })
    await check('确认弹窗焦点限制在按钮内；Esc 取消并归还焦点', async () => {
      const page = await newPage()
      await page.evaluate(() => window.__mountConfirm())
      await page.getByRole('dialog', { name:'确认一下' }).waitFor()
      await page.waitForFunction(() => document.activeElement?.textContent === '保留')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '确定')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '保留')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => window.__dialogDone === false && document.activeElement?.id === 'focus-restore-target')
      await page.close()
    })
    await check('吸顶顶栏在独立面板里也是直角', async () => {
      const page = await newPage(undefined, { width: 600, theme: 'dark' })
      await page.evaluate(() => document.getElementById('root').classList.remove('dsh-gw-pane'))
      await page.getByText('灵感箱', { exact: true }).click()
      await page.locator('.dsh-gw-card-crumb').waitFor()
      const radii = await page.evaluate(() => {
        const panel = document.querySelector('.dsh-gw-panel')
        const crumb = document.querySelector('.dsh-gw-card-crumb')
        const style = (node) => ({ topLeft: getComputedStyle(node).borderTopLeftRadius, topRight: getComputedStyle(node).borderTopRightRadius })
        return { panel: style(panel), crumb: style(crumb) }
      })
      assert.deepEqual(radii.panel, { topLeft: '0px', topRight: '0px' })
      assert.deepEqual(radii.crumb, { topLeft: '0px', topRight: '0px' })
      await page.screenshot({ path: join(runDir, 'ui-sticky-square.png') })
      await page.close()
    })
    for (const width of [440, 520, 600]) for (const theme of ['light', 'dark']) {
      await check('UI 浅深主题与真实内容密度：' + width + 'px / ' + theme, async () => {
        const options = { width, theme, filled: true }, evidence = { width, theme, simulatedHostAliases: true, pages: {} }
        const verifyBounds = (audit, label) => {
          assert(audit.pageOverflow <= 1, label + ': whole page overflows horizontally')
          assert(audit.bodyOverflow <= 1, label + ': scroll must remain inside the local table container')
          assert(Math.abs(audit.frameWidth - width) <= 2.1, label + ': requested panel width was not applied')
        }
        let page = await newPage(undefined, options)
        await page.getByText('账号档案', { exact: true }).waitFor()
        evidence.pages.home = await page.evaluate(layoutAudit); verifyBounds(evidence.pages.home, 'home')
        await page.screenshot({ path: join(runDir, 'ui-' + width + '-' + theme + '-home.png') }); await page.close()

        page = await newPage('studio', options)
        await page.locator('th[aria-sort]').first().waitFor()
        await page.waitForTimeout(150)
        evidence.pages.studio = await page.evaluate(layoutAudit); verifyBounds(evidence.pages.studio, 'studio')
        assert(evidence.pages.studio.creators.length > 0, 'A real primary authoring action must be present')
        for (const button of evidence.pages.studio.creators) {
          assert.equal(button.lines, 1, 'Primary action wraps: ' + button.text)
          assert(button.height >= 27.5, 'Primary action target is smaller than 28px: ' + button.text)
          assert(button.contrast >= 4.5, 'Primary normal-size text contrast below 4.5: ' + button.text + ' = ' + button.contrast)
        }
        await page.screenshot({ path: join(runDir, 'ui-' + width + '-' + theme + '-studio.png') }); await page.close()

        page = await newPage('calendar', options)
        await page.locator('.dsh-gw-cal-cell[data-today="true"]').click()
        await page.locator('.dsh-gw-cal-row').first().waitFor()
        assert((await page.locator('.dsh-gw-cal-row').count()) >= 6, 'Filled calendar day list did not render all distinct versions')
        assert((await page.locator('.dsh-gw-cal-row').allTextContents()).some((text) => text.includes('长标题：')), 'Long title identity is missing from the selected day list')
        evidence.pages.calendar = await page.evaluate(layoutAudit); verifyBounds(evidence.pages.calendar, 'calendar')
        await page.screenshot({ path: join(runDir, 'ui-' + width + '-' + theme + '-calendar.png') }); await page.close()

        page = await newPage('pending', options)
        await page.locator('.dsh-gw-pending-table tbody tr').first().waitFor()
        assert.equal(await page.locator('.dsh-gw-pending-table th').count(), 10, 'Do not remove data columns to fit the narrow frame')
        evidence.pages.pending = await page.evaluate(layoutAudit); verifyBounds(evidence.pages.pending, 'pending')
        const table = page.locator('.dsh-gw-pending-box').first()
        assert(await table.evaluate((node) => node.scrollWidth > node.clientWidth), 'Narrow table must scroll locally rather than overflow the whole page')
        await table.evaluate((node) => { node.scrollLeft = node.scrollWidth })
        const identity = page.locator('.dsh-gw-pending-table tbody tr').first().locator('td').nth(2)
        const identityState = await identity.evaluate((node) => ({ position: getComputedStyle(node).position, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))
        const bounds = await table.boundingBox()
        assert.equal(identityState.position, 'sticky', 'Identity column must remain visible during local horizontal scroll')
        assert(identityState.left >= bounds.x - 1 && identityState.right <= bounds.x + bounds.width + 1, 'Sticky identity escaped the local viewport')
        const numeric = await page.locator('.dsh-gw-pending-table tbody tr').first().locator('td').nth(4).evaluate((node) => getComputedStyle(node.querySelector('span') || node).fontVariantNumeric)
        assert(numeric.includes('tabular-nums'), 'Metric values need tabular numerals')
        evidence.pages.pending.identity = identityState
        await page.screenshot({ path: join(runDir, 'ui-' + width + '-' + theme + '-pending.png') })
        assert.equal(await page.locator('.dsh-gw-crash').count(), 0)
        assert.deepEqual(await page.evaluate(() => window.__fixture.unknown), [], 'Filled UI fixture must remain self-contained')
        await page.close()
        return evidence
      })
    }
    }
  }
  assert.deepEqual(pageErrors, [], 'Uncaught browser error')
  assert.deepEqual(warnings, [], 'Browser console warning/error')
  assert.equal(outcomes.filter((item) => item.status === 'failed').length, 0, 'One or more browser scenarios failed; inspect report.json')
  assert.equal(hash(readFileSync(clientPath, 'utf8')), clientHash, 'Client changed while this browser snapshot was being tested; rerun the final version')
} finally {
  writeFileSync(reportPath, JSON.stringify({ clientPath, clientHash, clientUnchanged: hash(readFileSync(clientPath, 'utf8')) === clientHash, scenarios: outcomes, pageErrors, warnings, fixturePath, mode: calendarOnly ? 'calendar-diagnostic' : process.argv.includes('--smoke') ? 'smoke' : 'full', measurementInstrumented: traceCalendar, isolated: true, liveApiUsed: false }, null, 2) + '\n')
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  if (processHandle.exitCode === null) processHandle.kill()
  await Promise.race([new Promise((resolve) => processHandle.once('exit', resolve)), pause(2000)])
  // Only the generated profile of this owned Chrome process is disposable.
  const checkedProfile = resolve(chromeProfile)
  assert.equal(dirname(checkedProfile), resolve(runDir))
  assert.equal(dirname(resolve(runDir)), resolve(outputBase))
  assert.equal(checkedProfile, join(resolve(runDir), 'chrome-profile'))
  if (existsSync(checkedProfile)) rmSync(checkedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log('Browser evidence: ' + reportPath)
}
console.log(outcomes.length + ' browser scenarios passed')
