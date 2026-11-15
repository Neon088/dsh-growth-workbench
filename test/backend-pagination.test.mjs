import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { authHeaders } from './_auth-token.mjs'
import { apply } from '../index.js'
import { buildNote } from '../lib/frontmatter.js'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-backend-pages-'))
  const home = path.join(root, '.test-home')
  fs.mkdirSync(home)
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  assert.equal(os.homedir(), home, 'all startup logs are redirected into this temporary fixture')
  let handler
  const errors = []
  apply({
    webServer: { register(route) { handler = route.handler; return () => {} } },
    effect(fn) { return fn() },
    logger: { info() {}, warn() {}, error(message) { errors.push(message) } },
  }, { vaultRoot: root, pluginDataDir: path.join(root, '.plugin-data') })
  t.after(() => {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    const actual = fs.realpathSync(root)
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(actual).startsWith('gwb-backend-pages-'))
    fs.rmSync(actual, { recursive: true, force: true })
  })
  async function request(method, endpoint, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = '/api/dsh-growth' + endpoint
    req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json', ...authHeaders(path.join(root, '.plugin-data')) }
    req.socket = { remoteAddress: '127.0.0.1' }
    let payload = ''
    const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
    await handler(req, res)
    return { status: res.statusCode, json: JSON.parse(payload) }
  }
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(root, 'CopyRules', 'rules.md')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(fs.existsSync(path.join(root, 'CopyRules', 'rules.md')), errors.join('\n'))
  return { root, request }
}

function put(root, relative, front, body) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buildNote(front, body), 'utf8')
  return file
}

test('backend pagination: complete filtering/counting, bounded pages and ID/path lookup beyond first 1000', async (t) => {
  const { root, request } = await fixture(t)
  const expected = []
  const count = 1255
  for (let index = 0; index < count; index += 1) {
    const front = { id: 't-page-' + index, platform: index % 2 === 0 ? '抖音' : '小红书', date: '2026-11-10', type: index % 3 === 0 ? '选题' : '拆解', status: index % 5 === 0 ? '待发' : '在写', extra: index === count - 1 ? 'EXTRA-LATE' : '' }
    const relative = 'Topics/f' + String(index).padStart(4, '0') + '.md'
    const file = put(root, relative, front, '# Record ' + index + '\n\n' + (index === count - 1 ? 'Late-NEEDLE' : 'regular body'))
    // Legacy default is mtime desc, not filename/date sort; make its order deterministic.
    const stamp = new Date(Date.UTC(2026, 9, 1) - index * 1000)
    fs.utimesSync(file, stamp, stamp)
    expected.push({ relative, front })
  }
  for (let index = 0; index < 450; index += 1) put(root, 'Products/p' + String(index).padStart(4, '0') + '.md', { kind: '自家', date: '2026-11-10' }, '# Product ' + index)

  await t.test('default retains old first-page shape/order and returns truthful metadata', async () => {
    const result = await request('GET', '/topics/list')
    assert.equal(result.status, 200)
    assert.equal(result.json.total, count)
    assert.equal(result.json.offset, 0)
    assert.equal(result.json.limit, 300)
    assert.equal(result.json.truncated, true)
    assert.equal(result.json.records.length, 300)
    assert.ok(Array.isArray(result.json.schema))
    assert.ok(result.json.records.every((record) => typeof record.path === 'string' && record.front && typeof record.preview === 'string' && typeof record.body === 'string' && typeof record.script === 'string'))
    assert.deepEqual(result.json.records.map((record) => record.path), expected.slice(0, 300).map((item) => item.relative))
  })

  await t.test('late matches in body/front/path are found before slicing; direct/f_* filters share complete total', async () => {
    for (const q of ['  late-needle  ', 'extra-late', 'f1254.md']) {
      const result = await request('GET', '/topics/list?q=' + encodeURIComponent(q) + '&limit=2')
      assert.equal(result.json.total, 1, q)
      assert.equal(result.json.records[0].id, 't-page-1254')
      assert.equal(result.json.truncated, false)
    }
    const filtered = expected.filter((item) => item.front.platform === '抖音' && item.front.type === '选题' && item.front.status === '待发')
    const result = await request('GET', '/topics/list?platform=' + encodeURIComponent('抖音') + '&type=' + encodeURIComponent('选题') + '&status=' + encodeURIComponent('待发') + '&limit=7&offset=3')
    assert.equal(result.json.total, filtered.length)
    assert.deepEqual(result.json.records.map((record) => record.path), filtered.slice(3, 10).map((item) => item.relative))
    assert.equal(result.json.truncated, true)
    const alias = await request('GET', '/topics/list?platform=' + encodeURIComponent('抖音') + '&f_platform=' + encodeURIComponent('小红书') + '&limit=1')
    assert.equal(alias.json.total, expected.filter((item) => item.front.platform === '小红书').length)
    assert.equal(alias.json.records[0].front.platform, '小红书')
  })

  await t.test('bounded finite page controls and complete page traversal have no silent cap', async () => {
    const clamped = await request('GET', '/topics/list?limit=99999&offset=-3')
    assert.equal(clamped.json.limit, 1000)
    assert.equal(clamped.json.offset, 0)
    assert.equal(clamped.json.total, count)
    assert.equal(clamped.json.truncated, true)
    const invalid = await request('GET', '/topics/list?limit=wat&offset=Infinity')
    assert.equal(invalid.json.limit, 300)
    assert.equal(invalid.json.offset, 0)
    const last = await request('GET', '/topics/list?limit=100&offset=1200')
    assert.equal(last.json.records.length, 55)
    assert.equal(last.json.truncated, false)
    const beyond = await request('GET', '/topics/list?offset=100000')
    assert.equal(beyond.json.total, count)
    assert.equal(beyond.json.records.length, 0)
    assert.equal(beyond.json.truncated, false)
    const seen = new Set()
    for (let offset = 0; ; offset += 211) {
      const page = await request('GET', '/topics/list?limit=211&offset=' + offset)
      assert.equal(page.json.total, count)
      for (const record of page.json.records) { assert.equal(seen.has(record.id), false); seen.add(record.id) }
      if (!page.json.truncated) break
    }
    assert.equal(seen.size, count)
  })

  await t.test('exact ID/path lookups and Calendar associations can reach late records without raising limit', async () => {
    const record = await request('GET', '/topics/record?id=t-page-1254')
    assert.equal(record.status, 200, JSON.stringify(record.json))
    assert.equal(record.json.record.path, 'Topics/f1254.md')
    const product = await request('GET', '/products/record?path=Products%2Fp0449.md')
    assert.equal(product.status, 200)
    assert.equal(product.json.record.path, 'Products/p0449.md')
    const saved = await request('POST', '/calendar', { month: '2026-11', date: '2026-11-20', platform: '抖音', topic: 'late association', status: '在写', topicId: 't-page-1254', productPath: 'Products/p0449.md' })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.entry.topicPath, 'Topics/f1254.md')
    const calendar = await request('GET', '/calendar?month=2026-11')
    assert.equal(calendar.json.entries[0].topicId, 't-page-1254')
    const byPath = await request('GET', '/topics/record?path=Topics%2Ff1254.md&id=wrong-id')
    assert.equal(byPath.status, 200, 'explicit path retains precedence')
    assert.equal(byPath.json.record.schedule.date, '2026-11-20')
    assert.equal((await request('GET', '/v2/state')).json.masters.length, count)
    assert.equal((await request('GET', '/v2/masters')).json.masters.length, count)
  })

  await t.test('stat-verified cache observes edits to known files; plugin create invalidates discovery', async () => {
    fs.appendFileSync(path.join(root, 'Topics/f1254.md'), '\nFresh-cache-needle\n')
    const fresh = await request('GET', '/topics/list?q=fresh-cache-needle')
    assert.equal(fresh.json.total, 1)
    const created = await request('POST', '/topics/create', { title: 'new-immediate-record', platform: '抖音', date: '2026-11-10', type: '选题', status: '在写' })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const immediate = await request('GET', '/topics/list?q=new-immediate-record')
    assert.equal(immediate.json.total, 1)
    assert.equal((await request('GET', '/topics/list?limit=1')).json.total, count + 1)
  })
})

test('backend schedule: full path/stable ID disambiguate equal basenames and earliest month wins', async (t) => {
  const { root, request } = await fixture(t)
  for (const suffix of ['A', 'B']) put(root, 'Topics/' + suffix + '/same.md', { id: 't-same-' + suffix, platform: '抖音', date: '2026-11-10', type: '选题', status: '在写' }, '# Same ' + suffix)
  for (const [id, month, date] of [['t-same-A', '2026-12', '2026-12-20'], ['t-same-A', '2026-11', '2026-11-15'], ['t-same-B', '2026-11', '2026-11-18']]) {
    const result = await request('POST', '/calendar', { month, date, platform: '抖音', topic: 'same', topicId: id, status: '在写' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
  }
  const ambiguous = await request('POST', '/calendar', { month: '2026-11', date: '2026-11-01', platform: 'B站', topic: 'legacy ambiguous', topicPath: 'same.md', status: '在写' })
  assert.equal(ambiguous.status, 200)
  const a = await request('GET', '/topics/record?id=t-same-A')
  const b = await request('GET', '/topics/record?id=t-same-B')
  assert.equal(a.json.record.schedule.date, '2026-11-15')
  assert.equal(a.json.record.schedule.month, '2026-11')
  assert.equal(b.json.record.schedule.date, '2026-11-18')
  const conflict = await request('POST', '/calendar', { month: '2026-11', date: '2026-11-22', platform: '抖音', topic: 'mismatched reference', topicId: 't-same-A', topicPath: 'Topics/B/same.md' })
  assert.equal(conflict.status, 400)
})
