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
const clientPath = join(repo, 'client.js')
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
const month = new Date().toISOString().slice(0, 7)
const title = '隔离测试选题'
const topicPath = 'Topics/隔离测试选题.md'
const cards = [
  ['accounts', 'ops', '账号档案'], ['ideas', 'ops', '灵感箱'], ['topics', 'ops', '爆款拆解（别人的）'], ['studio', 'ops', '我的选题'],
  ['calendar', 'ops', '内容日历'], ['pending', 'ops', '待回填数据'], ['contentdata', 'ops', '数据复盘'],
  ['products', 'ecom', '商品 / 竞品库'], ['data', 'ecom', '电商数据复盘'], ['feedback', 'ecom', '客户反馈库'],
  ['campaigns', 'mkt', '营销方案库'], ['sop', 'common', 'SOP 树'], ['glossary', 'common', '术语表'], ['copyrules', 'common', '文案规则 / 语调库'],
].map(([id, workspace, title]) => ({ id, workspace, title, icon: '', enabled: true }))
const fixtures = {
  cards, month, title, topicPath,
  topics: [
    { path: topicPath, title, sha1: 'master-0', body: '# 主选题\n\nORIGINAL_MASTER', front: { id: 'master-1', title, type: '选题', platform: '抖音', status: '在写', audience: '旧人群', purpose: '旧目的', materials: '旧素材', accountId: 'account-1', account: '隔离账号' } },
    { path: 'Topics/隔离测试拆解.md', title: '隔离测试拆解', sha1: 'case-0', body: '# 案例\n\nCASE_BODY', front: { id: 'master-2', title: '隔离测试拆解', type: '拆解', platform: '抖音' } },
  ],
  variants: ['A', 'B'].map((name) => ({ id: 'variant-' + name, path: 'Workbench/平台版本/master-1/抖音-' + name + '.md', sha1: 'variant-' + name + '-0', body: '# 版本' + name + '\n\nSCRIPT_' + name, front: { id: 'variant-' + name, masterId: 'master-1', title: '隔离测试选题', platform: '抖音', status: '在写', accountId: 'account-1', account: '隔离账号', audience: '版本人群' } })),
  accounts: [{ path: 'Accounts/隔离账号.md', title: '隔离账号', sha1: 'account-0', body: '# 账号', front: { id: 'account-1', name: '隔离账号', platform: '抖音', status: '启用' } }],
  products: [{ path: 'Products/隔离商品.md', title: '隔离商品', sha1: 'product-0', body: '# 商品', front: { id: 'product-1', name: '隔离商品', kind: '竞品', category: '测试', price: 20 } }],
  data: [{ path: 'Data/隔离复盘.md', title: '隔离复盘', sha1: 'data-0', body: '# 复盘\n\nDATA_BODY', front: { id: 'data-1', period: month, channel: '内容', platform: '抖音', views: 1200, likes: 50 } }],
  campaigns: [{ path: 'Campaigns/隔离方案.md', title: '隔离方案', sha1: 'campaign-0', body: '# 方案\n\nCAMPAIGN_BODY', front: { id: 'campaign-1', title: '隔离方案', status: '筹备' } }],
}
function inBrowser(fixture) {
  const copy = (value) => JSON.parse(JSON.stringify(value))
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
    if (path === '/overview') return { ok: true, summary: { sopNotes:0, contentDataCount:0, contentDataLatest:'', topics:fixture.topics.length, topicsDoing:1, topicsScripted:0, campaignsActive:0, campaignsTotal:fixture.campaigns.length, productsMine:0, productsRival:fixture.products.length, dataLatest:fixture.month, dataCount:fixture.data.length, ideasNew:0, ideasTotal:0, glossary:0, feedbackNegativeOpen:0, feedbackTotal:0, pendingCount:0, calendarMonth:fixture.month, calendarPending:0, calendarTotal:0, ruleCounts:{hard:0,soft:0,watch:0} } }
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
    if (path === '/v2/ledger') return { ok: true, rows: [], schema: [] }
    if (path === '/v2/pending') return { ok: true, items: [] }
    if (path === '/calendar') return { ok: true, rows: [], entries: [], schema: [], month: query.get('month') || fixture.month, path: 'Calendar/' + fixture.month + '.md', sha1: 'calendar-0' }
    if (path === '/ideas' || path === '/feedback' || path === '/glossary') return { ok: true, entries: [], rows: [], schema: [], path: 'Workbench/isolated.md', sha1: 'table-0' }
    if (path === '/rules') return { ok: true, items: [], sections: [], sha1: 'rules-0', body: '# 硬规则\n\n# 软规则\n\n# 待观察' }
    if (path === '/sop') return { ok: true, root: 'SOP', notes: [], entries: [], tree: [] }
    if (path === '/sop/search') return { ok: true, matches: [] }
    if (path === '/boards') return { ok: true, content: [], unmeasured: [], roi: [] }
    if (path === '/product-rollup') return { ok: true, rows: [], products: [] }
    if (path === '/search') return { ok: true, matches: [], total: 0, scope: query.get('scope') || 'workbench' }
    unknown.push({ path, method }); return { ok: false, code: 'bad_request', message: 'Unhandled isolated route: ' + method + ' ' + path }
  }
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), 'http://isolated.invalid')
    const path = url.pathname.replace(/^\/api\/dsh-growth/, '')
    const method = String(options.method || 'GET').toUpperCase()
    const body = options.body ? JSON.parse(options.body) : {}
    const request = { id: ++serial, path, query: url.search, method, body: copy(body) }
    requests.push(request)
    const at = rules.findIndex((rule) => rule.path === path && (!rule.method || rule.method === method))
    const rule = at === -1 ? null : rules.splice(at, 1)[0]
    if (rule?.error) return response({ ok: false, code: rule.code || 'read_failed', message: rule.error }, 500)
    const result = copy(rule?.response === undefined ? route(path, method, url.searchParams, body) : rule.response)
    if (rule?.hold) return new Promise((resolve) => { held.set(request.id, { request, result, resolve }) })
    return response(result, result.ok === false ? (result.code === 'conflict' ? 409 : 400) : 200)
  }
  window.EventSource = class {
    constructor(url) { this.url = url; this.listeners = new Map(); window.__eventSources.push(this) }
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    removeEventListener(name) { this.listeners.delete(name) }
    close() { this.closed = true }
  }
  window.__eventSources = []
  window.__fixture = {
    fixture, requests, unknown,
    queue(rule) { rules.push(rule) },
    pending() { return Array.from(held.values(), ({ request }) => request) },
    release(id, result) { const item = held.get(id); if (!item) throw new Error('No held request ' + id); held.delete(id); item.resolve(response(result || item.result, result?.ok === false ? 500 : 200)) },
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
const browserClient = clientSource.replace('const exports_ = {', 'const exports_ = { __test: { TopicDetail, NoteDetail, ConfirmDialog, DraftContext, RefreshContext, createDraftRegistry },')
assert.notEqual(browserClient, clientSource, 'Private test export anchor changed; update the fixture explicitly')
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
async function newPage(card) {
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push({ card, message: error.message }))
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') warnings.push({ card, message: message.text() }) })
  await page.route('**/*', (route) => route.request().url().startsWith('file:') ? route.continue() : route.abort())
  await page.goto(pathToFileURL(fixturePath).href + (card ? '?card=' + encodeURIComponent(card) : ''))
  await page.waitForSelector('.dsh-gw-body')
  await page.waitForFunction(() => !document.body.textContent.includes('连接工作台…'))
  return page
}
async function check(name, fn) {
  try { await fn(); outcomes.push({ name, status: 'passed' }); console.log('✓ ' + name) }
  catch (error) {
    const evidence = { name, status: 'failed', error: String(error.stack || error) }
    const page = context?.pages().at(-1)
    if (page) {
      evidence.screenshot = join(runDir, 'failed-' + outcomes.length + '.png')
      await page.screenshot({ path: evidence.screenshot }).catch(() => {})
      evidence.dom = await page.evaluate(() => ({ text: document.body.innerText, buttons: Array.from(document.querySelectorAll('button'), (node) => ({ text: node.textContent, label: node.getAttribute('aria-label'), title: node.title })) })).catch(() => null)
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
  if (!process.argv.includes('--smoke')) {
    await check('日历读取软 warning 显式显示；重试恢复而非假装空表', async () => {
      const page = await newPage('calendar')
      await page.evaluate(() => window.__fixture.queue({path:'/calendar', method:'GET', response:{ok:true, entries:[], exists:true, path:'Workbench/发布排期/2026-11.md', sha1:'calendar-warning', warning:'ISOLATED_TABLE_READ_FAILED', code:'read_failed'}}))
      await page.getByRole('button', {name:'刷新', exact:true}).click()
      await page.getByText('ISOLATED_TABLE_READ_FAILED', {exact:false}).first().waitFor()
      await page.getByRole('button', {name:'重试', exact:true}).first().click()
      await page.waitForFunction(() => !document.body.textContent.includes('ISOLATED_TABLE_READ_FAILED'))
      assert.deepEqual(await page.evaluate(() => window.__fixture.unknown), [])
      await page.close()
    })
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
      await page.waitForFunction(() => document.querySelector('.dsh-gw-live-body')?.textContent.includes('SCRIPT_B'))
      await page.evaluate((id) => window.__fixture.release(id), pending.find((item) => item.path.endsWith('variant-A')).id)
      await page.waitForTimeout(100)
      assert.match(await page.locator('.dsh-gw-live-body').first().innerText(), /SCRIPT_B/)
      assert.doesNotMatch(await page.locator('.dsh-gw-live-body').first().innerText(), /SCRIPT_A/)
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
  }
  assert.deepEqual(pageErrors, [], 'Uncaught browser error')
  assert.equal(outcomes.filter((item) => item.status === 'failed').length, 0, 'One or more browser scenarios failed; inspect report.json')
  assert.equal(hash(readFileSync(clientPath, 'utf8')), clientHash, 'Client changed while this browser snapshot was being tested; rerun the final version')
} finally {
  writeFileSync(reportPath, JSON.stringify({ clientHash, clientUnchanged: hash(readFileSync(clientPath, 'utf8')) === clientHash, scenarios: outcomes, pageErrors, warnings, fixturePath, mode: process.argv.includes('--smoke') ? 'smoke' : 'full', isolated: true, liveApiUsed: false }, null, 2) + '\n')
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
