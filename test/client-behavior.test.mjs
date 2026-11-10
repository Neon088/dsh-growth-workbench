// Exercise the actual inline controllers and handlers from the single host client export.
// The VM supplies React scheduling / fetch / DOM dependencies, never a real vault or service.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function bodyOf(name) {
  let start = source.indexOf('    function ' + name + '(')
  if (start < 0) start = source.indexOf('    async function ' + name + '(')
  const end = source.indexOf('\n    }', start)
  assert.ok(start >= 0 && end > start, 'actual client function ' + name + ' exists')
  return source.slice(start, end + 6)
}
const names = [
  'createReadEpoch', 'documentSnapshot', 'sameDocumentSnapshot', 'createCoalescedReader',
  'createDraftRegistry', 'useDraftGuard', 'useObjectDraftGuard', 'createFieldPatchQueue',
  'pageQuery', 'mergeRecordPage', 'usePagedList', 'useLinkedRecords', 'useAsync', 'responseWarning',
  'metricDraftChanged', 'resolveCalendarTopic', 'chooseCalendarVariant', 'moveCalendarEntry',
  'deleteVariantWithBaseline', 'variantPathTo', 'advanceVariant', 'indexBy',
  'keyboardActivate', 'shiftedColumnWidths', 'installColumnDrag', 'installModalFocus',
  'useStableFieldId', 'associateField', 'Field', 'ErrorBar', 'PlatformInput', 'AccountPicker',
  'PlatformMultiInput', 'splitPlatforms', 'MultiSelect', 'SourceSelect', 'ComboField', 'splitCombo', 'joinCombo',
]
const transitionStart = source.indexOf('    const VARIANT_NEXT = ')
const transitionEnd = source.indexOf('\n    }', transitionStart)
assert.ok(transitionStart >= 0 && transitionEnd > transitionStart)
const comboLine = source.match(/^    const COMBO_SEP = .+$/m)?.[0]
assert.ok(comboLine)

const plain = (value) => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
let currentMount = null
let refresh = 0
let registry = null
const timers = new Map()
let timerId = 0
const timer = (fn) => { const id = ++timerId; timers.set(id, fn); return id }
const depsEqual = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
const React = {
  createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } } },
  isValidElement(node) { return node !== null && typeof node === 'object' && 'type' in node && 'props' in node },
  cloneElement(node, props) { return { ...node, props: { ...node.props, ...props } } },
  Children: { map(children, fn) { return [children].flat(Infinity).filter((node) => node !== null && node !== undefined && typeof node !== 'boolean').map(fn) } },
  useContext(context) { return context === 'refresh' ? refresh : registry },
  useRef(initial) { const mount = currentMount, index = mount.cursor++; return mount.slots[index] ?? (mount.slots[index] = { current: initial }) },
  useState(initial) {
    const mount = currentMount, index = mount.cursor++
    if (!mount.slots[index]) mount.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = mount.slots[index]
    return [slot.value, (next) => { if (!mount.active) { mount.lateSets++; return } slot.value = typeof next === 'function' ? next(slot.value) : next; mount.dirty = true }]
  },
  useEffect(effect, deps) {
    const mount = currentMount, index = mount.cursor++
    const old = mount.slots[index]
    if (!old || !depsEqual(old.deps, deps)) {
      const next = { deps, cleanup: old?.cleanup }
      mount.slots[index] = next
      mount.pending.push(() => { next.cleanup?.(); next.cleanup = effect() })
    }
  },
  useLayoutEffect(effect, deps) { return React.useEffect(effect, deps) },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
  useMemo(fn, deps) {
    const mount = currentMount, index = mount.cursor++
    if (!mount.slots[index] || !depsEqual(mount.slots[index].deps, deps)) mount.slots[index] = { deps, value: fn() }
    return mount.slots[index].value
  },
}
function mount(fn, props = {}) {
  const item = { slots: [], cursor: 0, pending: [], value: null, props, dirty: true, active: true, lateSets: 0 }
  item.render = () => {
    item.cursor = 0; item.pending = []; item.dirty = false; currentMount = item
    try { item.value = fn(item.props) } finally { currentMount = null }
    for (const effect of item.pending) effect()
  }
  item.update = (next) => { item.props = next; item.dirty = true }
  item.flush = async () => {
    for (let i = 0; i < 20; i++) {
      if (item.dirty) item.render()
      for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
      await tick()
      if (!item.dirty && timers.size === 0) break
    }
    return item.value
  }
  item.unmount = () => { item.active = false; for (const slot of item.slots) slot?.cleanup?.() }
  return item
}
const context = vm.createContext({
  React, h: React.createElement, console, Promise, Map, Set, Symbol, Object, Array, JSON, Number, String,
  Boolean, Math, Error, URLSearchParams,
  setTimeout: timer, clearTimeout: (id) => timers.delete(id),
  window: { confirm: () => false }, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  get: () => { throw new Error('unmocked get') }, post: () => { throw new Error('unmocked post') },
  put: () => { throw new Error('unmocked put') }, del: () => { throw new Error('unmocked del') },
  askConfirm: () => false, Icon: () => null, normalizeStatus: (value) => String(value ?? ''), normalizePlatform: (value) => String(value ?? '').trim(),
  platformOptions: (items) => [...new Set(items.filter((value) => value !== undefined && value !== null && value !== ''))],
  PLATFORMS: ['抖音', '小红书'],
})
vm.runInContext("const DraftContext = 'draft', RefreshContext = 'refresh'; let fieldSerial = 0; const modalStack = [];\n" + comboLine + '\n' + source.slice(transitionStart, transitionEnd + 6) + '\n' + names.map(bodyOf).join('\n') + '\nglobalThis.api = { ' + names.join(', ') + ' };', context)
const api = context.api
const tests = []
const test = (name, run) => tests.push({ name, run })

// Request identity / refresh / self-save contracts.
test('read epoch rejects old identity, old request, and pre-self-save tickets', () => {
  const reads = api.createReadEpoch()
  const master = reads.begin('master'), a = reads.begin('variant:a'), b = reads.begin('variant:b')
  assert.equal(reads.current(master, 'master'), false)
  assert.equal(reads.current(a, 'variant:a'), false)
  assert.equal(reads.current(b, 'variant:a'), false)
  assert.equal(reads.current(b, 'variant:b'), true)
  reads.invalidate(); assert.equal(reads.current(b, 'variant:b'), false)
})
test('document snapshots reject typing, front changes, and document switches', () => {
  const before = api.documentSnapshot('master', '稿', { goal: 'A' })
  assert.equal(api.sameDocumentSnapshot(before, api.documentSnapshot('master', '稿', { goal: 'A' })), true)
  for (const after of [api.documentSnapshot('version:1', '稿', { goal: 'A' }), api.documentSnapshot('master', '改了', { goal: 'A' }), api.documentSnapshot('master', '稿', { goal: 'B' })]) assert.equal(api.sameDocumentSnapshot(before, after), false)
})
test('poll/SSE/visibility requests coalesce to one running plus one rerun', async () => {
  const pending = [deferred(), deferred()], adopted = []; let calls = 0
  const reader = api.createCoalescedReader(() => pending[calls++].promise, (value) => adopted.push(value))
  reader.tick(); await tick(); reader.tick(); reader.tick(); await tick(); assert.equal(calls, 1)
  pending[0].resolve('first'); await tick(); assert.equal(calls, 2)
  pending[1].resolve('last'); await tick(); assert.deepEqual(adopted, ['first', 'last']); reader.stop()
})
test('a trigger in the drain-finalizer gap is not lost', async () => {
  let calls = 0
  const reader = api.createCoalescedReader(async () => ++calls, (value) => { if (value === 1) Promise.resolve().then(() => reader.tick()) })
  reader.tick(); await tick(); await tick(); assert.equal(calls, 2); reader.stop()
})
test('invalidating own-save read discards its late response; stopped readers do not adopt', async () => {
  const wait = deferred(), adopted = []
  const reader = api.createCoalescedReader(() => wait.promise, (value) => adopted.push(value))
  reader.tick(); await tick(); reader.invalidate(); wait.resolve('old'); await tick(); assert.deepEqual(adopted, [])
  const next = deferred(), second = api.createCoalescedReader(() => next.promise, (value) => adopted.push(value))
  second.tick(); await tick(); second.stop(); next.resolve('after unmount'); await tick(); assert.deepEqual(adopted, []); reader.stop()
})
test('useAsync preserves current data while reloading and setData revokes old reads', async () => {
  const first = deferred(), second = deferred(); let calls = 0
  const view = mount(() => api.useAsync(() => (++calls === 1 ? first.promise : second.promise), []))
  await view.flush(); first.resolve({ record: 'known' }); await view.flush(); assert.equal(view.value.data.record, 'known')
  view.value.reload(); assert.equal(view.value.data.record, 'known'); await view.flush(); assert.equal(view.value.loading, true)
  view.value.setData({ record: 'own-save' }); await view.flush(); second.resolve({ record: 'old disk' }); await view.flush(); assert.equal(view.value.data.record, 'own-save')
  view.unmount()
})
test('useAsync refresh and unmount invalidate older loader generations', async () => {
  refresh = 0; const waits = [deferred(), deferred()]; let calls = 0
  const view = mount(() => api.useAsync(() => waits[calls++].promise, []))
  await view.flush(); refresh = 1; view.dirty = true; await view.flush(); assert.equal(calls, 2)
  waits[0].resolve('stale'); await view.flush(); assert.equal(view.value.data, null)
  view.unmount(); waits[1].resolve('late'); await tick(); assert.equal(view.lateSets, 0); refresh = 0
})
test('useAsync catches synchronous loader failure and provides a recoverable error', async () => {
  const view = mount(() => api.useAsync(() => { throw new Error('sync loader broke') }, []))
  await view.flush(); assert.match(view.value.error.message, /sync loader broke/); assert.equal(view.value.loading, false); assert.equal(typeof view.value.reload, 'function'); view.unmount()
})
test('soft table warning is not a normal empty table; legitimate missing table stays normal', async () => {
  assert.equal(api.responseWarning({ exists: false, entries: [] }), null)
  assert.equal(api.responseWarning({ warning: '' }), null)
  assert.equal(api.responseWarning({ warning: '坏主表' }).code, 'read_warning')
  let result = { exists: true, entries: [{ id: 'saved' }] }
  const view = mount(() => api.useAsync(() => Promise.resolve(result), []))
  await view.flush(); result = { entries: [], warning: '无法读取' }; view.value.reload(); await view.flush()
  assert.equal(view.value.error.code, 'read_warning'); assert.equal(view.value.data.entries[0].id, 'saved')
  result = { exists: false, entries: [] }; view.value.reload(); await view.flush(); assert.equal(view.value.error, null); assert.equal(view.value.data.exists, false); view.unmount()
})

// Dirty registries are per Panel and read current values, not registration-time snapshots.
test('draft registry reads current dirty/busy state and is scoped to its Panel', () => {
  const state = { dirty: false, busy: false }; let asked = 0, blocked = 0
  const first = api.createDraftRegistry(() => { asked++; return false }, () => { blocked++ })
  const second = api.createDraftRegistry(() => true)
  const clear = first.register('owner', () => state)
  assert.equal(first.allow(), true); state.dirty = true; assert.equal(first.allow(), false); assert.equal(asked, 1)
  assert.equal(second.allow(), true); state.busy = true; assert.equal(first.allow(), false); assert.equal(blocked, 1); assert.equal(first.isBusy(), true)
  clear(); assert.equal(first.allow(), true)
})
test('registered hook draft values stay current and unregister on unmount', async () => {
  let confirms = 0; registry = api.createDraftRegistry(() => { confirms++; return false })
  const view = mount((props) => api.useDraftGuard(props.dirty, props.busy), { dirty: false, busy: false })
  await view.flush(); assert.equal(registry.allow(), true)
  view.update({ dirty: true, busy: false }); await view.flush(); assert.equal(registry.allow(), false); assert.equal(confirms, 1)
  view.unmount(); assert.equal(registry.allow(), true); registry = null
})
test('metric draft comparison uses saved values and selected version, not merely open edit mode', () => {
  const editing = { variantId: 'v', baselineVariantId: 'v', draft: { views: '1', likes: '' }, baseline: { views: 1, likes: '' } }
  assert.equal(api.metricDraftChanged(editing), false)
  assert.equal(api.metricDraftChanged({ ...editing, draft: { views: '2', likes: '' } }), true)
  assert.equal(api.metricDraftChanged({ ...editing, variantId: 'other' }), true)
})

// Serial master-front patches, failure retention, and sha1 chaining.
test('field queue writes front-only patches in order with response sha1 chaining', async () => {
  const first = deferred(); let baseline = { front: { goal: '', angle: '' }, sha1: 's0' }; const writes = []
  const queue = api.createFieldPatchQueue(() => baseline, async (payload) => { writes.push(plain(payload)); if (writes.length === 1) await first.promise; return { sha1: 's' + writes.length } }, (patch, response) => { baseline = { front: { ...baseline.front, ...patch }, sha1: response.sha1 } })
  const goal = queue.save('goal', 'A'), angle = queue.save('angle', 'B'); await tick(); assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { front: { goal: 'A' }, expectedSha1: 's0' }); first.resolve(); await Promise.all([goal, angle])
  assert.deepEqual(writes[1], { front: { angle: 'B' }, expectedSha1: 's1' }); assert.ok(writes.every((write) => !Object.hasOwn(write, 'body')))
})
test('field queue compares saved baseline at execution, survives failure and permits explicit retry', async () => {
  let baseline = { front: { goal: 'old' }, sha1: 's0' }, fail = true; const writes = []
  const queue = api.createFieldPatchQueue(() => baseline, async (payload) => { writes.push(plain(payload)); if (fail) { fail = false; throw new Error('offline') } return { sha1: 's1' } }, (patch, response) => { baseline = { front: { ...baseline.front, ...patch }, sha1: response.sha1 } })
  await assert.rejects(queue.save('goal', 'new'), /offline/); assert.equal(baseline.front.goal, 'old')
  await queue.save('goal', 'new'); assert.equal(baseline.front.goal, 'new'); await queue.save('goal', 'new'); assert.equal(writes.length, 2)
})
test('stopped field queues do not send queued writes or update unmounted baselines', async () => {
  const wait = deferred(); let count = 0, adopted = 0
  const queue = api.createFieldPatchQueue(() => ({ front: {}, sha1: 's' }), async () => { count++; await wait.promise; return { sha1: 'next' } }, () => { adopted++ })
  const a = queue.save('a', '1'), b = queue.save('b', '2'); await tick(); queue.stop(); wait.resolve(); await Promise.all([a, b]); assert.equal(count, 1); assert.equal(adopted, 0)
})

// Paging metadata, query scope and independent association lookups.
test('page queries preserve existing filters and encode full-vault q/offset', () => {
  const url = new URL(api.pageQuery('/topics/list?limit=200&f_type=选题', 200, '  老选题 / A  '), 'http://unit.invalid')
  assert.equal(url.searchParams.get('offset'), '200'); assert.equal(url.searchParams.get('limit'), '200'); assert.equal(url.searchParams.get('f_type'), '选题'); assert.equal(url.searchParams.get('q'), '老选题 / A')
})
test('page merge deduplicates/updates by stable path while preserving complete metadata', () => {
  const first = api.mergeRecordPage(null, { records: [{ path: 'a', title: 'old' }], total: 3, offset: 0, limit: 2, truncated: true }, 0)
  const next = api.mergeRecordPage(first, { records: [{ path: 'a', title: 'updated' }, { path: 'b' }], total: 3, offset: 1, limit: 2, truncated: false }, 1)
  assert.equal(next.records.length, 2); assert.equal(next.records[0].title, 'updated'); assert.equal(next.nextOffset, 3); assert.equal(next.total, 3)
  const legacy = api.mergeRecordPage(null, { records: [{ path: 'old' }] }, 0); assert.equal(legacy.total, null)
})
test('page merge refuses a truncated nonadvancing page', () => {
  assert.throws(() => api.mergeRecordPage({ records: [], nextOffset: 10 }, { records: [], offset: 10, total: 20, truncated: true }, 10), /分页|前进|重试/)
})
test('usePagedList appends real next pages and query changes hide old results', async () => {
  const calls = [], waits = []
  context.get = (path) => { calls.push(path); const wait = deferred(); waits.push(wait); return wait.promise }
  const view = mount(() => api.usePagedList('/topics/list?limit=2'))
  await view.flush(); waits[0].resolve({ records: [{ path: 'a' }, { path: 'b' }], offset: 0, limit: 2, total: 3, truncated: true }); await view.flush()
  view.value.loadMore(); await view.flush(); assert.match(calls[1], /offset=2/); waits[1].resolve({ records: [{ path: 'c' }], offset: 2, limit: 2, total: 3, truncated: false }); await view.flush(); assert.equal(view.value.data.records.length, 3)
  view.value.setQuery('旧关联'); await view.flush(); assert.equal(view.value.data, null); assert.match(calls[2], /q=/)
  waits[2].resolve({ records: [{ path: 'old' }], total: 1, offset: 0, limit: 2, truncated: false }); await view.flush(); assert.deepEqual(plain(view.value.data.records), [{ path: 'old' }]); view.unmount()
})
test('usePagedList ignores late page responses from a different query', async () => {
  const waits = []; context.get = () => { const wait = deferred(); waits.push(wait); return wait.promise }
  const view = mount(() => api.usePagedList('/accounts/list?limit=2')); await view.flush(); view.value.setQuery('B'); await view.flush()
  waits[1].resolve({ records: [{ path: 'B' }], total: 1, offset: 0, limit: 2, truncated: false }); await view.flush()
  waits[0].resolve({ records: [{ path: 'A' }], total: 1, offset: 0, limit: 2, truncated: false }); await view.flush(); assert.equal(view.value.data.records[0].path, 'B'); view.unmount()
})
test('old associations resolve by id/path without relying on the first list page', async () => {
  const calls = []; context.get = async (path) => { calls.push(path); return { record: { path: 'Accounts/old.md', front: { id: 'old-id' }, title: '旧账号' } } }
  const records = [{ path: 'Accounts/new.md', front: { id: 'new-id' } }], links = [{ id: 'old-id' }, { id: 'old-id' }]
  const view = mount(() => api.useLinkedRecords('accounts', records, links)); await view.flush()
  assert.equal(calls.length, 1); assert.match(calls[0], /record\?id=old-id/); assert.equal(view.value.records.length, 2); assert.equal(view.value.records[1].front.id, 'old-id'); view.unmount()
})
test('association responses and errors cannot leak from previous document link scopes', async () => {
  const waits = []; context.get = () => { const wait = deferred(); waits.push(wait); return wait.promise }
  const empty = []; const view = mount((props) => api.useLinkedRecords('topics', empty, [{ id: props.id }]), { id: 'a' }); await view.flush()
  view.update({ id: 'b' }); await view.flush(); waits[1].resolve({ record: { path: 'Topics/b.md', front: { id: 'b' } } }); await view.flush()
  waits[0].resolve({ record: { path: 'Topics/a.md', front: { id: 'a' } } }); await view.flush(); assert.equal(view.value.records.length, 1); assert.equal(view.value.records[0].front.id, 'b'); view.unmount()
})

// Calendar no-new-topic contract, mandatory owned version, and partial commit reporting.
test('calendar resolves exact path/id, never an ambiguous same-title replacement', () => {
  const records = [{ path: 'Topics/A.md', title: '同名', id: 'a' }, { path: 'Topics/B.md', title: '同名', front: { id: 'b' } }]
  assert.equal(api.resolveCalendarTopic({ topicPath: 'Topics/B.md', topic: '同名' }, records).path, 'Topics/B.md')
  assert.equal(api.resolveCalendarTopic({ topicId: 'b', topic: '同名' }, records).path, 'Topics/B.md')
  assert.throws(() => api.resolveCalendarTopic({ topicPath: 'missing', topic: '同名' }, records), /不能按同名/)
  assert.throws(() => api.resolveCalendarTopic({ topic: '同名' }, records), /同名/)
  assert.throws(() => api.resolveCalendarTopic({ topic: '新建' }, records), /先选|先建/)
})
test('calendar requires one owned version; multiple versions cannot silently choose one', () => {
  const master = { id: 'm' }, a = { id: 'a', front: { masterId: 'm' } }, b = { id: 'b', front: { masterId: 'm' } }
  assert.equal(api.chooseCalendarVariant(master, [a], '').id, 'a')
  assert.throws(() => api.chooseCalendarVariant(master, [a, b], ''), /多个版本/)
  assert.throws(() => api.chooseCalendarVariant(master, [a], 'foreign'), /不属于/)
  assert.equal(api.chooseCalendarVariant(master, [a, b], 'b').id, 'b')
})
test('cross-month move creates before deleting; delete failure reports preserved partial success', async () => {
  const actions = []; const entry = { id: 'e', topicPath: 'Topics/A.md', variantId: 'v' }
  const fake = { post: async (path, body) => { actions.push(['post', path, body.month]); return { entry: { ...body, id: 'new' } } }, del: async () => { actions.push(['del']); throw new Error('source delete offline') }, put: async () => { throw new Error('unexpected put') } }
  await assert.rejects(api.moveCalendarEntry(entry, '2026-11', '2026-12-02', 'sha', fake), (error) => { assert.equal(error.partialMove.fromMonth, '2026-11'); assert.equal(error.partialMove.targetMonth, '2026-12'); assert.equal(error.partialMove.entry.id, 'new'); return true })
  assert.deepEqual(actions, [['post', '/calendar', '2026-12'], ['del']])
})
test('same-month move uses the observed sha1 and does not create/delete another row', async () => {
  let payload; await api.moveCalendarEntry({ id: 'e' }, '2026-11', '2026-11-12', 'observed', { put: async (_, value) => { payload = value }, post: () => assert.fail(), del: () => assert.fail() }); assert.equal(payload.expectedSha1, 'observed')
})
test('shared transition helper reports each commit and exposes a partial failure status', async () => {
  const commits = []; let calls = 0; context.post = async () => { if (++calls === 2) throw new Error('发布 gate blocked'); return { variant: { id: 'v', status: '待发' } } }
  await assert.rejects(api.advanceVariant({ id: 'v', status: '在写' }, '已发', (variant) => commits.push(variant.status)), (error) => { assert.equal(error.variantProgress.status, '待发'); assert.equal(error.variantProgress.committed, 1); return true }); assert.deepEqual(commits, ['待发'])
})
test('variant deletion uses the supplied fingerprint unchanged, never freshens it after conflict', async () => {
  let fetched = 0, deleted = 0
  await assert.rejects(api.deleteVariantWithBaseline({ id: 'v', sha1: 'observed' }, () => true, { get: async () => { fetched++; return { variant: { sha1: 'fresh' } } }, del: async (_, body) => { deleted++; assert.equal(body.expectedSha1, 'observed'); const error = new Error('conflict'); error.code = 'conflict'; throw error } }), /conflict/)
  assert.equal(fetched, 0); assert.equal(deleted, 1)
})
test('missing deletion baseline is obtained before confirmation and cancel sends no delete', async () => {
  const order = []
  await api.deleteVariantWithBaseline({ id: 'v' }, () => { order.push('confirm'); return false }, { get: async () => { order.push('get'); return { variant: { id: 'v', sha1: 'baseline' } } }, del: async () => { order.push('delete') } })
  assert.deepEqual(order, ['get', 'confirm'])
})

// Handler contracts use actual functions and a bounded synthetic DOM event target.
class EventBus {
  constructor() { this.listeners = new Map() }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener) }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, event = {}) { for (const listener of [...(this.listeners.get(type) ?? [])]) { listener(event); if (event.immediate) break } }
  count() { return [...this.listeners.values()].reduce((sum, group) => sum + group.size, 0) }
}
const keyEvent = (key, target = {}) => ({ key, target, currentTarget: target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.immediate = true; this.stopped = true } })
test('row/sort keyboard activation fires once and ignores nested controls', () => {
  let count = 0; const target = {}; const enter = keyEvent('Enter', target); api.keyboardActivate(enter, () => { count++ }); assert.equal(count, 1); assert.equal(enter.defaultPrevented, true)
  const space = keyEvent(' ', target); api.keyboardActivate(space, () => { count++ }); assert.equal(count, 2)
  const child = keyEvent('Enter', {}); child.currentTarget = target; api.keyboardActivate(child, () => { count++ }); assert.equal(count, 2)
  const other = keyEvent('ArrowDown', target); api.keyboardActivate(other, () => { count++ }); assert.equal(count, 2)
})
test('column widths clamp both neighbors while preserving their combined width', () => {
  const next = api.shiftedColumnWidths([50, 50], 0, 100); assert.deepEqual(plain(next), [96, 4]); assert.equal(next[0] + next[1], 100)
})
test('pointercancel, blur and explicit unmount cleanup remove all column drag listeners', () => {
  for (const end of ['pointercancel', 'blur', 'cleanup']) {
    const doc = new EventBus(), host = new EventBus(), classes = new Set(); doc.body = { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) } }
    const table = { isConnected: true, getBoundingClientRect: () => ({ width: 100 }) }; let widths
    const event = { currentTarget: { closest: () => table }, clientX: 10, preventDefault() {}, stopPropagation() {} }
    const stop = api.installColumnDrag(event, [50, 50], 0, (value) => { widths = value }, doc, host)
    doc.emit('pointermove', { clientX: 30 }); assert.deepEqual(plain(widths), [70, 30])
    if (end === 'cleanup') stop(); else (end === 'blur' ? host : doc).emit(end)
    stop(); assert.equal(doc.count(), 0); assert.equal(host.count(), 0); assert.equal(classes.size, 0)
  }
})
test('disconnected tables terminate column drag without updating unmounted state', () => {
  const doc = new EventBus(), host = new EventBus(); doc.body = { classList: { add() {}, remove() {} } }
  const table = { isConnected: false, getBoundingClientRect: () => ({ width: 100 }) }; let updates = 0
  api.installColumnDrag({ currentTarget: { closest: () => table }, clientX: 0, preventDefault() {}, stopPropagation() {} }, [50, 50], 0, () => { updates++ }, doc, host)
  doc.emit('pointermove', { clientX: 100 }); assert.equal(updates, 0); assert.equal(doc.count(), 0); assert.equal(host.count(), 0)
})
function focusDOM() {
  const doc = new EventBus(), host = new EventBus()
  const node = (name) => ({ name, isConnected: true, hidden: false, getClientRects: () => [1], focus() { doc.activeElement = this; doc.emit('focusin') } })
  const opener = node('opener'); doc.activeElement = opener
  const root = (name) => {
    const first = node(name + ':first'), cancel = node(name + ':cancel'), item = node(name)
    item.buttons = [first, cancel]; item.contains = (value) => value === item || item.buttons.includes(value)
    item.querySelectorAll = () => item.buttons; item.querySelector = () => cancel
    return item
  }
  return { doc, host, opener, root }
}
test('modal traps Tab/ShiftTab, redirects outside focus, and restores the opener', () => {
  const { doc, host, opener, root } = focusDOM(), dialog = root('dialog'); let cancelled = 0
  const cleanup = api.installModalFocus(dialog, () => { cancelled++ }, doc, host)
  assert.equal(doc.activeElement, dialog.buttons[1]); const tab = keyEvent('Tab'); host.emit('keydown', tab); assert.equal(doc.activeElement, dialog.buttons[0]); assert.equal(tab.defaultPrevented, true)
  const back = keyEvent('Tab'); back.shiftKey = true; host.emit('keydown', back); assert.equal(doc.activeElement, dialog.buttons[1])
  opener.focus(); assert.equal(doc.activeElement, dialog.buttons[1]); const esc = keyEvent('Escape'); host.emit('keydown', esc); assert.equal(cancelled, 1); assert.equal(esc.immediate, true)
  cleanup(); assert.equal(doc.activeElement, opener); assert.equal(doc.count(), 0); assert.equal(host.count(), 0)
})
test('nested modal Escape affects only the top modal and restores remaining-modal focus', () => {
  const { doc, host, opener, root } = focusDOM(), outer = root('outer'), inner = root('inner'); let outerEsc = 0, innerEsc = 0
  const a = api.installModalFocus(outer, () => { outerEsc++ }, doc, host), b = api.installModalFocus(inner, () => { innerEsc++ }, doc, host)
  host.emit('keydown', keyEvent('Escape')); assert.equal(outerEsc, 0); assert.equal(innerEsc, 1); b(); assert.ok(outer.contains(doc.activeElement)); a(); assert.equal(doc.activeElement, opener)
})
function find(tree, predicate) { if (tree === null || typeof tree !== 'object') return undefined; if (predicate(tree)) return tree; for (const child of tree.props?.children ?? []) { const found = find(child, predicate); if (found) return found } }
test('ErrorBar renders a real alert and a callable retry, not a string custom tag', () => {
  let retried = 0; const node = api.ErrorBar({ error: new Error('offline'), onRetry: () => { retried++ } }); assert.equal(node.props.role, 'alert'); const button = find(node, (item) => item.type === 'button'); button.props.onClick(); assert.equal(retried, 1); assert.equal(api.ErrorBar({ error: null }), null)
})
test('Field connects native inputs and all custom controls to the visible label', async () => {
  const cases = [
    ['input', { value: '' }], [api.PlatformInput, { value: '', options: [], onChange() {} }],
    [api.PlatformMultiInput, { value: [], options: [], onChange() {} }], [api.AccountPicker, { value: '', options: [], onChange() {}, notify() {}, hideCreate: true }],
    [api.MultiSelect, { label: 'tags', options: [], value: [], onChange() {} }], [api.SourceSelect, { value: '', groups: [], onChange() {} }],
    [api.ComboField, { value: '', options: [], onChange() {} }],
  ]
  for (const [type, props] of cases) {
    const field = mount(() => api.Field({ label: '可读标题', children: React.createElement(type, props) })); await field.flush()
    const label = find(field.value, (item) => item.type === 'label'), child = field.value.props.children[1]
    const control = typeof type === 'string' ? child : await (async () => { const rendered = mount(() => type(child.props)); await rendered.flush(); const output = rendered.value; rendered.unmount(); return output })()
    const native = find(control, (item) => ['input', 'select', 'button', 'textarea'].includes(item.type) && item.props.id === label.props.htmlFor)
    assert.ok(native, type.name ?? type); assert.equal(native.props['aria-labelledby'], label.props.id); field.unmount()
  }
})
test('multiple PlatformInput instances have independent control and datalist ids', async () => {
  const first = mount(() => api.PlatformInput({ value: '', options: [], onChange() {} })), second = mount(() => api.PlatformInput({ value: '', options: [], onChange() {} })); await first.flush(); await second.flush()
  const a = find(first.value, (node) => node.type === 'input'), b = find(second.value, (node) => node.type === 'input')
  assert.notEqual(a.props.id, b.props.id); assert.notEqual(a.props.id, a.props.list); assert.notEqual(a.props.list, b.props.list); first.unmount(); second.unmount()
})

let failed = 0
for (const item of tests) {
  registry = null; refresh = 0; timers.clear()
  try { await item.run(); console.log('ok  ', item.name) }
  catch (error) { failed++; console.error('FAIL', item.name); console.error(error.stack ?? error) }
}
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
