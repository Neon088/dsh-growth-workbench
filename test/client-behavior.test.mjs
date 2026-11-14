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
  'createApiClient', 'createReadEpoch', 'documentSnapshot', 'sameDocumentSnapshot', 'createCoalescedReader',
  'createDraftRegistry', 'useDraftGuard', 'useObjectDraftGuard', 'createFieldPatchQueue',
  'pageQuery', 'mergeRecordPage', 'usePagedList', 'useLinkedRecords', 'useAsync', 'responseWarning',
  'metricDraftChanged', 'resolveCalendarTopic', 'chooseCalendarVariant', 'moveCalendarEntry', 'fanoutPartialReceipt',
  'deleteVariantWithBaseline', 'variantPathTo', 'advanceVariant', 'indexBy', 'homeActions', 'workspaceTabTarget', 'columnResizeDelta',
  'keyboardActivate', 'shiftedColumnWidths', 'installColumnDrag', 'shiftedPixelColumnWidths', 'installPixelColumnDrag', 'installModalFocus',
  'useStableFieldId', 'associateField', 'Field', 'ErrorBar', 'PlatformInput', 'AccountPicker',
  'PlatformMultiInput', 'splitPlatforms', 'MultiSelect', 'SourceSelect', 'ComboField', 'splitCombo', 'joinCombo',
  'useRecordFilter', 'matchRecord', 'splitTags', 'detailCrumbOf', 'useDetailCrumb', 'TopicsCard', 'StudioCard', 'colResizeStart',
  'collectionSortValue', 'sortCollectionRows', 'toggledCollectionSort', 'CollectionSortHead',
  'createMeasuredHeightTracker', 'useMeasuredBlockHeight', 'ListPager',
  'parseSurfaceColor', 'surfaceLuminance', 'surfaceContrast', 'hostAccent', 'installHostAccent',
  'installActionMenu', 'ActionMenu', 'calendarAccountName', 'CalendarCard', 'shiftMonth', 'monthTitle', 'monthGrid',
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
    return [slot.value, (next) => { if (!mount.active) { mount.lateSets++; return } const value = typeof next === 'function' ? next(slot.value) : next; if (Object.is(value, slot.value)) return; slot.value = value; mount.dirty = true }]
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
  Boolean, Math, Error, URLSearchParams, AbortController,
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
// Render the actual cards; only unrelated visual leaves are inert VNodes.
for (const name of [...(bodyOf('TopicsCard') + bodyOf('StudioCard') + bodyOf('CalendarCard')).matchAll(/\bh\(\s*([A-Z]\w*)/g)].map((match) => match[1])) if (context[name] === undefined) context[name] = function VisualLeaf() {}
context.CAL_WEEKDAYS = [...source.match(/^    const CAL_WEEKDAYS = (.+)$/m)[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
context.TOPIC_STATUSES = ['在写', '待发', '已发', '待回填', '已归档']
context.topicTypeOf = (record) => String(record.front?.type ?? '').trim()
context.localDay = context.todayISO = () => '2026-11-11'
context.t = (key) => key
context.formatCount = (value) => String(value)
const tests = []
const test = (name, run) => tests.push({ name, run })

function jsonResponse(status, payload) {
  return { status, async json() { return payload } }
}

// API request reliability: one shared token refresh, one retry, and method-aware timeouts.
test('API client coalesces initial token requests', async () => {
  const tokenWait = deferred(); let tokenCalls = 0
  const client = api.createApiClient(async (url) => {
    if (url.endsWith('/token')) { tokenCalls++; await tokenWait.promise; return jsonResponse(200, { token: 'shared' }) }
    return jsonResponse(200, { ok: true })
  }, '/api', { readTimeoutMs: 1000 })
  const first = client.call('/one'), second = client.call('/two'); await tick(); assert.equal(tokenCalls, 1)
  tokenWait.resolve(); await Promise.all([first, second]); assert.equal(tokenCalls, 1)
})
test('API client refreshes a rejected token once and retries the original request', async () => {
  let tokenCalls = 0; const businessTokens = []
  const client = api.createApiClient(async (url, init) => {
    if (url.endsWith('/token')) return jsonResponse(200, { token: ++tokenCalls === 1 ? 'old' : 'fresh' })
    businessTokens.push(init.headers['x-dsh-growth-token'])
    return businessTokens.length === 1 ? jsonResponse(401, { ok: false, code: 'unauthorized', message: 'expired' }) : jsonResponse(200, { ok: true, value: 7 })
  }, '/api', { readTimeoutMs: 1000 })
  const result = await client.call('/data')
  assert.equal(result.value, 7); assert.deepEqual(businessTokens, ['old', 'fresh']); assert.equal(tokenCalls, 2)
})
test('concurrent 401 responses share one refresh and each request retries once', async () => {
  const oldResponses = [deferred(), deferred()]; let oldIndex = 0, tokenCalls = 0, freshCalls = 0
  const client = api.createApiClient(async (url, init) => {
    if (url.endsWith('/token')) return jsonResponse(200, { token: ++tokenCalls === 1 ? 'old' : 'fresh' })
    if (init.headers['x-dsh-growth-token'] === 'old') return oldResponses[oldIndex++].promise
    freshCalls++; return jsonResponse(200, { ok: true })
  }, '/api', { readTimeoutMs: 1000 })
  const first = client.call('/one'), second = client.call('/two'); await tick(); assert.equal(oldIndex, 2)
  oldResponses[0].resolve(jsonResponse(401, { ok: false })); oldResponses[1].resolve(jsonResponse(401, { ok: false })); await Promise.all([first, second])
  assert.equal(tokenCalls, 2); assert.equal(freshCalls, 2)
})
test('API client stops after the second 401', async () => {
  let tokenCalls = 0, businessCalls = 0
  const client = api.createApiClient(async (url) => {
    if (url.endsWith('/token')) return jsonResponse(200, { token: 'token-' + ++tokenCalls })
    businessCalls++; return jsonResponse(401, { ok: false, code: 'unauthorized', message: 'still expired' })
  }, '/api', { readTimeoutMs: 1000 })
  await assert.rejects(client.call('/data'), (error) => error.code === 'unauthorized' && /still expired/.test(error.message))
  assert.equal(tokenCalls, 2); assert.equal(businessCalls, 2)
})
test('caller cancellation stops a business read but does not cancel shared token refresh', async () => {
  const tokenWait = deferred(); let tokenCalls = 0, businessCalls = 0
  const client = api.createApiClient(async (url, init) => {
    if (url.endsWith('/token')) { tokenCalls++; await tokenWait.promise; return jsonResponse(200, { token: 'shared' }) }
    businessCalls++
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  }, '/api', { readTimeoutMs: 1000 })
  const firstAbort = new AbortController(), secondAbort = new AbortController()
  const first = client.call('/one', { signal: firstAbort.signal })
  const second = client.call('/two', { signal: secondAbort.signal })
  await tick(); firstAbort.abort(); tokenWait.resolve();
  await assert.rejects(first, (error) => error.name === 'AbortError')
  await tick(); assert.equal(tokenCalls, 1); assert.equal(businessCalls, 1)
  secondAbort.abort(); await assert.rejects(second, (error) => error.name === 'AbortError')
})

test('API client times out reads and flags write outcomes as unknown', async () => {
  const scheduled = new Map(); let nextTimer = 0
  const config = {
    readTimeoutMs: 1000, writeTimeoutMs: 2000,
    setTimer(fn) { const id = ++nextTimer; scheduled.set(id, fn); return id }, clearTimer(id) { scheduled.delete(id) },
  }
  const fireTimer = () => { const entry = [...scheduled.entries()].at(-1); assert.ok(entry); scheduled.delete(entry[0]); entry[1]() }
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/token')) return jsonResponse(200, { token: 'ok' })
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  }
  const readClient = api.createApiClient(fetchImpl, '/api', config)
  const read = readClient.call('/slow'); await tick(); fireTimer(); await assert.rejects(read, (error) => error.code === 'timeout' && error.method === 'GET' && error.timeoutMs === 1000 && error.unknownOutcome === false)
  const writeClient = api.createApiClient(fetchImpl, '/api', config)
  const write = writeClient.call('/slow', { method: 'POST', body: { value: 1 } }); await tick(); fireTimer(); await assert.rejects(write, (error) => error.code === 'timeout' && error.method === 'POST' && error.timeoutMs === 2000 && error.unknownOutcome === true && /刷新确认/.test(error.message))
})

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
test('useAsync refresh and unmount abort older loader generations', async () => {
  refresh = 0; const waits = [deferred(), deferred()]; const signals = []; let calls = 0
  const view = mount(() => api.useAsync((signal) => { signals.push(signal); return waits[calls++].promise }, []))
  await view.flush(); refresh = 1; view.dirty = true; await view.flush(); assert.equal(calls, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false)
  waits[0].resolve('stale'); await view.flush(); assert.equal(view.value.data, null)
  view.unmount(); assert.equal(signals[1].aborted, true); waits[1].resolve('late'); await tick(); assert.equal(view.lateSets, 0); refresh = 0
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

test('usePagedList aborts superseded and unmounted page reads', async () => {
  refresh = 0; const waits = [deferred(), deferred()]; const signals = []; let calls = 0
  const loader = (_uri, options) => { signals.push(options.signal); return waits[calls++].promise }
  const view = mount(() => api.usePagedList('/topics/list?limit=2', loader))
  await view.flush(); view.value.reload(); await view.flush(); assert.equal(calls, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false)
  waits[0].resolve({ records: [{ path: 'old' }], truncated: false }); await view.flush(); assert.equal(view.value.data, null)
  view.unmount(); assert.equal(signals[1].aborted, true); waits[1].resolve({ records: [{ path: 'late' }], truncated: false }); await tick(); assert.equal(view.lateSets, 0)
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
test('fanout partial receipt preserves committed counts and unique failed platforms', () => {
  const receipt = plain(api.fanoutPartialReceipt({
    month: '2026-11', partial: true,
    results: [
      { platform: '抖音', variantCreated: true, rowCreated: false },
      { platform: '知乎', variantCreated: false, rowCreated: true },
    ],
    failed: [
      { platform: '抖音', error: '日历冲突' },
      { platform: '抖音', error: '重复明细' },
      { platform: 'B站', error: '版本未建成' },
    ],
  }))
  assert.deepEqual(receipt, {
    month: '2026-11', createdVariants: 1, writtenRows: 1,
    failed: [
      { platform: '抖音', error: '日历冲突' },
      { platform: '抖音', error: '重复明细' },
      { platform: 'B站', error: '版本未建成' },
    ],
    failedPlatforms: ['抖音', 'B站'],
  })
  assert.equal(api.fanoutPartialReceipt({ partial: false }), null)
  assert.equal(api.fanoutPartialReceipt(null), null)
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

test('home actions rank real pending work and fall back to an enabled creation path', () => {
  const cards = ['ideas', 'studio', 'calendar', 'pending'].map((id) => ({ id, enabled: true }))
  assert.deepEqual(plain(api.homeActions(cards, { pendingCount: 2, calendarPending: 4, topicsDoing: 1, ideasNew: 9 })), [
    { cardId: 'pending', count: 2, label: '回填已发数据', meta: '2 条等你回写' },
    { cardId: 'calendar', count: 4, label: '推进待创作排期', meta: '4 条待创作' },
    { cardId: 'studio', count: 1, label: '继续内容创作', meta: '1 条创作中' },
  ])
  assert.deepEqual(plain(api.homeActions([{ id: 'studio', enabled: true }], {})), [
    { cardId: 'studio', label: '新建自己的选题', meta: '从选题到平台版本开始推进' },
  ])
  assert.deepEqual(plain(api.homeActions([{ id: 'pending', enabled: false }], { pendingCount: 3 })), [])
})
test('workspace tabs wrap arrows and honor Home and End', () => {
  const workspaces = [{ id: 'ops' }, { id: 'ecom' }, { id: 'mkt' }, { id: 'common' }]
  assert.equal(api.workspaceTabTarget(workspaces, 'ops', 'ArrowLeft'), 'common')
  assert.equal(api.workspaceTabTarget(workspaces, 'common', 'ArrowRight'), 'ops')
  assert.equal(api.workspaceTabTarget(workspaces, 'ecom', 'ArrowDown'), 'mkt')
  assert.equal(api.workspaceTabTarget(workspaces, 'mkt', 'ArrowUp'), 'ecom')
  assert.equal(api.workspaceTabTarget(workspaces, 'mkt', 'Home'), 'ops')
  assert.equal(api.workspaceTabTarget(workspaces, 'ecom', 'End'), 'common')
  assert.equal(api.workspaceTabTarget(workspaces, 'ops', 'Enter'), null)
})
test('column resize keyboard steps are predictable and ignore unrelated keys', () => {
  assert.equal(api.columnResizeDelta({ key: 'ArrowRight', shiftKey: false, defaultPrevented: false }), 1)
  assert.equal(api.columnResizeDelta({ key: 'ArrowLeft', shiftKey: true, defaultPrevented: false }), -5)
  assert.equal(api.columnResizeDelta({ key: 'ArrowRight', shiftKey: false, defaultPrevented: false }, true), 16)
  assert.equal(api.columnResizeDelta({ key: 'ArrowLeft', shiftKey: true, defaultPrevented: false }, true), -48)
  assert.equal(api.columnResizeDelta({ key: 'Enter', defaultPrevented: false }), 0)
  assert.equal(api.columnResizeDelta({ key: 'ArrowRight', defaultPrevented: true }), 0)
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
test('pixel column widths preserve their combined width and honor per-column minima', () => {
  assert.deepEqual(plain(api.shiftedPixelColumnWidths([64, 88], 0, 100, [56, 72])), [80, 72])
  assert.deepEqual(plain(api.shiftedPixelColumnWidths([64, 88], 0, -100, [56, 72])), [56, 96])
  assert.deepEqual(plain(api.shiftedPixelColumnWidths([64], 0, 10, [56])), [64])
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

// End-to-end call sites: the existing card filter must dispatch real paged q.
function findAll(tree, predicate, result = []) { if (tree === null || typeof tree !== 'object') return result; if (predicate(tree)) result.push(tree); for (const child of tree.props?.children ?? []) findAll(child, predicate, result); return result }
function nodeText(tree) { if (tree === null || tree === undefined || typeof tree === 'boolean') return ''; if (typeof tree !== 'object') return String(tree); return (tree.props?.children ?? []).map(nodeText).join(' ') }
for (const [card, ownType] of [[api.TopicsCard, '拆解'], [api.StudioCard, '选题']]) {
  test(card.name + ' existing filter dispatches full-vault q and keeps a body-only hit beyond 200', async () => {
    const records = Array.from({ length: 401 }, (_, index) => ({ id: 'id' + index, path: 'Topics/entry' + index + '.md', title: '记录' + index, preview: '', body: index === 400 ? 'ONLY_BODY_NEEDLE' : 'ordinary', front: { type: ownType, platform: '抖音', date: '2026-11-11', tags: '' }, metrics: { views: index } }))
    const requests = []
    context.get = async (uri) => {
      const [path, query = ''] = uri.split('?'), params = new URLSearchParams(query); requests.push({ path, query })
      if (path === '/v2/variants') return { variants: [] }
      if (path === '/accounts/list') return { records: [], total: 0, offset: 0, limit: 300, truncated: false }
      assert.equal(path, '/topics/list')
      const q = params.get('q') ?? '', offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 200)
      const all = q === '' ? records : records.filter((record) => record.body.includes(q))
      return { records: all.slice(offset, offset + limit), total: all.length, offset, limit, truncated: offset + limit < all.length }
    }
    const actor = mount(card, { notify() {}, openCard() {}, preset: null }); await actor.flush()
    const filter = find(actor.value, (node) => node.type === context.ListFilter); assert.ok(filter, 'existing user-facing filter is mounted')
    filter.props.setFilter('ONLY_BODY_NEEDLE'); await actor.flush()
    assert.ok(requests.some(({ path, query }) => path === '/topics/list' && new URLSearchParams(query).get('q') === 'ONLY_BODY_NEEDLE'))
    const pager = find(actor.value, (node) => node.type === context.ListPager && node.props.list.data?.records?.some((record) => record.id === 'id400'))
    if (card === api.TopicsCard) {
      assert.ok(pager); assert.equal(pager.props.list.data.total, 1)
    } else {
      assert.equal(pager, undefined, 'Studio intentionally hides the loaded-count row')
      const liveFilter = find(actor.value, (node) => node.type === context.ListFilter)
      assert.equal(liveFilter.props.shown, 1); assert.equal(liveFilter.props.total, 1)
    }
    assert.match(nodeText(actor.value), /记录400/)
    assert.equal(api.matchRecord(records[400], 'only_body_needle'), false, 'a local metadata matcher would wrongly discard this result')
    actor.unmount(); assert.equal(actor.lateSets, 0)
  })
}
test('actual Studio custom header exposes native keyboard buttons and really sorts rows both ways', async () => {
  const records = [10, 2, 1].map((number) => ({ id: 'sort' + number, path: 'Topics/sort' + number + '.md', title: '选题' + number, front: { type: '选题', platform: '抖音', tags: '' } }))
  context.get = async (uri) => uri.startsWith('/v2/variants') ? { variants: [] } : uri.startsWith('/accounts/list') ? { records: [], total: 0, offset: 0, limit: 300, truncated: false } : { records, total: records.length, offset: 0, limit: 200, truncated: false }
  const actor = mount(api.StudioCard, { notify() {}, openCard() {}, preset: null }); await actor.flush()
  const titles = () => findAll(actor.value, (node) => node.type === 'button' && node.props.className === 'dsh-gw-topiclist-title').map(nodeText)
  assert.deepEqual(titles(), ['选题10', '选题2', '选题1'], 'default keeps server order')
  const header = () => find(actor.value, (node) => node.type === api.CollectionSortHead && node.props.field === 'title')
  let th = api.CollectionSortHead(header().props), button = find(th, (node) => node.type === 'button')
  assert.equal(th.props['aria-sort'], 'none'); assert.equal(button.props.type, 'button'); button.props.onClick(); await actor.flush()
  assert.deepEqual(titles(), ['选题1', '选题2', '选题10']); th = api.CollectionSortHead(header().props); assert.equal(th.props['aria-sort'], 'ascending')
  find(th, (node) => node.type === 'button').props.onClick(); await actor.flush(); assert.deepEqual(titles(), ['选题10', '选题2', '选题1']); assert.equal(api.CollectionSortHead(header().props).props['aria-sort'], 'descending')
  assert.deepEqual(records.map((record) => record.title), ['选题10', '选题2', '选题1'], 'sorting never mutates source records'); actor.unmount()
})
test('sorting uses displayed version platform/status/count and ledger metrics instead of fake attributes', () => {
  const a = { record: { title: 'a', front: { platform: '旧平台', views: 999 }, metrics: { views: 2 } }, variants: [{ front: { platform: '抖音' } }], statusText: '已发' }
  const b = { record: { title: 'b', front: { platform: '旧平台', views: 1 }, metrics: { views: 10 } }, variants: Array.from({ length: 10 }, () => ({ front: { platform: '小红书' } })), statusText: '在写' }
  assert.equal(api.collectionSortValue(a, 'platform'), '抖音'); assert.equal(api.collectionSortValue(a, 'status'), '已发'); assert.equal(api.collectionSortValue(a, 'views'), 2)
  assert.deepEqual(api.sortCollectionRows([b, a], { field: 'versions', desc: false }).map((row) => row.record.title), ['a', 'b'])
  assert.deepEqual(api.sortCollectionRows([b, a], { field: 'views', desc: false }).map((row) => row.record.title), ['a', 'b'])
  assert.equal(api.CollectionSortHead({ label: '操作', field: null }).props['aria-sort'], undefined)
})
test('height tracker measures actual element lifetime, de-duplicates rounded heights, and cleans late callbacks', () => {
  const active = new Map(), heights = []; let watches = 0, stops = 0
  const observe = (node, apply) => { watches++; active.set(node, apply); apply(); return () => { stops++; active.delete(node) } }
  const tracker = api.createMeasuredHeightTracker((height) => heights.push(height), observe)
  let measured = 40.2; const first = { isConnected: true, getBoundingClientRect: () => ({ height: measured }) }; tracker.attach(first)
  const oldCallback = active.get(first); for (let count = 0; count < 30; count++) oldCallback(); tracker.attach(first)
  assert.equal(watches, 1); assert.deepEqual(heights, [40]); measured = 41.6; oldCallback(); assert.deepEqual(heights, [40, 42])
  measured = NaN; oldCallback(); first.isConnected = false; measured = 70; oldCallback(); assert.deepEqual(heights, [40, 42])
  tracker.attach(null); oldCallback(); assert.equal(active.size, 0)
  const retry = { isConnected: true, getBoundingClientRect: () => ({ height: 55 }) }; tracker.attach(retry); assert.deepEqual(heights, [40, 42, 55]); tracker.stop(); tracker.stop(); assert.equal(stops, 2)
})
test('actual measured-height hook keeps a stable ref through commits and reconnects after warning retry', async () => {
  const active = new Map(); let observations = 0
  context.watchSize = (node, apply) => { observations++; active.set(node, apply); apply(); return () => active.delete(node) }
  const actor = mount(() => api.useMeasuredBlockHeight(40)); await actor.flush(); const ref = actor.value[0]
  let height = 44; const node = { isConnected: true, getBoundingClientRect: () => ({ height }) }; ref(node); await actor.flush()
  assert.equal(actor.value[1], 44)
  for (let count = 0; count < 10; count++) { actor.update({ count }); await actor.flush(); assert.equal(actor.value[0], ref); active.get(node)() }
  assert.equal(observations, 1); height = 52; active.get(node)(); await actor.flush(); assert.equal(actor.value[1], 52)
  const late = active.get(node); ref(null); assert.equal(active.size, 0); late(); await actor.flush()
  ref({ isConnected: true, getBoundingClientRect: () => ({ height: 60 }) }); await actor.flush(); assert.equal(actor.value[1], 60)
  actor.unmount(); assert.equal(active.size, 0); late(); assert.equal(actor.lateSets, 0)
})

test('real ListPager exposes total/offset/truncation and invokes full-vault q and next page', () => {
  const calls = [], list = { query: '正文', loading: false, loadingMore: false, data: { records: [{ id: 'a' }], total: 401, offset: 0, nextOffset: 200, truncated: true }, setQuery(value) { calls.push(['q', value]) }, loadMore() { calls.push(['next']) } }
  const tree = api.ListPager({ list, label: '选题' })
  assert.equal(tree.props['data-total'], 401); assert.equal(tree.props['data-offset'], 0); assert.equal(tree.props['data-next-offset'], 200); assert.equal(tree.props['data-truncated'], true)
  assert.match(nodeText(tree), /401/); assert.match(nodeText(tree), /201/)
  find(tree, (node) => node.type === 'input').props.onChange({ target: { value: '全正文命中' } })
  find(tree, (node) => node.type === 'button').props.onClick()
  assert.deepEqual(calls, [['q', '全正文命中'], ['next']])
  assert.equal(find(api.ListPager({ list: { ...list, externalSearch: true }, label: '选题' }), (node) => node.type === 'input'), undefined)
})
test('AccountPicker keeps exact selected identity across server search and puts search inside picker', async () => {
  const chosen = { title: '主账号', front: { id: 'account-a', name: '主账号', platform: '抖音' } }
  const list = { query: '', data: { records: [chosen], total: 401, offset: 0, nextOffset: 300, truncated: true }, setQuery() {}, loadMore() {} }
  const props = { platform: '抖音', options: [chosen], value: 'account-a', list, hideCreate: true, onChange() {}, notify() {} }
  const actor = mount(api.AccountPicker, props); await actor.flush()
  assert.ok(find(actor.value, (node) => node.type === api.ListPager && node.props.list === list))
  actor.update({ ...props, options: [], list: { ...list, query: '其他账号', data: { records: [], total: 0, truncated: false } } }); await actor.flush()
  const select = find(actor.value, (node) => node.type === 'select')
  assert.equal(select.props.value, 'account-a'); assert.ok(find(select, (node) => node.type === 'option' && node.props.value === 'account-a'))
  const details = find(actor.value, (node) => node.type === 'details'); let focused = 0
  const event = { key: 'Escape', currentTarget: { open: true, querySelector: () => ({ focus() { focused++ } }) }, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  details.props.onKeyDown(event); assert.equal(event.currentTarget.open, false); assert.equal(event.stopped, true); assert.equal(focused, 1)
  actor.unmount(); assert.equal(actor.lateSets, 0)
})
test('palette picks actual host light/dark surfaces even when OS disagrees, and rendered hex passes AA', () => {
  const cases = [['#ffffff', '#161616', 'dark'], ['rgb(247, 247, 248)', '#242424', 'dark'], ['#ece8e3', '#171717', 'dark'], ['#16181c', '#eeeeee', 'light'], ['rgb(38, 39, 44)', '#eeeeee', 'light'], ['color(srgb 0.16 0.16 0.16)', '#ffffff', 'light'], ['#ffffff', '#e8ebef', 'dark'], ['#1f2126', '#202328', 'light']]
  for (const [background, label, os] of cases) {
    const result = api.hostAccent(background, label, os), base = api.parseSurfaceColor(background), tone = api.parseSurfaceColor(result.color)
    assert.equal(result.scheme, api.surfaceLuminance(base) < 0.3 ? 'dark' : 'light')
    const tinted = base.map((part, index) => part * 0.84 + tone[index] * 0.16)
    assert.ok(api.surfaceContrast(tone, base) >= 4.5, background + ' plain'); assert.ok(api.surfaceContrast(tone, tinted) >= 4.5, background + ' hover')
  }
  assert.equal(api.hostAccent('', '', 'dark').color, '#f0a07e'); assert.equal(api.hostAccent('', '', 'light').color, '#b95f42')
})
test('palette observes only actual host ancestors, deduplicates own writes, and cleans observers/probe', () => {
  const media = new EventBus(), observations = []; let callback, disconnected = 0, removed = 0, writes = 0, background = 'rgb(255, 255, 255)', label = 'rgb(20, 20, 20)'
  const probe = { style: {}, remove() { removed++ } }, parent = { parentElement: { parentElement: null } }
  const values = new Map(), node = { isConnected: true, parentElement: parent, appendChild(value) { assert.equal(value, probe) }, style: { colorScheme: '', getPropertyValue: (key) => values.get(key), setProperty(key, value) { writes++; values.set(key, value) } } }
  const host = { getComputedStyle(target) { return target === probe ? { color: probe.style.color.includes('bg-layer') ? background : label } : { colorScheme: 'dark' } }, matchMedia() { return media }, MutationObserver: class { constructor(apply) { callback = apply } observe(target, options) { observations.push({ target, options }) } disconnect() { disconnected++ } } }
  const cleanup = api.installHostAccent(node, host, { createElement: () => probe })
  assert.equal(node.style.colorScheme, 'light'); assert.equal(observations.length, 2); assert.ok(observations.every(({ target, options }) => target !== node && options.attributes === true && !options.childList && !options.subtree))
  callback(); media.emit('change', {}); assert.equal(writes, 1)
  background = '#1b1d20'; label = '#f4f4f4'; callback(); assert.equal(node.style.colorScheme, 'dark'); assert.equal(writes, 2)
  cleanup(); callback(); media.emit('change', {}); assert.equal(writes, 2); assert.equal(disconnected, 1); assert.equal(removed, 1); assert.equal(media.count(), 0)

  const darkValues = new Map(), darkNode = { isConnected: true, parentElement: parent, appendChild() {}, dataset: {}, style: { colorScheme: '', getPropertyValue: (key) => darkValues.get(key), setProperty(key, value) { darkValues.set(key, value) } } }
  const cleanupDark = api.installHostAccent(darkNode, host, { createElement: () => ({ style: {}, remove() {} }) }, 'dark')
  assert.equal(darkNode.dataset.gwScheme, 'dark'); assert.equal(darkNode.style.colorScheme, 'dark'); assert.equal(darkValues.get('--gw-warm'), '#f0a07e')
  cleanupDark()
})
test('real action menu supports arrow/home/end, one Escape, nontrapped Tab, outside dismissal and cleanup', () => {
  const { doc, root, opener } = focusDOM(), menu = new EventBus(), group = root('menu'); let dismissed = 0
  menu.contains = (node) => node === menu || node === opener || group.buttons.includes(node); menu.querySelectorAll = () => group.buttons
  const cleanup = api.installActionMenu(menu, opener, () => { dismissed++ }, doc)
  assert.equal(doc.activeElement, group.buttons[0])
  const fire = (key) => { const event = keyEvent(key); event.target = doc.activeElement; menu.emit('keydown', event); return event }
  fire('ArrowDown'); assert.equal(doc.activeElement, group.buttons[1]); fire('ArrowDown'); assert.equal(doc.activeElement, group.buttons[0]); fire('End'); assert.equal(doc.activeElement, group.buttons[1]); fire('Home'); assert.equal(doc.activeElement, group.buttons[0])
  assert.equal(fire('Tab').defaultPrevented, false); const escape = fire('Escape'); assert.equal(dismissed, 1); assert.equal(doc.activeElement, opener); assert.equal(escape.defaultPrevented, true)
  doc.emit('pointerdown', { target: {} }); menu.emit('focusout', { relatedTarget: {} }); assert.equal(dismissed, 3)
  cleanup(); assert.equal(menu.count(), 0); assert.equal(doc.count(), 0)
})
test('actual ActionMenu native trigger opens real menu, separates danger and invokes only selected action', async () => {
  let selected = 0
  const actor = mount(api.ActionMenu, { label: '版本更多操作', items: [{ label: '资料', onSelect() { selected++ } }, { label: '删除版本', danger: true, onSelect() { selected += 10 } }] }); await actor.flush()
  const trigger = () => find(actor.value, (node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu')
  assert.equal(trigger().props['aria-expanded'], false); const event = keyEvent('ArrowDown'); trigger().props.onKeyDown(event); await actor.flush()
  const menu = find(actor.value, (node) => node.props.role === 'menu'); assert.ok(menu); assert.equal(menu.props.id, trigger().props['aria-controls']); assert.equal(trigger().props['aria-expanded'], true)
  const danger = find(menu, (node) => node.props['data-tone'] === 'danger'); assert.equal(danger.props['data-separated'], 'true'); assert.equal(danger.props.role, 'menuitem')
  const click = { stopPropagation() {} }; danger.props.onClick(click); await actor.flush(); assert.equal(selected, 10); assert.equal(trigger().props['aria-expanded'], false)
  actor.unmount(); assert.equal(actor.lateSets, 0)
})
test('modal capture leaves first Escape to an open menu, then closes only the modal', () => {
  const { doc, host, root } = focusDOM(), dialog = root('dialog'), menu = { querySelector: () => ({ role: 'menu' }) }; let closed = 0
  const contains = dialog.contains; dialog.contains = (node) => node === menu || contains(node)
  const cleanup = api.installModalFocus(dialog, () => { closed++ }, doc, host)
  const first = keyEvent('Escape'); first.target = { closest: () => menu }; host.emit('keydown', first); assert.equal(closed, 0)
  const second = keyEvent('Escape'); second.target = { closest: () => null }; host.emit('keydown', second); assert.equal(closed, 1)
  cleanup(); assert.equal(doc.count(), 0); assert.equal(host.count(), 0)
})
test('Calendar account identity falls back to exact linked record or stored account instead of disappearing', () => {
  const entry = { accountId: 'a', account: '存量主号' }, records = [{ title: '旧标题', front: { id: 'a', name: '完整账号名' } }]
  assert.equal(api.calendarAccountName(entry, null, records), '完整账号名'); assert.equal(api.calendarAccountName(entry, null, []), '存量主号')
  assert.equal(api.calendarAccountName({ accountId: 'missing' }, null, []), '账号未载入 #missing')
  assert.equal(api.calendarAccountName(entry, { front: { accountId: 'b', account: '版本账号' } }, records), '版本账号')
})
test('actual CalendarCard is stable for 57 equal-height commits, real resize, warning unmount/retry and cleanup', async () => {
  const observations = new Map(), requests = []; let watched = 0, height = 38, warning = false
  context.watchSize = (node, apply) => { watched++; observations.set(node, apply); apply(); return () => observations.delete(node) }
  context.get = async (uri) => {
    requests.push(uri)
    if (uri.startsWith('/calendar?')) { if (warning) throw Object.assign(new Error('temporary read warning'), { code: 'read_warning' }); return { entries: [] } }
    if (uri.startsWith('/v2/variants')) return { variants: [] }
    return { records: [], total: 0, offset: 0, limit: 300, truncated: false }
  }
  const props = { notify() {}, openCard() {}, preset: null }, actor = mount(api.CalendarCard, props); await actor.flush()
  const header = () => find(actor.value, (node) => node.props.className === 'dsh-gw-card-top' && typeof node.props.ref === 'function')
  assert.ok(header(), 'actual Calendar header mounted'); const ref = header().props.ref, node = { isConnected: true, getBoundingClientRect: () => ({ height }) }; ref(node); await actor.flush()
  const fetchCount = requests.length
  for (let count = 0; count < 57; count++) { actor.update({ ...props, count }); await actor.flush(); assert.equal(header().props.ref, ref); observations.get(node)(); assert.equal(actor.dirty, false, 'equal height produces no pending render') }
  assert.equal(watched, 1); assert.equal(requests.length, fetchCount, 'fresh empty arrays never refetch on every commit')
  height = 42; observations.get(node)(); await actor.flush(); assert.equal(actor.dirty, false)
  const oldCallback = observations.get(node); warning = true; refresh++; actor.update(props); await actor.flush(); assert.equal(header(), undefined); ref(null); assert.equal(observations.size, 0)
  const error = find(actor.value, (item) => item.type === api.ErrorBar); assert.equal(error.props.error.code, 'read_warning')
  warning = false; error.props.onRetry(); await actor.flush(); assert.ok(header()); assert.equal(header().props.ref, ref)
  const retried = { isConnected: true, getBoundingClientRect: () => ({ height: 52 }) }; ref(retried); await actor.flush(); assert.equal(watched, 2); oldCallback(); await actor.flush(); assert.equal(actor.dirty, false)
  assert.equal(find(actor.value, (node) => node.props.className === 'dsh-gw-cal').props.style['--dsh-gw-cal-head-h'], '52px'); actor.unmount(); assert.equal(observations.size, 0); oldCallback(); assert.equal(actor.lateSets, 0)
})

test('detail breadcrumb normalizes labels, removes duplicates and preserves an active fallback', () => {
  const calls = []
  const descriptor = api.detailCrumbOf('Archive/missing.md', [
    { path: 'Topics/a.md', front: { name: '命名优先' }, title: '标题' },
    { path: 'Topics/a.md', title: '重复项' },
    { path: 'Topics/b.md', title: '标题优先' },
    { path: 'Topics/c.md' },
  ], (value) => calls.push(value))
  assert.deepEqual(plain(descriptor.options), [
    { value: '', label: '选择当前项目' },
    { value: 'Topics/a.md', label: '命名优先' },
    { value: 'Topics/b.md', label: '标题优先' },
    { value: 'Topics/c.md', label: 'c' },
    { value: 'Archive/missing.md', label: 'missing' },
  ])
  descriptor.onChange(''); descriptor.onChange('Topics/b.md')
  assert.deepEqual(calls, [null, 'Topics/b.md'])
})
test('detail breadcrumb hook reports a stable descriptor and clears it on unmount', async () => {
  const reports = [], chosen = []
  const records = [{ path: 'Topics/a.md', title: 'A' }]
  const actor = mount((props) => { api.useDetailCrumb(props.report, props.value, props.records, props.choose); return null }, { report: (value) => reports.push(value), value: 'Topics/a.md', records, choose: (value) => chosen.push(value) })
  await actor.flush(); assert.equal(reports.length, 1)
  actor.update({ report: actor.props.report, value: 'Topics/a.md', records, choose: (value) => chosen.push('new:' + value) }); await actor.flush()
  assert.equal(reports.length, 1, 'callback identity alone does not republish descriptor')
  reports[0].onChange('Topics/a.md'); assert.deepEqual(chosen, ['new:Topics/a.md'])
  actor.unmount(); assert.equal(reports.at(-1), null)
})

let failed = 0
for (const item of tests) {
  registry = null; refresh = 0; timers.clear()
  try { await item.run(); console.log('ok  ', item.name) }
  catch (error) { failed++; console.error('FAIL', item.name); console.error(error.stack ?? error) }
}
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
