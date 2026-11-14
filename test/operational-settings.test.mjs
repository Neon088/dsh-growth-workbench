import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OperationalSettingsError,
  buildObservationPlan,
  canonicalOperationalSettings,
  createDefaultOperationalSettings,
  evaluatePublishGate,
  evaluateSuccessBenchmarks,
  materializeCards,
  migrateOperationalSettings,
  validateOperationalSettings,
} from '../lib/operational-settings.js'

const catalog = [
  { id: 'accounts', workspace: 'ops', title: '账号', enabled: true },
  { id: 'topics', workspace: 'ops', title: '选题', enabled: true },
  { id: 'products', workspace: 'ecom', title: '商品', enabled: false },
]
const copy = (value) => structuredClone(value)
const defaultProfile = () => createDefaultOperationalSettings(catalog).profiles[0]

function validCustom() {
  const document = createDefaultOperationalSettings(catalog)
  document.revision = 8
  document.profiles[0] = {
    ...document.profiles[0],
    description: '主账号内容运营',
    goals: ['涨粉', '转化'],
    content: { types: ['教程', '测评'], pillars: ['效率'], constraints: ['不夸大'] },
    audience: { segments: ['新手'], needs: ['少走弯路'] },
    platforms: ['抖音', '小红书'],
    accounts: ['account-b', 'account-a'],
    workflow: { stages: ['plan', 'draft', 'review', 'publish', 'observe'] },
    automation: { collectMetrics: 'remind', createDraft: 'auto', suggestCopy: 'confirm' },
    publishGates: [
      { id: 'title', type: 'required-field', field: 'draft.title', enabled: true },
      { id: 'risk', type: 'risk-approved', enabled: true },
      { id: 'assets', type: 'min-count', field: 'assets', min: 2, enabled: false },
    ],
    observationCheckpoints: [
      { id: 'day-7', daysAfterPublish: 7, close: true },
      { id: 'day-1', daysAfterPublish: 1, close: false },
    ],
    aiContext: { sources: ['topic', 'profile'], maxItems: 10, maxChars: 5000, draftOnly: true, noOverwrite: true },
    reminders: { channel: 'in-app', enabled: true, leadHours: [24, 0] },
    successBenchmarks: [
      { id: 'views-fixed', metric: 'views', checkpointId: 'day-1', mode: 'fixed', direction: 'at-least', value: 100 },
      { id: 'orders-recent', metric: 'orders', checkpointId: 'day-7', mode: 'recent-average', direction: 'at-least', window: 3, multiplier: 1.1 },
      { id: 'returns-median', metric: 'returnRate', checkpointId: 'day-7', mode: 'type-median', direction: 'at-most' },
    ],
    cardLayout: [
      { id: 'topics', workspace: 'ops', order: 0, visible: true },
      { id: 'accounts', workspace: 'ops', order: 1, visible: false },
      { id: 'products', workspace: 'ecom', order: 0, visible: true },
    ],
  }
  return document
}

test('default snapshot is complete, safe, versioned and detached from catalog', () => {
  const input = copy(catalog)
  const document = createDefaultOperationalSettings(input)
  assert.equal(document.schemaVersion, 1)
  assert.equal(document.revision, 1)
  assert.equal(document.activeProfileId, 'default')
  assert.equal(document.profiles.length, 1)
  const profile = document.profiles[0]
  assert.deepEqual(Object.values(profile.automation).sort(), ['confirm', 'confirm', 'confirm', 'remind', 'remind'])
  assert.equal(profile.publishGates.every((entry) => entry.enabled === false), true, 'migration-safe defaults do not silently block existing publish flows')
  assert.equal(profile.observationCheckpoints.filter((entry) => entry.close).length, 1)
  assert.equal(profile.aiContext.draftOnly, true)
  assert.equal(profile.aiContext.noOverwrite, true)
  assert.equal(profile.reminders.channel, 'in-app')
  assert.deepEqual(profile.cardLayout.map((entry) => [entry.id, entry.order, entry.visible]), [
    ['accounts', 0, true], ['topics', 1, true], ['products', 0, false],
  ])
  assert.equal(validateOperationalSettings(document, catalog).ok, true)
  input[0].workspace = 'other'
  assert.equal(document.profiles[0].cardLayout[0].workspace, 'ops')
})

test('catalog identity is strict before settings are accepted', () => {
  assert.throws(() => createDefaultOperationalSettings([{ id: 'x', workspace: 'ops' }, { id: 'x', workspace: 'ops' }]), (error) => error.code === 'duplicate_card')
  assert.throws(() => createDefaultOperationalSettings([{ id: '../bad', workspace: 'ops' }]), (error) => error.code === 'invalid_card_catalog')
  const result = validateOperationalSettings({}, [{ id: 'x', workspace: 'ops' }, { id: 'x', workspace: 'ops' }])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'duplicate_card')
})

test('validation accepts the documented full profile and returns useful structured errors', () => {
  const document = validCustom()
  assert.deepEqual(validateOperationalSettings(document, catalog), { ok: true, valid: true, errors: [] })
  const broken = copy(document)
  broken.revision = 0
  broken.activeProfileId = 'missing'
  broken.profiles.push(copy(broken.profiles[0]))
  broken.profiles[0].observationCheckpoints[0].close = false
  broken.profiles[0].aiContext.draftOnly = false
  const result = validateOperationalSettings(broken, catalog)
  assert.equal(result.ok, false)
  for (const code of ['revision', 'unknown_profile', 'duplicate_profile', 'close_checkpoint', 'unsafe_ai']) {
    assert.ok(result.errors.some((error) => error.code === code), `missing ${code}: ${JSON.stringify(result.errors)}`)
  }
  assert.ok(result.errors.every((error) => error.path.startsWith('$')))
})

test('hard safety rejects external publish, delete, overwrite, auto-close and non-allow-listed automation', () => {
  for (const action of ['externalPublish', 'deleteDraft', 'overwriteNote', 'autoClose', 'sendEmail']) {
    const document = validCustom()
    document.profiles[0].automation[action] = 'off'
    const result = validateOperationalSettings(document, catalog)
    assert.equal(result.ok, false, action)
    assert.ok(result.errors.some((error) => ['unsafe_automation', 'unknown_automation'].includes(error.code)), action)
  }
  const document = validCustom()
  document.profiles[0].automation.createDraft = 'background'
  assert.ok(validateOperationalSettings(document, catalog).errors.some((error) => error.code === 'invalid_mode'))
})

test('hard safety rejects card injection, cross-workspace moves, duplicates, gaps and bad visibility', () => {
  const mutations = [
    (layout) => { layout[0].id = 'foreign' },
    (layout) => { layout[0].workspace = 'ecom' },
    (layout) => { layout[1].id = layout[0].id },
    (layout) => { layout.pop() },
    (layout) => { layout[0].visible = 'yes' },
    (layout) => { layout[1].order = layout[0].order },
  ]
  const codes = ['unknown_card', 'cross_workspace', 'duplicate_card', 'missing_card', 'type', 'duplicate_order']
  mutations.forEach((mutate, index) => {
    const document = validCustom()
    mutate(document.profiles[0].cardLayout)
    const result = validateOperationalSettings(document, catalog)
    assert.ok(result.errors.some((error) => error.code === codes[index]), JSON.stringify(result.errors))
  })
})

test('observation checkpoints require bounded unique days and exactly one close checkpoint', () => {
  for (const change of [
    (items) => { items[0].daysAfterPublish = 0 },
    (items) => { items[0].daysAfterPublish = items[1].daysAfterPublish },
    (items) => { items[1].close = true },
    (items) => { items[0].close = false },
  ]) {
    const document = validCustom()
    change(document.profiles[0].observationCheckpoints)
    assert.equal(validateOperationalSettings(document, catalog).ok, false)
  }
})

test('AI context and reminder boundaries reject unsafe expansion and external delivery', () => {
  const cases = [
    (profile) => { profile.aiContext.sources = ['entire-vault'] },
    (profile) => { profile.aiContext.maxChars = 100001 },
    (profile) => { profile.aiContext.noOverwrite = false },
    (profile) => { profile.reminders.channel = 'email' },
    (profile) => { profile.reminders.leadHours = [-1] },
  ]
  for (const change of cases) {
    const document = validCustom()
    change(document.profiles[0])
    assert.equal(validateOperationalSettings(document, catalog).ok, false)
  }
})

test('canonicalization emits deterministic JSON, preserves workflow order and discards unknown fields', () => {
  const left = validCustom()
  left.extra = 'discard me'
  left.profiles[0].goals.reverse()
  left.profiles[0].publishGates.reverse()
  left.profiles[0].successBenchmarks.reverse()
  left.profiles[0].unknown = { unsafe: true }
  const right = validCustom()
  right.profiles[0].platforms.reverse()
  right.profiles[0].accounts.reverse()
  right.profiles[0].cardLayout.reverse()
  const a = canonicalOperationalSettings(left, catalog)
  const b = canonicalOperationalSettings(right, catalog)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal('extra' in a, false)
  assert.equal('unknown' in a.profiles[0], false)
  assert.deepEqual(a.profiles[0].workflow.stages, ['plan', 'draft', 'review', 'publish', 'observe'])
  assert.deepEqual(a.profiles[0].observationCheckpoints.map((entry) => entry.id), ['day-1', 'day-7'])
  assert.throws(() => canonicalOperationalSettings({ ...left, revision: 0 }, catalog), (error) => error instanceof OperationalSettingsError && error.errors.length > 0)
})

test('migration imports legacy card visibility once and rejects corrupt legacy identities', () => {
  const migrated = migrateOperationalSettings(null, {
    cardCatalog: catalog,
    legacyCards: [{ id: 'accounts', enabled: false }, { id: 'topics', enabled: true }, { id: 'products', enabled: true }],
  })
  assert.deepEqual(migrated.profiles[0].cardLayout.map((entry) => [entry.id, entry.visible]), [
    ['products', true], ['accounts', false], ['topics', true],
  ])
  const legacyChanged = [{ id: 'accounts', enabled: true }, { id: 'topics', enabled: false }, { id: 'products', enabled: false }]
  assert.deepEqual(migrateOperationalSettings(migrated, { cardCatalog: catalog, legacyCards: legacyChanged }), migrated)
  assert.throws(() => migrateOperationalSettings(null, { cardCatalog: catalog, legacyCards: [{ id: 'foreign', enabled: true }] }), (error) => error.code === 'unknown_card')
  assert.throws(() => migrateOperationalSettings(null, { cardCatalog: catalog, legacyCards: [{ id: 'accounts', enabled: true }, { id: 'accounts', enabled: false }] }), (error) => error.code === 'duplicate_card')
  assert.throws(() => migrateOperationalSettings({ schemaVersion: 2 }, { cardCatalog: catalog }), (error) => error.code === 'unsupported_operational_settings')
})

test('materialization overlays layout without allowing persisted card metadata injection', () => {
  const document = validCustom()
  const cards = materializeCards(document, catalog)
  assert.deepEqual(cards.map((card) => card.id), ['products', 'topics', 'accounts'])
  assert.deepEqual(cards.map((card) => [card.id, card.enabled, card.order]), [
    ['products', true, 0], ['topics', true, 0], ['accounts', false, 1],
  ])
  assert.equal(cards[0].title, '商品')
  cards[0].title = 'changed'
  assert.equal(catalog[2].title, '商品')
  assert.throws(() => materializeCards(document, catalog, 'missing'), (error) => error.code === 'not_found')
})

test('publish gates are additive and report every failed condition', () => {
  const profile = validCustom().profiles[0]
  const blocked = evaluatePublishGate(profile, { draft: { title: '' }, riskLevel: '高', riskApproved: false, assets: ['one'] })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.failed.map((entry) => entry.id), ['title', 'risk'])
  assert.deepEqual(blocked.passed, [])
  const allowed = evaluatePublishGate(profile, { draft: { title: '标题' }, riskLevel: '高', riskApproved: true })
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.results.map((entry) => entry.id), ['title', 'risk'])
})

test('observation plan is deterministic, UTC-based and identifies its single close action', () => {
  const profile = validCustom().profiles[0]
  const result = buildObservationPlan(profile, '2026-01-01T08:30:00.000Z')
  assert.deepEqual(result, [
    { checkpointId: 'day-1', daysAfterPublish: 1, dueAt: '2026-01-02T08:30:00.000Z', close: false, status: 'pending' },
    { checkpointId: 'day-7', daysAfterPublish: 7, dueAt: '2026-01-08T08:30:00.000Z', close: true, status: 'pending' },
  ])
  assert.throws(() => buildObservationPlan(profile, 'not-a-date'), (error) => error.code === 'bad_field')
  const unsafe = copy(profile)
  unsafe.observationCheckpoints[1].close = true
  assert.throws(() => buildObservationPlan(unsafe, '2026-01-01T00:00:00Z'), (error) => error.code === 'close_checkpoint')
})

test('success benchmarks evaluate fixed, recent average and same-type median modes', () => {
  const profile = validCustom().profiles[0]
  const day1 = evaluateSuccessBenchmarks(profile, { views: 120 }, 'day-1')
  assert.equal(day1.ok, true)
  assert.deepEqual(day1.results[0], {
    id: 'views-fixed', metric: 'views', checkpointId: 'day-1', mode: 'fixed', direction: 'at-least',
    actual: 120, baseline: 100, target: 100, evaluable: true, passed: true,
  })
  const day7 = evaluateSuccessBenchmarks(profile, {
    orders: 13,
    returnRate: 0.08,
    recent: [{ orders: 8 }, { orders: 10 }, { orders: 12 }, { orders: 10 }],
    sameType: [{ returnRate: 0.05 }, { returnRate: 0.1 }, { returnRate: 0.2 }, { returnRate: 0.3 }],
  }, 'day-7')
  assert.equal(day7.ok, true)
  assert.equal(day7.results[0].baseline, 32 / 3)
  assert.equal(day7.results[0].target, (32 / 3) * 1.1)
  assert.ok(Math.abs(day7.results[1].baseline - 0.15) < Number.EPSILON)
  assert.equal(day7.results[1].passed, true)
  const missing = evaluateSuccessBenchmarks(profile, {}, 'day-7')
  assert.equal(missing.ok, false)
  assert.equal(missing.evaluated, 0)
  assert.ok(missing.results.every((entry) => entry.reason))
  assert.deepEqual(evaluateSuccessBenchmarks(profile, { views: 1 }, 'unknown'), { ok: false, checkpointId: 'unknown', evaluated: 0, results: [] })
})
