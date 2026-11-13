import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'
import { buildNote, splitNote, normalizeFrontPatch } from '../lib/frontmatter.js'
import { createTable } from '../lib/table.js'
import { createVaultStore, normalizeVaultSubdir } from '../lib/vault.js'

const hash = (text) => createHash('sha1').update(text, 'utf8').digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function temporary(t, prefix = 'gwb-backend-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    const actual = fs.realpathSync(root)
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(actual).startsWith(prefix))
    fs.rmSync(actual, { recursive: true, force: true })
  })
  return root
}

async function fixture(t) {
  const root = temporary(t)
  const home = path.join(root, '.test-home')
  fs.mkdirSync(home)
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  assert.equal(os.homedir(), home, 'all startup logs are redirected into this temporary fixture')
  let handler
  let tool
  const disposals = []
  const errors = []
  apply({
    webServer: { register(route) { handler = route.handler; return () => {} } },
    effect(fn) { const result = fn(); if (typeof result === 'function') disposals.push(result); return result },
    inject(keys, fn) {
      if (keys.includes('tools')) fn({ tools: { register(value) { tool = value; return () => {} } } })
      return { dispose() {} }
    },
    logger: { info() {}, warn() {}, error(message) { errors.push(message) } },
  }, { vaultRoot: root, pluginDataDir: path.join(root, '.plugin-data') })
  t.after(() => {
    for (const dispose of disposals) dispose()
    for (const key of ['HOME', 'USERPROFILE']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  async function request(method, endpoint, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = '/api/dsh-growth' + endpoint
    req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    let payload = ''
    const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
    await handler(req, res)
    return { status: res.statusCode, json: JSON.parse(payload) }
  }
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(root, 'CopyRules', 'rules.md')); attempt += 1) await delay(5)
  assert.ok(fs.existsSync(path.join(root, 'CopyRules', 'rules.md')), errors.join('\n'))
  assert.ok(tool && typeof tool.execute === 'function', 'actual registered growth_vault tool captured')
  return { root, request, tool }
}

function complexPrefix(id = 't-preserve') {
  return '\uFEFF---\r\n' + (id === '' ? '' : 'id: ' + id + '\r\n')
    + "platform: 抖音\r\ndate: 2026-11-10\r\ntype: 选题\r\nstatus: 在写 # keep status comment\r\n"
    + "tags:\r\n  - preserved-tag\r\naliases:\r\n  - first\r\n  - second\r\ncustom:\r\n  nested: value\r\n# independent comment\r\nowner: 'O''Brien' # keep owner comment\r\n---\r\n\r\n"
}

function put(root, relative, text) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

test('backend: original YAML bytes survive body-only, BOM/CRLF, comments and quoted scalars', () => {
  const prefix = complexPrefix()
  const original = prefix + '# Old body\r\n'
  assert.equal(buildNote({}, '# New body', original), prefix + '# New body\r\n')
  assert.equal(buildNote({ owner: "O'Brien" }, '# New body', original), prefix + '# New body\r\n')
  assert.equal(splitNote(original).front.owner, "O'Brien")
  const schema = [{ key: 'platform', required: true }, { key: 'status' }]
  const patch = normalizeFrontPatch(schema, { status: '待发' }, splitNote(original).front)
  assert.deepEqual(patch, { status: '待发' })
  const expected = prefix.replace('status: 在写 # keep status comment', "status: 待发 # keep status comment")
  assert.equal(buildNote(patch, '# New body', original), expected + '# New body\r\n')
  assert.equal(splitNote(buildNote({ id: '001' }, 'body')).front.id, '001')
  assert.equal(buildNote({}, 'body', '---\nowner: old\n---'), '---\nowner: old\n---\nbody\n')
})

test('backend: actual collection and Agent append/replaceSection/setFront preserve complex YAML', async (t) => {
  const { root, request, tool } = await fixture(t)
  const prefix = complexPrefix()
  const relative = 'Topics/preserve.md'
  const file = put(root, relative, prefix + '# Body\r\n\r\n## Target\r\nold\r\n\r\n## Other\r\nkeep\r\n')
  const read = await request('GET', '/topics/record?path=' + encodeURIComponent(relative))
  assert.equal(read.status, 200)
  const updated = await request('PUT', '/topics/record?path=' + encodeURIComponent(relative), { body: '# Body\n\n## Target\nold\n\n## Other\nkeep\n', expectedSha1: read.json.record.sha1 })
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(prefix))
  for (const action of [
    { action: 'append', markdown: '## Added\nnew' },
    { action: 'replaceSection', heading: 'Target', markdown: 'replacement' },
  ]) {
    const before = await tool.execute({ action: 'read', path: relative })
    const result = await tool.execute({ ...action, path: relative, expectedSha1: before.sha1 })
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.startsWith(prefix), action.action)
    assert.ok(text.includes('## Other\nkeep'), 'outside section preserved')
  }
  const changed = await tool.execute({ action: 'setFront', path: relative, front: { status: '待发' } })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(prefix.replace('status: 在写', "status: 待发")))
  const sop = 'SOP/preserve.md'
  const sopFile = put(root, sop, prefix + '# SOP\r\n')
  const generic = await tool.execute({ action: 'setFront', path: sop, front: { owner: 'Nora' } })
  assert.equal(generic.ok, true, JSON.stringify(generic))
  const sopText = fs.readFileSync(sopFile, 'utf8')
  assert.equal(splitNote(sopText).front.owner, 'Nora')
  assert.ok(sopText.includes('# keep owner comment'), 'targeted property edits retain its inline comment')
  const withoutOwner = (text) => text.replace(/^owner:[^\r\n]*\r\n/m, '')
  assert.ok(withoutOwner(sopText).startsWith(withoutOwner(prefix)), 'only the targeted scalar line may change formatting')
})

test('backend: legacy fallback ID is unchanged and body-only does not insert a YAML field', async (t) => {
  const { root, request } = await fixture(t)
  const prefix = complexPrefix('')
  const relative = 'Topics/legacy.md'
  const file = put(root, relative, prefix + '# Legacy\r\n')
  const before = await request('GET', '/topics/record?path=' + encodeURIComponent(relative))
  const id = before.json.record.id
  const body = await request('PUT', '/topics/record?path=' + encodeURIComponent(relative), { body: '# Changed', expectedSha1: before.json.record.sha1 })
  assert.equal(body.status, 200)
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(prefix))
  assert.equal(splitNote(fs.readFileSync(file, 'utf8')).front.id, undefined)
  const created = await request('POST', '/v2/masters/' + id + '/variants', { platform: 'douyin', account: '' })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const saved = await request('PUT', '/topics/record?path=' + encodeURIComponent(relative), { front: { status: '待发' } })
  assert.equal(saved.status, 200)
  assert.equal(splitNote(fs.readFileSync(file, 'utf8')).front.id, id)
  const variants = await request('GET', '/v2/masters/' + id + '/variants')
  assert.equal(variants.json.variants.length, 1)
  assert.equal(variants.json.variants[0].front.masterId, id)
  const rejected = await request('PUT', '/topics/record?path=' + encodeURIComponent(relative), { front: { id: 'replacement' } })
  assert.equal(rejected.status, 400)
})

test('backend: actual legacy migration persists exposed ID and keeps alias-version/calendar/metric links', async (t) => {
  const { root, request } = await fixture(t)
  const relative = 'Topics/legacy-alias.md'
  put(root, relative, complexPrefix('').replace('platform: 抖音', 'platform: douyin') + '# Legacy\r\n')
  const before = await request('GET', '/topics/record?path=' + encodeURIComponent(relative))
  const masterId = before.json.record.id
  assert.ok(masterId && !before.json.record.front.id)
  const created = await request('POST', '/v2/masters/' + masterId + '/variants', { platform: '抖音', account: '', riskLevel: '低' })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const variant = created.json.variant
  await request('POST', '/v2/variants/' + variant.id + '/transition', { to: '待发' })
  await request('POST', '/v2/variants/' + variant.id + '/transition', { to: '已发', at: '2020-11-01T10:00:00+08:00', reviewDays: 7 })
  const metric = await request('POST', '/v2/variants/' + variant.id + '/metrics', { date: '2026-11-10', views: '9', likes: '1' })
  assert.equal(metric.status, 200, JSON.stringify(metric.json))
  const calendar = await request('POST', '/calendar', { month: '2026-11', date: '2026-11-10', platform: '抖音', topic: 'Legacy', topicPath: relative, topicId: masterId, variantId: variant.id, status: '待发' })
  assert.equal(calendar.status, 200, JSON.stringify(calendar.json))
  const variantFile = path.join(root, variant.path)
  const metricFile = path.join(root, 'Data', '回流台账', '2026-11.md')
  const variantText = fs.readFileSync(variantFile, 'utf8')
  const metricText = fs.readFileSync(metricFile, 'utf8')
  const preview = await request('GET', '/v2/migration/preview')
  assert.equal(preview.json.migration.missingIdCount, 1)
  assert.equal(preview.json.migration.createVariantCount, 0, 'douyin alias matches existing canonical variant')
  const migrated = await request('POST', '/v2/migration/apply', { dryRun: false })
  assert.equal(migrated.status, 200, JSON.stringify(migrated.json))
  assert.equal(migrated.json.migration.assignedIds, 1)
  assert.equal(migrated.json.migration.createdCount, 0)
  const after = await request('GET', '/topics/record?id=' + masterId)
  assert.equal(after.json.record.front.id, masterId)
  assert.equal(after.json.record.front.platform, 'douyin', 'untouched legacy YAML stays original')
  assert.equal(fs.readFileSync(variantFile, 'utf8'), variantText)
  assert.equal(fs.readFileSync(metricFile, 'utf8'), metricText)
  const rows = await request('GET', '/calendar?month=2026-11')
  assert.equal(rows.json.entries[0].topicId, masterId)
  assert.equal(rows.json.entries[0].variantId, variant.id)
  const again = await request('POST', '/v2/migration/apply', { dryRun: false })
  assert.equal(again.json.migration.assignedIds, 0)
  assert.equal(again.json.migration.createdCount, 0)
})

test('backend: variant body/property patch preserves YAML and DELETE honors caller stale sha1', async (t) => {
  const { root, request } = await fixture(t)
  const master = await request('POST', '/v2/masters', { title: 'Delete master', platform: '抖音', date: '2026-11-10', type: '选题', status: '在写' })
  const created = await request('POST', '/v2/masters/' + master.json.master.id + '/variants', { platform: '抖音', account: '' })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const variant = created.json.variant
  const file = path.join(root, variant.path)
  const original = fs.readFileSync(file, 'utf8').replace('\n---\n', "\ncustom:\n  list:\n    - keep\nowner: 'O''Brien' # untouched\n---\n")
  fs.writeFileSync(file, original, 'utf8')
  const frontPrefix = original.slice(0, original.indexOf('\n---\n') + '\n---\n'.length)
  const body = await request('PATCH', '/v2/variants/' + variant.id, { body: '# New version body' })
  assert.equal(body.status, 200, JSON.stringify(body.json))
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(frontPrefix))
  const patch = await request('PATCH', '/v2/variants/' + variant.id, { front: { coverCopy: 'Updated copy' } })
  assert.equal(patch.status, 200, JSON.stringify(patch.json))
  assert.ok(fs.readFileSync(file, 'utf8').includes("custom:\n  list:\n    - keep\nowner: 'O''Brien' # untouched\n"))
  const latest = await request('GET', '/v2/variants/' + variant.id)
  const changed = fs.readFileSync(file, 'utf8') + '\nExternal edit\n'
  fs.writeFileSync(file, changed, 'utf8')
  const rejected = await request('DELETE', '/v2/variants/' + variant.id, { expectedSha1: latest.json.variant.sha1 })
  assert.equal(rejected.status, 409, JSON.stringify(rejected.json))
  assert.equal(fs.readFileSync(file, 'utf8'), changed)
  const deleted = await request('DELETE', '/v2/variants/' + variant.id, { expectedSha1: hash(changed) })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.join(root, master.json.master.path)), true)
})

test('backend: table chooses schema block even after auxiliary table; ambiguity and damage reject unchanged', async (t) => {
  const root = temporary(t)
  const table = createTable({ header: ['中文', '英文'], keys: ['zh', 'en'], idKeys: ['zh'], heading: '# Main', label: 'term' })
  const file = path.join(root, 'tables.md')
  const auxiliary = '# Auxiliary\r\n\r\n| 项目 | 备注 |\r\n| --- | --- |\r\n| unrelated | keep |\r\n\r\n'
  const main = '| 中文 | 英文 |\r\n| --- | --- |\r\n| ROI | return |\r\n'
  const suffix = '\r\n## Tail\r\nunchanged\r\n'
  fs.writeFileSync(file, auxiliary + main + suffix, 'utf8')
  assert.deepEqual((await table.read(file)).entries.map((entry) => entry.zh), ['ROI'])
  assert.equal((await table.add(file, { zh: 'GMV', en: 'gross' })).ok, true)
  const saved = fs.readFileSync(file, 'utf8')
  assert.ok(saved.startsWith(auxiliary))
  assert.ok(saved.endsWith(suffix))
  assert.deepEqual((await table.read(file)).entries.map((entry) => entry.zh), ['ROI', 'GMV'])
  for (const damaged of [main + '\r\n' + main, '| 中文 | 英文 |\n| not divider | x |\n', '# Non-table notes\nkeep\n']) {
    fs.writeFileSync(file, damaged, 'utf8')
    const result = await table.add(file, { zh: 'new', en: 'new' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_table')
    assert.equal(fs.readFileSync(file, 'utf8'), damaged)
  }
})

test('backend: file queue spans store instances; same-sha writer/create races have exactly one winner', async (t) => {
  const root = temporary(t)
  const options = { vaultRoot: root, sopDir: 'SOP', backupDir: path.join(root, '.backups') }
  const stores = [createVaultStore(options), createVaultStore(options)]
  await stores[0].createNote('Topics/race.md', 'original\n')
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => stores[index % 2].writeNote('Topics/race.md', 'winner-' + index + '\n', { expectedSha1: hash('original\n') })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'conflict'))
  assert.equal(fs.readFileSync(path.join(root, '.backups', 'Topics', 'race.md.bak'), 'utf8'), 'original\n')
  const creates = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => stores[index % 2].createNote('Topics/new.md', 'create-' + index)))
  assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1)
  assert.ok(creates.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'exists'))
  assert.equal(fs.readdirSync(path.join(root, 'Topics')).some((name) => name.includes('.tmp-')), false)
})

test('backend: concurrent table additions retain every row; stale update/delete and backup failure are fail-closed', async (t) => {
  const root = temporary(t)
  const file = path.join(root, 'table.md')
  const table = createTable({ header: ['Key', 'Value'], keys: ['key', 'value'], idKeys: ['key'] })
  const added = await Promise.all(Array.from({ length: 18 }, (_, index) => table.add(file, { key: 'key-' + index, value: 'value-' + index })))
  assert.ok(added.every((result) => result.ok))
  const state = await table.read(file)
  assert.equal(state.entries.length, 18)
  const row = state.entries[0]
  const options = { expectedSha1: state.sha1 }
  const changes = await Promise.all([table.update(file, row.id, { key: row.key, value: 'a' }, options), table.update(file, row.id, { key: row.key, value: 'b' }, options)])
  assert.equal(changes.filter((result) => result.ok).length, 1)
  assert.equal(changes.filter((result) => result.code === 'conflict').length, 1)
  const before = fs.readFileSync(file, 'utf8')
  assert.equal((await table.remove(file, row.id, options)).code, 'conflict')
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  fs.unlinkSync(file + '.bak')
  fs.mkdirSync(file + '.bak')
  const refused = await table.add(file, { key: 'backup-fail', value: 'x' })
  assert.equal(refused.code, 'backup_failed')
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('backend: mirrored backups do not collide and vault backup failures prevent writes/deletes', async (t) => {
  const root = temporary(t)
  const backups = path.join(root, '.backups')
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP', backupDir: backups })
  for (const relative of ['A/B.md', 'A__B.md']) {
    await vault.createNote(relative, relative + '\n')
    await vault.writeNote(relative, 'new\n')
  }
  assert.equal(fs.readFileSync(path.join(backups, 'A', 'B.md.bak'), 'utf8'), 'A/B.md\n')
  assert.equal(fs.readFileSync(path.join(backups, 'A__B.md.bak'), 'utf8'), 'A__B.md\n')
  await vault.createNote('Topics/refuse.md', 'keep\n')
  fs.mkdirSync(path.join(backups, 'Topics', 'refuse.md.bak'), { recursive: true })
  await assert.rejects(vault.writeNote('Topics/refuse.md', 'discard\n'), (error) => error.code === 'backup_failed')
  assert.equal(fs.readFileSync(path.join(root, 'Topics', 'refuse.md'), 'utf8'), 'keep\n')
  fs.mkdirSync(path.join(backups, 'Topics', 'refuse.md'))
  await assert.rejects(vault.deleteNote('Topics/refuse.md'), (error) => error.code === 'backup_failed')
  assert.equal(fs.readFileSync(path.join(root, 'Topics', 'refuse.md'), 'utf8'), 'keep\n')
})

test('backend: relative directory/config validation rejects escape before state is changed', async (t) => {
  for (const input of ['../outside', 'Topics/../outside', 'C:\\outside', '//server/share', 'Topics/.. /outside']) assert.throws(() => normalizeVaultSubdir(input), (error) => error.code === 'bad_path')
  const { root, request } = await fixture(t)
  const before = await request('GET', '/state')
  for (const input of ['../outside', 'Topics/../outside', 'C:\\outside']) {
    const result = await request('PUT', '/config', { vaultRoot: root, topicsDir: input, campaignsDir: 'ChangedBeforeError' })
    assert.equal(result.status, 400, JSON.stringify(result.json))
    assert.deepEqual((await request('GET', '/state')).json.config, before.json.config)
  }
})

test('backend: real junction escape is checked only when sandbox creates a genuine link', async (t) => {
  const root = temporary(t)
  const outside = temporary(t, 'gwb-backend-outside-')
  put(outside, 'secret.md', 'outside\n')
  fs.mkdirSync(path.join(root, 'Topics'))
  const link = path.join(root, 'Topics', 'linked')
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    t.skip('junction creation unavailable: ' + error.code)
    return
  }
  if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(outside)) {
    t.skip('sandbox materialized an ordinary directory; genuine junction behavior not verified')
    return
  }
  const vault = createVaultStore({ vaultRoot: root, sopDir: 'SOP' })
  await assert.rejects(vault.readNote('Topics/linked/secret.md'), (error) => error.code === 'bad_path')
  await assert.rejects(vault.writeNote('Topics/linked/new.md', 'outside write'), (error) => error.code === 'bad_path')
})

test('backend: Calendar honors body/query CAS and rules RMW queues the whole transaction', async (t) => {
  const { root, request } = await fixture(t)
  const month = '2026-11'
  const added = await request('POST', '/calendar', { month, date: '2026-11-10', platform: '抖音', topic: 'Standalone', status: '待发' })
  assert.equal(added.status, 200, JSON.stringify(added.json))
  const before = await request('GET', '/calendar?month=' + month)
  const row = before.json.entries[0]
  const changed = await request('PUT', '/calendar', { month, id: row.id, status: '在写', expectedSha1: before.json.sha1 })
  assert.equal(changed.status, 200, JSON.stringify(changed.json))
  const stale = await request('DELETE', '/calendar?month=' + month + '&id=' + encodeURIComponent(row.id), { expectedSha1: before.json.sha1 })
  assert.equal(stale.status, 409, JSON.stringify(stale.json))
  const staleAdd = await request('POST', '/calendar', { month, date: '2026-11-11', platform: '抖音', topic: 'Another', expectedSha1: before.json.sha1 })
  assert.equal(staleAdd.status, 409, JSON.stringify(staleAdd.json))
  const latest = await request('GET', '/calendar?month=' + month)
  assert.equal(latest.json.entries.length, 1)
  assert.equal(latest.json.entries[0].status, '在写')
  const removed = await request('DELETE', '/calendar?month=' + month + '&id=' + encodeURIComponent(row.id) + '&sha1=' + latest.json.sha1)
  assert.equal(removed.status, 200, JSON.stringify(removed.json))

  const rules = await request('GET', '/rules')
  const results = await Promise.all(['A', 'B', 'C'].map((tag) => request('PUT', '/rules', { expectedSha1: rules.json.sha1, text: rules.json.text + '\n<!-- backend-race-' + tag + ' -->\n' })))
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal(results.filter((result) => result.status === 409).length, 2)
  const ruleText = fs.readFileSync(path.join(root, rules.json.path), 'utf8')
  assert.equal((ruleText.match(/backend-race-/g) ?? []).length, 1)
  assert.equal(fs.readFileSync(path.join(root, rules.json.path + '.bak'), 'utf8'), rules.json.text)
})

test('backend: GET bad tables stays 200 with explicit warning/code; missing calendar is normal', async (t) => {
  const { root, request } = await fixture(t)
  const good = await request('GET', '/glossary')
  assert.equal(good.status, 200)
  const original = 'free prose without a target table\n'
  put(root, good.json.path, original)
  const bad = await request('GET', '/glossary')
  assert.equal(bad.status, 200)
  assert.equal(bad.json.exists, true)
  assert.equal(bad.json.code, 'invalid_table')
  assert.ok(bad.json.warning)
  assert.deepEqual(bad.json.entries, [])
  assert.equal(fs.readFileSync(path.join(root, good.json.path), 'utf8'), original)
  const missing = await request('GET', '/calendar?month=2026-01')
  assert.equal(missing.status, 200)
  assert.equal(missing.json.exists, false)
  assert.ok(!missing.json.warning)
})

test('backend: repeated CSV imports preserve exact original duplicate columns without overwriting', async (t) => {
  const { request } = await fixture(t)
  const raw = '\uFEFFperiod,uv,uv,note\r\n2026-11,1,2,"quoted\r\ntext"\r\n'
  const first = await request('POST', '/data/import', { csv: raw, name: 'duplicate', mapping: { period: 'period', traffic: 'uv' } })
  const second = await request('POST', '/data/import', { csv: raw, name: 'duplicate', mapping: { period: 'period', traffic: 'uv' } })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.notEqual(first.json.archive, second.json.archive)
  assert.equal(fs.readFileSync(first.json.archive, 'utf8'), raw)
  assert.equal(fs.readFileSync(second.json.archive, 'utf8'), raw)
})

test('backend: SOP endpoints stay inside the configured SOP directory', async (t) => {
  const { root, request } = await fixture(t)
  put(root, 'Topics/outside.md', '# outside\n\nPRIVATE_OUTSIDE_MARKER\n')
  put(root, 'SOP/inside.md', '# inside\n\nSOP_INSIDE_MARKER\n')
  const outsideSearch = await request('GET', '/sop/search?q=' + encodeURIComponent('PRIVATE_OUTSIDE_MARKER'))
  assert.equal(outsideSearch.status, 200)
  assert.deepEqual(outsideSearch.json.matches, [])
  const insideSearch = await request('GET', '/sop/search?q=' + encodeURIComponent('SOP_INSIDE_MARKER'))
  assert.equal(insideSearch.status, 200)
  assert.equal(insideSearch.json.matches.length, 1)
  const outsideRead = await request('GET', '/sop/note?note=' + encodeURIComponent('Topics/outside.md'))
  assert.equal(outsideRead.status, 404)
  assert.match(String(outsideRead.json.message ?? ''), /SOP\/Topics\/outside\.md/)
  const insideRead = await request('GET', '/sop/note?note=' + encodeURIComponent('SOP/inside.md'))
  assert.equal(insideRead.status, 200)
  assert.match(insideRead.json.note.text, /SOP_INSIDE_MARKER/)
})

test('backend: a campaign needs real results before it can be closed', async (t) => {
  const { root, request } = await fixture(t)
  const created = await request('POST', '/campaigns/create', {
    title: 'Closure guard', platform: '抖音', status: '进行中',
    start: '2026-11-01', end: '2026-11-11', goal: '验证结案流程',
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const relative = created.json.created.path
  const endpoint = '/campaigns/record?path=' + encodeURIComponent(relative)
  const before = await request('GET', endpoint)
  const file = path.join(root, relative)
  const original = fs.readFileSync(file, 'utf8')

  const emptyClose = await request('PUT', endpoint, {
    front: { status: '已结束' }, expectedSha1: before.json.record.sha1,
  })
  assert.equal(emptyClose.status, 400, JSON.stringify(emptyClose.json))
  assert.match(String(emptyClose.json.message ?? ''), /实际效果|复盘经验/)
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'rejected closure must not change the note')

  const bodyWithResult = before.json.record.body.replace('|  |  |  |', '| 转化率 | 3% | 3.4% |')
  const closed = await request('PUT', endpoint, {
    front: { status: '已结束' }, body: bodyWithResult, expectedSha1: before.json.record.sha1,
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.json))
  const after = await request('GET', endpoint)
  assert.equal(after.json.record.front.status, '已结束')
  assert.match(after.json.record.body, /\| 转化率 \| 3% \| 3\.4% \|/)
})
