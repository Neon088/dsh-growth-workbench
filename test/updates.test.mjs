// 「检查更新」的纯逻辑：版本比较不能猜错（0.10.0 比 0.2.0 新、预发布版排正式版前面），
// Release 解释要能扛住 404 / 限流 / 网络断 / 认不出的 tag。全程不连网：fetch 由测试注入。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { authHeaders } from './_auth-token.mjs'

import {
  API_LATEST,
  REPO,
  RELEASES_PAGE,
  compareVersions,
  fetchLatestRelease,
  interpretRelease,
  isNewer,
  parseVersion,
  trimNotes,
} from '../lib/updates.js'

let checks = 0
const ok = (label, run) => {
  run()
  checks += 1
  void label
}

const here = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

// ── 仓库地址与 package.json 对得上（改了 owner 不会只改一半） ──
assert.equal(REPO, 'Neon088/dsh-growth-workbench')
assert.equal(API_LATEST, 'https://api.github.com/repos/Neon088/dsh-growth-workbench/releases/latest')
assert.equal(RELEASES_PAGE, 'https://github.com/Neon088/dsh-growth-workbench/releases')
assert.equal(String(pkg.repository?.url ?? '').includes(REPO), true, 'package.json 的 repository 指向同一个仓库')

// ── parseVersion ──
ok('parse 0.2.1', () => assert.deepEqual(parseVersion('0.2.1'), { numbers: [0, 2, 1], pre: [] }))
ok('parse v0.2.1（tag 带 v）', () => assert.deepEqual(parseVersion('v0.2.1'), { numbers: [0, 2, 1], pre: [] }))
ok('parse 1.2（缺 patch 补 0）', () => assert.deepEqual(parseVersion('1.2'), { numbers: [1, 2, 0], pre: [] }))
ok('parse 空串', () => assert.equal(parseVersion(''), null))
ok('parse 非数字', () => assert.equal(parseVersion('nightly'), null))
ok('parse 四段不猜', () => assert.equal(parseVersion('1.2.3.4'), null))
ok('parse build 元数据不猜', () => assert.equal(parseVersion('0.2.1+build.7'), null))
ok('parse 预发布', () => assert.deepEqual(parseVersion('0.2.1-rc.1'), { numbers: [0, 2, 1], pre: ['rc', '1'] }))
ok('parse 当前 package.json 版本', () => assert.notEqual(parseVersion(pkg.version), null))

// ── compareVersions ──
ok('0.10.0 > 0.2.0（字典序会判反）', () => assert.equal(compareVersions('0.10.0', '0.2.0'), 1))
ok('0.2.0 = 0.2.0', () => assert.equal(compareVersions('0.2.0', '0.2.0'), 0))
ok('v 前缀不影响比较', () => assert.equal(compareVersions('v0.2.0', '0.2.0'), 0))
ok('0.3.0 > 0.2.99', () => assert.equal(compareVersions('0.3.0', '0.2.99'), 1))
ok('正式版 > 同号预发布', () => assert.equal(compareVersions('0.2.1', '0.2.1-rc.1'), 1))
ok('预发布 rc.1 < rc.2', () => assert.equal(compareVersions('0.2.1-rc.1', '0.2.1-rc.2'), -1))
ok('alpha < alpha.1（短的在前）', () => assert.equal(compareVersions('0.2.1-alpha', '0.2.1-alpha.1'), -1))
ok('数字标识符排在字母前', () => assert.equal(compareVersions('0.2.1-1', '0.2.1-alpha'), -1))
ok('认不出就不猜：返回 0', () => assert.equal(compareVersions('nightly', '0.2.1'), 0))

// ── isNewer ──
ok('isNewer 新版本', () => assert.equal(isNewer('0.2.2', '0.2.1'), true))
ok('isNewer 同版本', () => assert.equal(isNewer('0.2.1', '0.2.1'), false))
ok('isNewer 旧版本', () => assert.equal(isNewer('0.2.0', '0.2.1'), false))

// ── trimNotes ──
ok('trimNotes 空正文', () => assert.equal(trimNotes(null), ''))
ok('trimNotes 多空行压成一行空行', () => assert.equal(trimNotes('a\n\n\n\nb'), 'a\n\nb'))
ok('trimNotes 超长截断', () => {
  const notes = trimNotes('x'.repeat(2000))
  assert.equal(notes.length <= 601, true)
  assert.equal(notes.endsWith('…'), true)
})

// ── interpretRelease ──
const releaseOf = (over = {}) => ({
  tag_name: 'v0.2.2',
  html_url: 'https://github.com/Neon088/dsh-growth-workbench/releases/tag/v0.2.2',
  published_at: '2026-11-16T02:00:00Z',
  body: '修复专注模式\r\n\r\n- 一条',
  prerelease: false,
  ...over,
})

ok('有新版：behind=true 且 url 用 Release 自己的链接', () => {
  const result = interpretRelease({ current: '0.2.1', release: releaseOf(), checkedAt: '2026-11-15T00:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.current, '0.2.1')
  assert.equal(result.latest, '0.2.2')
  assert.equal(result.behind, true)
  assert.equal(result.url.includes('/releases/tag/v0.2.2'), true)
  assert.equal(result.notes, '修复专注模式\n\n- 一条')
  assert.equal(result.checkedAt, '2026-11-15T00:00:00.000Z')
  assert.equal(result.error, '')
})

ok('同版本：behind=false', () => {
  const result = interpretRelease({ current: '0.2.2', release: releaseOf() })
  assert.equal(result.ok, true)
  assert.equal(result.behind, false)
})

ok('本地比 Release 还新（预发布测试版）：behind=false', () => {
  const result = interpretRelease({ current: '0.2.3-rc.1', release: releaseOf({ tag_name: 'v0.2.2' }) })
  assert.equal(result.behind, false)
})

ok('没拿到 Release：ok=false 但有 current 和兜底链接', () => {
  const result = interpretRelease({ current: '0.2.1', release: null })
  assert.equal(result.ok, false)
  assert.equal(result.current, '0.2.1')
  assert.equal(result.url, RELEASES_PAGE)
  assert.equal(result.error.length > 0, true)
})

ok('tag 认不出：说清楚而不是当成没有新版', () => {
  const result = interpretRelease({ current: '0.2.1', release: releaseOf({ tag_name: 'nightly' }) })
  assert.equal(result.ok, false)
  assert.equal(result.error.includes('nightly'), true)
})

ok('html_url 缺失时退回发布页', () => {
  const result = interpretRelease({ current: '0.2.1', release: releaseOf({ html_url: '' }) })
  assert.equal(result.url, RELEASES_PAGE)
})

// ── fetchLatestRelease：全部用注入的假 fetch，不连网 ──
const fakeResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
})

let seen = null
const fakeFetch = async (url, init) => {
  seen = { url, init }
  return fakeResponse(200, releaseOf())
}

{
  const payload = await fetchLatestRelease({ fetch: fakeFetch, timeoutMs: 5000 })
  assert.equal(payload.tag_name, 'v0.2.2')
  assert.equal(seen.url, API_LATEST)
  assert.equal(seen.init.cache, 'no-store')
  assert.equal(seen.init.headers.accept, 'application/vnd.github+json')
  assert.equal(String(seen.init.headers['user-agent']).includes('dsh-growth-workbench'), true)
  assert.equal(seen.init.signal !== undefined, true, '必须带超时信号，别让设置页一直转圈')
  checks += 1
}

const expectReject = async (label, options, check) => {
  let caught = null
  try {
    await fetchLatestRelease(options)
  } catch (error) {
    caught = error
  }
  assert.notEqual(caught, null, label + '：应当抛错')
  check(caught)
  checks += 1
}

await expectReject('404 解释成还没发布', { fetch: async () => fakeResponse(404, {}) }, (error) => {
  assert.equal(error.status, 404)
  assert.equal(error.message.includes('还没有发布'), true)
})
await expectReject('403 解释成限流', { fetch: async () => fakeResponse(403, {}) }, (error) => {
  assert.equal(error.status, 403)
  assert.equal(error.message.includes('限流'), true)
})
await expectReject('其它状态码带出数字', { fetch: async () => fakeResponse(500, {}) }, (error) => {
  assert.equal(error.message.includes('500'), true)
})
await expectReject('网络异常原样抛出', { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') } }, (error) => {
  assert.equal(error.message.includes('ENOTFOUND'), true)
})
await expectReject('返回的不是对象', { fetch: async () => ({ ok: true, status: 200, json: async () => 'oops' }) }, (error) => {
  assert.equal(error.message.includes('JSON'), true)
})
await expectReject('运行时没有 fetch', { fetch: 0, timeoutMs: 1000 }, (error) => {
  // 传一个非函数（0 不是 nullish，不会回落到 globalThis.fetch），走「没有 fetch」这条。
  assert.equal(error.message.includes('fetch'), true)
})

console.log('updates: ' + checks + ' checks passed (offline, fetch injected)')

// ── 路由实测：假 req/res 直接打 handler；fetch 换成假的，全程不连网 ──
const require = createRequire(import.meta.url)
const plugin = require('../index.js')
const dataDir = mkdtempSync(join(tmpdir(), 'gw-update-route-'))

let handler = null
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {}, error() {} },
}, { pluginDataDir: dataDir })
await new Promise((resolve) => setTimeout(resolve, 120))

let fetchCount = 0
let nextResponse = () => fakeResponse(200, releaseOf())
globalThis.fetch = async () => {
  fetchCount += 1
  return nextResponse()
}

async function get(path) {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/dsh-growth/' + path
  req.headers = { host: '127.0.0.1:1234', ...authHeaders(dataDir) }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
  await handler(req, res)
  return { status: res.statusCode, json: JSON.parse(payload) }
}

{
  const first = await get('update-check')
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.current, pkg.version, '当前版本必须来自 package.json')
  assert.equal(first.json.latest, '0.2.2')
  assert.equal(first.json.behind, isNewer('0.2.2', pkg.version))
  assert.equal(first.json.repo, REPO)
  assert.equal(['git', 'copy'].includes(first.json.installKind), true)
  assert.equal(fetchCount, 1)
  checks += 1

  const cached = await get('update-check')
  assert.equal(cached.json.checkedAt, first.json.checkedAt, '10 分钟内不许重复打 GitHub')
  assert.equal(fetchCount, 1)
  checks += 1

  const forced = await get('update-check?force=1')
  assert.equal(forced.status, 200)
  assert.equal(fetchCount, 2, 'force=1 必须绕过缓存')
  checks += 1

  // 限流：ok=false，但当前版本照旧显示 —— 版本这东西不能因为查不到就变成「未知」。
  nextResponse = () => fakeResponse(403, {})
  const limited = await get('update-check?force=1')
  assert.equal(limited.status, 200)
  assert.equal(limited.json.ok, false)
  assert.equal(limited.json.error.includes('限流'), true)
  assert.equal(limited.json.current, pkg.version)
  checks += 1
}

// 没带 token 的请求必须被挡在外面（检查更新也不能例外）。
{
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/dsh-growth/update-check'
  req.headers = { host: '127.0.0.1:1234' }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
  await handler(req, res)
  assert.equal(res.statusCode, 401)
  checks += 1
}

console.log('update route: ' + checks + ' checks passed (handler, fake fetch)')