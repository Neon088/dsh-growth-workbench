/**
 * Pure, versioned operational settings.
 *
 * Snapshot schema (v1):
 * `{ schemaVersion, revision, activeProfileId, profiles[] }`. Each profile contains identity,
 * goals/content/audience/platform/account/workflow fields, an action→mode automation map, additive
 * publish gates, observation checkpoints, bounded AI context, in-app reminders, success benchmarks,
 * and a complete `{ id, workspace, order, visible }[]` layout for the supplied card catalog.
 *
 * The module deliberately has no file, clock, network, or UI dependencies. A caller may validate a
 * candidate snapshot, canonicalize it before persistence, and materialize the current card catalog
 * without allowing stored settings to redefine card identity or workspace ownership.
 */

const SCHEMA_VERSION = 1
const AUTOMATION_MODES = new Set(['auto', 'confirm', 'remind', 'off'])
const SAFE_AUTOMATION_ACTIONS = new Set([
  'createDraft', 'suggestCopy', 'prepareAssets', 'scheduleReminder', 'collectMetrics',
])
const FORBIDDEN_AUTOMATION = /(?:external.?publish|publish.?external|delete|overwrite|auto.?close|close.?observation)/i
const AI_SOURCES = new Set(['profile', 'goals', 'content', 'audience', 'copy-rules', 'sop', 'topic', 'product', 'recent-metrics'])
const GATE_TYPES = new Set(['required-field', 'checklist-complete', 'risk-approved', 'account-bound', 'evidence-present', 'min-count'])
const BENCHMARK_MODES = new Set(['fixed', 'recent-average', 'type-median'])
const BENCHMARK_DIRECTIONS = new Set(['at-least', 'at-most'])
const MAX_PROFILES = 50
const MAX_LIST_ITEMS = 100

export class OperationalSettingsError extends Error {
  constructor(message, code = 'invalid_operational_settings', errors = []) {
    super(message)
    this.name = 'OperationalSettingsError'
    this.code = code
    this.errors = errors
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = (value) => {
  if (Array.isArray(value)) return value.map(clone)
  if (plain(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]))
  return value
}
const compareText = (a, b) => String(a).localeCompare(String(b), 'en')
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value)
const boundedText = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.trim() !== '')
const uniqueStrings = (values) => Array.isArray(values) && values.length <= MAX_LIST_ITEMS
  && values.every((value) => boundedText(value, 200, false)) && new Set(values).size === values.length

function catalogInfo(cardCatalog) {
  if (!Array.isArray(cardCatalog)) throw new OperationalSettingsError('cardCatalog 必须是数组', 'invalid_card_catalog')
  const cards = []
  const byId = new Map()
  for (let index = 0; index < cardCatalog.length; index += 1) {
    const card = cardCatalog[index]
    if (!plain(card) || !identifier(card.id) || !identifier(card.workspace)) {
      throw new OperationalSettingsError(`cardCatalog[${index}] 必须包含合法的 id 和 workspace`, 'invalid_card_catalog')
    }
    if (byId.has(card.id)) throw new OperationalSettingsError(`cardCatalog 有重复 card id：${card.id}`, 'duplicate_card')
    const safe = clone(card)
    cards.push(safe)
    byId.set(card.id, { card: safe, index })
  }
  return { cards, byId }
}

function defaultCardLayout(cards, legacyCards) {
  const legacy = new Map()
  if (Array.isArray(legacyCards)) {
    for (const entry of legacyCards) {
      const id = String(entry?.id ?? '')
      if (!legacy.has(id)) legacy.set(id, entry?.enabled !== false)
    }
  }
  const order = new Map()
  return cards.map((card) => {
    const next = order.get(card.workspace) ?? 0
    order.set(card.workspace, next + 1)
    return { id: card.id, workspace: card.workspace, order: next, visible: legacy.has(card.id) ? legacy.get(card.id) : card.enabled !== false }
  })
}

function defaultProfile(cards, legacyCards) {
  return {
    id: 'default',
    name: '默认运营档案',
    description: '',
    goals: [],
    content: { types: [], pillars: [], constraints: [] },
    audience: { segments: [], needs: [] },
    platforms: [],
    accounts: [],
    workflow: { stages: ['plan', 'draft', 'review', 'publish', 'observe'] },
    automation: {
      createDraft: 'confirm',
      suggestCopy: 'confirm',
      prepareAssets: 'confirm',
      scheduleReminder: 'remind',
      collectMetrics: 'remind',
    },
    publishGates: [
      // Rules are additive and opt-in so migrating an existing vault cannot silently block
      // a publish flow that was valid before the operational rule center existed.
      { id: 'publish-checklist', type: 'checklist-complete', enabled: false },
      { id: 'risk-review', type: 'risk-approved', enabled: false },
    ],
    observationCheckpoints: [
      { id: 'day-1', daysAfterPublish: 1, close: false },
      { id: 'day-3', daysAfterPublish: 3, close: false },
      { id: 'day-7', daysAfterPublish: 7, close: true },
    ],
    aiContext: {
      sources: ['profile', 'goals', 'content', 'audience', 'copy-rules'],
      maxItems: 20,
      maxChars: 20000,
      draftOnly: true,
      noOverwrite: true,
    },
    reminders: { channel: 'in-app', enabled: true, leadHours: [0, 24] },
    successBenchmarks: [],
    cardLayout: defaultCardLayout(cards, legacyCards),
  }
}

export function createDefaultOperationalSettings(cardCatalog) {
  const { cards } = catalogInfo(cardCatalog)
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    activeProfileId: 'default',
    profiles: [defaultProfile(cards)],
  }
}

function issue(errors, path, code, message) { errors.push({ path, code, message }) }

function validateContent(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是对象'); return }
  for (const key of ['types', 'pillars', 'constraints']) {
    if (!uniqueStrings(value[key])) issue(errors, `${path}.${key}`, 'invalid_list', `必须是不重复的非空字符串数组，最多 ${MAX_LIST_ITEMS} 项`)
  }
}

function validateAudience(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是对象'); return }
  for (const key of ['segments', 'needs']) {
    if (!uniqueStrings(value[key])) issue(errors, `${path}.${key}`, 'invalid_list', `必须是不重复的非空字符串数组，最多 ${MAX_LIST_ITEMS} 项`)
  }
}

function validateWorkflow(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是对象'); return }
  if (!uniqueStrings(value.stages) || value.stages.length === 0) issue(errors, `${path}.stages`, 'invalid_workflow', '必须至少有一个不重复的工作流阶段')
}

function validateAutomation(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是动作到模式的对象'); return }
  for (const [action, mode] of Object.entries(value)) {
    if (FORBIDDEN_AUTOMATION.test(action)) {
      issue(errors, `${path}.${action}`, 'unsafe_automation', '禁止外部发布、删除、覆盖或自动结案')
      continue
    }
    if (!SAFE_AUTOMATION_ACTIONS.has(action)) issue(errors, `${path}.${action}`, 'unknown_automation', '动作不在安全白名单中')
    if (!AUTOMATION_MODES.has(mode)) issue(errors, `${path}.${action}`, 'invalid_mode', '模式只能是 auto、confirm、remind 或 off')
  }
}

function validateGate(gate, path, errors) {
  if (!plain(gate)) { issue(errors, path, 'type', '必须是对象'); return }
  if (!identifier(gate.id)) issue(errors, `${path}.id`, 'invalid_id', '必须是合法且非空的 id')
  if (!GATE_TYPES.has(gate.type)) issue(errors, `${path}.type`, 'invalid_gate', '是不支持的发布门禁类型')
  if (typeof gate.enabled !== 'boolean') issue(errors, `${path}.enabled`, 'type', '必须是布尔值')
  if (['required-field', 'min-count'].includes(gate.type) && !boundedText(gate.field, 120, false)) issue(errors, `${path}.field`, 'required', '该门禁必须指定字段')
  if (gate.type === 'min-count' && (!finite(gate.min) || gate.min < 0)) issue(errors, `${path}.min`, 'range', '必须是大于等于 0 的有限数值')
}

function validateCheckpoints(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 365) {
    issue(errors, path, 'invalid_checkpoints', '必须包含 1–365 个观察检查点')
    return
  }
  const ids = new Set()
  const days = new Set()
  let closeCount = 0
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!plain(entry)) { issue(errors, at, 'type', '必须是对象'); return }
    if (!identifier(entry.id)) issue(errors, `${at}.id`, 'invalid_id', '必须是合法且非空的 id')
    else if (ids.has(entry.id)) issue(errors, `${at}.id`, 'duplicate', '检查点 id 不能重复')
    else ids.add(entry.id)
    if (!Number.isInteger(entry.daysAfterPublish) || entry.daysAfterPublish < 1 || entry.daysAfterPublish > 365) issue(errors, `${at}.daysAfterPublish`, 'range', '必须是 1–365 的整数')
    else if (days.has(entry.daysAfterPublish)) issue(errors, `${at}.daysAfterPublish`, 'duplicate', '同一天只能有一个检查点')
    else days.add(entry.daysAfterPublish)
    if (typeof entry.close !== 'boolean') issue(errors, `${at}.close`, 'type', '必须是布尔值')
    if (entry.close === true) closeCount += 1
  })
  if (closeCount !== 1) issue(errors, path, 'close_checkpoint', '必须且只能有一个结案检查点')
}

function validateAiContext(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是对象'); return }
  if (!Array.isArray(value.sources) || value.sources.length > 20 || new Set(value.sources).size !== value.sources.length || value.sources.some((source) => !AI_SOURCES.has(source))) {
    issue(errors, `${path}.sources`, 'invalid_ai_source', '只能使用受支持且不重复的 AI 上下文来源')
  }
  if (!Number.isInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 100) issue(errors, `${path}.maxItems`, 'range', '必须是 1–100 的整数')
  if (!Number.isInteger(value.maxChars) || value.maxChars < 100 || value.maxChars > 100000) issue(errors, `${path}.maxChars`, 'range', '必须是 100–100000 的整数')
  if (value.draftOnly !== true) issue(errors, `${path}.draftOnly`, 'unsafe_ai', 'AI 只能生成草稿')
  if (value.noOverwrite !== true) issue(errors, `${path}.noOverwrite`, 'unsafe_ai', 'AI 不得覆盖已有内容')
}

function validateReminders(value, path, errors) {
  if (!plain(value)) { issue(errors, path, 'type', '必须是对象'); return }
  if (value.channel !== 'in-app') issue(errors, `${path}.channel`, 'external_reminder', '提醒只能留在应用内')
  if (typeof value.enabled !== 'boolean') issue(errors, `${path}.enabled`, 'type', '必须是布尔值')
  if (!Array.isArray(value.leadHours) || value.leadHours.length > 20 || new Set(value.leadHours).size !== value.leadHours.length
    || value.leadHours.some((hours) => !Number.isInteger(hours) || hours < 0 || hours > 8760)) {
    issue(errors, `${path}.leadHours`, 'range', '必须是不重复的 0–8760 整数数组')
  }
}

function validateBenchmark(entry, path, checkpointIds, errors) {
  if (!plain(entry)) { issue(errors, path, 'type', '必须是对象'); return }
  if (!identifier(entry.id)) issue(errors, `${path}.id`, 'invalid_id', '必须是合法且非空的 id')
  if (!boundedText(entry.metric, 80, false)) issue(errors, `${path}.metric`, 'required', '必须指定指标字段')
  if (!checkpointIds.has(entry.checkpointId)) issue(errors, `${path}.checkpointId`, 'unknown_checkpoint', '必须引用本档案的观察检查点')
  if (!BENCHMARK_MODES.has(entry.mode)) issue(errors, `${path}.mode`, 'invalid_benchmark', '模式只能是 fixed、recent-average 或 type-median')
  if (!BENCHMARK_DIRECTIONS.has(entry.direction)) issue(errors, `${path}.direction`, 'invalid_direction', '方向只能是 at-least 或 at-most')
  if (entry.mode === 'fixed' && !finite(entry.value)) issue(errors, `${path}.value`, 'required', '固定基准必须包含有限数值 value')
  if (entry.mode === 'recent-average' && (!Number.isInteger(entry.window) || entry.window < 1 || entry.window > 100)) issue(errors, `${path}.window`, 'range', '近期均值窗口必须是 1–100 的整数')
  if (entry.multiplier !== undefined && (!finite(entry.multiplier) || entry.multiplier <= 0 || entry.multiplier > 100)) issue(errors, `${path}.multiplier`, 'range', 'multiplier 必须大于 0 且不超过 100')
}

function validateCardLayout(value, path, catalog, errors) {
  if (!Array.isArray(value)) { issue(errors, path, 'type', '必须是数组'); return }
  const ids = new Set()
  const workspaceOrders = new Set()
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!plain(entry)) { issue(errors, at, 'type', '必须是对象'); return }
    const known = catalog.byId.get(entry.id)
    if (known === undefined) issue(errors, `${at}.id`, 'unknown_card', '卡片 id 不在当前 catalog 中')
    else if (ids.has(entry.id)) issue(errors, `${at}.id`, 'duplicate_card', '卡片 id 不能重复')
    else ids.add(entry.id)
    if (known !== undefined && entry.workspace !== known.card.workspace) issue(errors, `${at}.workspace`, 'cross_workspace', '卡片不能移动到其他 workspace')
    if (!Number.isInteger(entry.order) || entry.order < 0) issue(errors, `${at}.order`, 'range', '必须是大于等于 0 的整数')
    else {
      const orderKey = `${entry.workspace}\0${entry.order}`
      if (workspaceOrders.has(orderKey)) issue(errors, `${at}.order`, 'duplicate_order', '同一 workspace 的 order 不能重复')
      workspaceOrders.add(orderKey)
    }
    if (typeof entry.visible !== 'boolean') issue(errors, `${at}.visible`, 'type', '必须是布尔值')
  })
  for (const card of catalog.cards) if (!ids.has(card.id)) issue(errors, path, 'missing_card', `缺少 catalog 卡片：${card.id}`)
}

function validateProfile(profile, path, catalog, errors) {
  if (!plain(profile)) { issue(errors, path, 'type', '必须是对象'); return }
  if (!identifier(profile.id)) issue(errors, `${path}.id`, 'invalid_id', '必须是合法且非空的 id')
  if (!boundedText(profile.name, 100, false)) issue(errors, `${path}.name`, 'required', '必须是 1–100 字的名称')
  if (!boundedText(profile.description, 500)) issue(errors, `${path}.description`, 'length', '不能超过 500 字')
  if (!uniqueStrings(profile.goals)) issue(errors, `${path}.goals`, 'invalid_list', '必须是不重复的非空字符串数组')
  validateContent(profile.content, `${path}.content`, errors)
  validateAudience(profile.audience, `${path}.audience`, errors)
  if (!uniqueStrings(profile.platforms)) issue(errors, `${path}.platforms`, 'invalid_list', '必须是不重复的平台数组')
  if (!uniqueStrings(profile.accounts)) issue(errors, `${path}.accounts`, 'invalid_list', '必须是不重复的账号数组')
  validateWorkflow(profile.workflow, `${path}.workflow`, errors)
  validateAutomation(profile.automation, `${path}.automation`, errors)
  if (!Array.isArray(profile.publishGates) || profile.publishGates.length > MAX_LIST_ITEMS) issue(errors, `${path}.publishGates`, 'type', '必须是发布门禁数组')
  else {
    const ids = new Set()
    profile.publishGates.forEach((gate, index) => {
      validateGate(gate, `${path}.publishGates[${index}]`, errors)
      if (plain(gate) && identifier(gate.id) && ids.has(gate.id)) issue(errors, `${path}.publishGates[${index}].id`, 'duplicate', '门禁 id 不能重复')
      else if (plain(gate) && identifier(gate.id)) ids.add(gate.id)
    })
  }
  validateCheckpoints(profile.observationCheckpoints, `${path}.observationCheckpoints`, errors)
  validateAiContext(profile.aiContext, `${path}.aiContext`, errors)
  validateReminders(profile.reminders, `${path}.reminders`, errors)
  if (!Array.isArray(profile.successBenchmarks) || profile.successBenchmarks.length > MAX_LIST_ITEMS) issue(errors, `${path}.successBenchmarks`, 'type', '必须是成功基准数组')
  else {
    const checkpointIds = new Set(Array.isArray(profile.observationCheckpoints) ? profile.observationCheckpoints.map((entry) => entry?.id) : [])
    const ids = new Set()
    profile.successBenchmarks.forEach((entry, index) => {
      validateBenchmark(entry, `${path}.successBenchmarks[${index}]`, checkpointIds, errors)
      if (plain(entry) && identifier(entry.id) && ids.has(entry.id)) issue(errors, `${path}.successBenchmarks[${index}].id`, 'duplicate', '基准 id 不能重复')
      else if (plain(entry) && identifier(entry.id)) ids.add(entry.id)
    })
  }
  validateCardLayout(profile.cardLayout, `${path}.cardLayout`, catalog, errors)
}

export function validateOperationalSettings(document, cardCatalog) {
  let catalog
  try { catalog = catalogInfo(cardCatalog) } catch (error) {
    return { ok: false, valid: false, errors: [{ path: 'cardCatalog', code: error.code ?? 'invalid_card_catalog', message: error.message }] }
  }
  const errors = []
  if (!plain(document)) issue(errors, '$', 'type', '运营设置快照必须是对象')
  else {
    if (document.schemaVersion !== SCHEMA_VERSION) issue(errors, '$.schemaVersion', 'schema_version', `只支持 schemaVersion=${SCHEMA_VERSION}`)
    if (!Number.isInteger(document.revision) || document.revision < 1) issue(errors, '$.revision', 'revision', 'revision 必须是正整数')
    if (!identifier(document.activeProfileId)) issue(errors, '$.activeProfileId', 'invalid_id', '必须是合法且非空的 profile id')
    if (!Array.isArray(document.profiles) || document.profiles.length < 1 || document.profiles.length > MAX_PROFILES) issue(errors, '$.profiles', 'profile_count', `必须包含 1–${MAX_PROFILES} 个档案`)
    else {
      const ids = new Set()
      document.profiles.forEach((profile, index) => {
        validateProfile(profile, `$.profiles[${index}]`, catalog, errors)
        if (plain(profile) && identifier(profile.id) && ids.has(profile.id)) issue(errors, `$.profiles[${index}].id`, 'duplicate_profile', 'profile id 不能重复')
        else if (plain(profile) && identifier(profile.id)) ids.add(profile.id)
      })
      if (identifier(document.activeProfileId) && !ids.has(document.activeProfileId)) issue(errors, '$.activeProfileId', 'unknown_profile', 'activeProfileId 必须引用现有档案')
    }
  }
  return { ok: errors.length === 0, valid: errors.length === 0, errors }
}

function assertValid(document, cardCatalog) {
  const result = validateOperationalSettings(document, cardCatalog)
  if (!result.ok) {
    const first = result.errors[0]
    throw new OperationalSettingsError(`${first.path}: ${first.message}`, first.code, result.errors)
  }
}

function canonicalProfile(profile, catalog) {
  const byCatalog = new Map(catalog.cards.map((card, index) => [card.id, index]))
  const cardLayout = profile.cardLayout.map((entry) => ({
    id: entry.id,
    workspace: entry.workspace,
    order: entry.order,
    visible: entry.visible,
  })).sort((a, b) => compareText(a.workspace, b.workspace) || a.order - b.order || (byCatalog.get(a.id) ?? 0) - (byCatalog.get(b.id) ?? 0))
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    goals: [...profile.goals].sort(compareText),
    content: {
      types: [...profile.content.types].sort(compareText),
      pillars: [...profile.content.pillars].sort(compareText),
      constraints: [...profile.content.constraints].sort(compareText),
    },
    audience: {
      segments: [...profile.audience.segments].sort(compareText),
      needs: [...profile.audience.needs].sort(compareText),
    },
    platforms: [...profile.platforms].sort(compareText),
    accounts: [...profile.accounts].sort(compareText),
    workflow: { stages: [...profile.workflow.stages] },
    automation: Object.fromEntries([...SAFE_AUTOMATION_ACTIONS].filter((action) => own(profile.automation, action)).sort(compareText).map((action) => [action, profile.automation[action]])),
    publishGates: profile.publishGates.map((gate) => ({
      id: gate.id, type: gate.type, enabled: gate.enabled,
      ...(gate.field === undefined ? {} : { field: gate.field }),
      ...(gate.min === undefined ? {} : { min: gate.min }),
    })).sort((a, b) => compareText(a.id, b.id)),
    observationCheckpoints: profile.observationCheckpoints.map((entry) => ({ id: entry.id, daysAfterPublish: entry.daysAfterPublish, close: entry.close }))
      .sort((a, b) => a.daysAfterPublish - b.daysAfterPublish || compareText(a.id, b.id)),
    aiContext: {
      sources: [...profile.aiContext.sources].sort(compareText),
      maxItems: profile.aiContext.maxItems,
      maxChars: profile.aiContext.maxChars,
      draftOnly: true,
      noOverwrite: true,
    },
    reminders: {
      channel: 'in-app',
      enabled: profile.reminders.enabled,
      leadHours: [...profile.reminders.leadHours].sort((a, b) => a - b),
    },
    successBenchmarks: profile.successBenchmarks.map((entry) => ({
      id: entry.id,
      metric: entry.metric,
      checkpointId: entry.checkpointId,
      mode: entry.mode,
      direction: entry.direction,
      ...(entry.value === undefined ? {} : { value: entry.value }),
      ...(entry.window === undefined ? {} : { window: entry.window }),
      ...(entry.multiplier === undefined ? {} : { multiplier: entry.multiplier }),
    })).sort((a, b) => compareText(a.checkpointId, b.checkpointId) || compareText(a.metric, b.metric) || compareText(a.id, b.id)),
    cardLayout,
  }
}

export function canonicalOperationalSettings(document, cardCatalog) {
  const catalog = catalogInfo(cardCatalog)
  assertValid(document, cardCatalog)
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: document.revision,
    activeProfileId: document.activeProfileId,
    profiles: document.profiles.map((profile) => canonicalProfile(profile, catalog)).sort((a, b) => compareText(a.id, b.id)),
  }
}

function legacyVisibility(legacyCards, catalog) {
  if (legacyCards === undefined || legacyCards === null) return undefined
  if (!Array.isArray(legacyCards)) throw new OperationalSettingsError('legacyCards 必须是数组', 'invalid_legacy_cards')
  const known = new Set(catalog.cards.map((card) => card.id))
  const seen = new Set()
  for (const [index, entry] of legacyCards.entries()) {
    const id = String(entry?.id ?? '')
    if (!known.has(id)) throw new OperationalSettingsError(`legacyCards[${index}] 包含未知卡片：${id}`, 'unknown_card')
    if (seen.has(id)) throw new OperationalSettingsError(`legacyCards 有重复卡片：${id}`, 'duplicate_card')
    if (typeof entry?.enabled !== 'boolean') throw new OperationalSettingsError(`legacyCards[${index}].enabled 必须是布尔值`, 'invalid_legacy_cards')
    seen.add(id)
  }
  return legacyCards
}

export function migrateOperationalSettings(raw, { legacyCards, cardCatalog } = {}) {
  const catalog = catalogInfo(cardCatalog)
  if (plain(raw) && raw.schemaVersion === SCHEMA_VERSION) return canonicalOperationalSettings(raw, cardCatalog)
  if (raw !== undefined && raw !== null && !(plain(raw) && Object.keys(raw).length === 0)) {
    throw new OperationalSettingsError('无法迁移未知的运营设置格式', 'unsupported_operational_settings')
  }
  const imported = legacyVisibility(legacyCards, catalog)
  const document = {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    activeProfileId: 'default',
    profiles: [defaultProfile(catalog.cards, imported)],
  }
  return canonicalOperationalSettings(document, cardCatalog)
}

function profileOf(document, profileId) {
  const profile = document.profiles.find((entry) => entry.id === profileId)
  if (profile === undefined) throw new OperationalSettingsError(`找不到运营档案：${profileId}`, 'not_found')
  return profile
}

export function materializeCards(document, cardCatalog, profileId = document.activeProfileId) {
  assertValid(document, cardCatalog)
  const catalog = catalogInfo(cardCatalog)
  const profile = profileOf(document, profileId)
  const layout = new Map(profile.cardLayout.map((entry) => [entry.id, entry]))
  return catalog.cards.map((card, catalogIndex) => {
    const setting = layout.get(card.id)
    return { ...clone(card), enabled: setting.visible, visible: setting.visible, order: setting.order, _catalogIndex: catalogIndex }
  }).sort((a, b) => compareText(a.workspace, b.workspace) || a.order - b.order || a._catalogIndex - b._catalogIndex)
    .map(({ _catalogIndex, ...card }) => card)
}

function fieldAt(context, path) {
  return String(path).split('.').reduce((value, key) => value === null || value === undefined ? undefined : value[key], context)
}

function gateResult(gate, context) {
  let passed = false
  if (gate.type === 'required-field') {
    const value = fieldAt(context, gate.field)
    passed = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== ''
  } else if (gate.type === 'checklist-complete') passed = context?.checklistComplete === true || context?.checklist?.complete === true
  else if (gate.type === 'risk-approved') passed = !/(?:高|禁发|high|blocked)/i.test(String(context?.riskLevel ?? context?.risk ?? '')) || context?.riskApproved === true
  else if (gate.type === 'account-bound') passed = String(context?.accountId ?? context?.account?.id ?? '').trim() !== ''
  else if (gate.type === 'evidence-present') passed = (Array.isArray(context?.evidence) && context.evidence.length > 0) || String(context?.evidence ?? '').trim() !== ''
  else if (gate.type === 'min-count') {
    const value = fieldAt(context, gate.field)
    const count = Array.isArray(value) || typeof value === 'string' ? value.length : Number(value)
    passed = Number.isFinite(count) && count >= gate.min
  }
  return { id: gate.id, type: gate.type, passed, ...(passed ? {} : { reason: `发布门禁未通过：${gate.id}` }) }
}

export function evaluatePublishGate(profile, context) {
  const gates = Array.isArray(profile?.publishGates) ? profile.publishGates.filter((gate) => gate?.enabled === true) : []
  const results = gates.map((gate) => gateResult(gate, context ?? {}))
  return { ok: results.every((entry) => entry.passed), passed: results.filter((entry) => entry.passed), failed: results.filter((entry) => !entry.passed), results }
}

export function buildObservationPlan(profile, publishedAt) {
  const instant = publishedAt instanceof Date ? new Date(publishedAt.getTime()) : new Date(publishedAt)
  if (!Number.isFinite(instant.getTime())) throw new OperationalSettingsError('publishedAt 必须是有效时间', 'bad_field')
  const checkpoints = Array.isArray(profile?.observationCheckpoints) ? profile.observationCheckpoints : []
  const probe = { ...createDefaultOperationalSettings([]).profiles[0], ...profile, observationCheckpoints: checkpoints, cardLayout: [] }
  const errors = []
  validateCheckpoints(probe.observationCheckpoints, '$.profile.observationCheckpoints', errors)
  if (errors.length > 0) throw new OperationalSettingsError(errors[0].message, errors[0].code, errors)
  return checkpoints.slice().sort((a, b) => a.daysAfterPublish - b.daysAfterPublish || compareText(a.id, b.id)).map((checkpoint) => ({
    checkpointId: checkpoint.id,
    daysAfterPublish: checkpoint.daysAfterPublish,
    dueAt: new Date(instant.getTime() + checkpoint.daysAfterPublish * 86400000).toISOString(),
    close: checkpoint.close,
    status: 'pending',
  }))
}

function numericSeries(value, metricName) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => plain(entry) ? Number(entry[metricName]) : Number(entry)).filter(Number.isFinite)
}
function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function evaluateSuccessBenchmarks(profile, metric, checkpointId) {
  const benchmarks = Array.isArray(profile?.successBenchmarks) ? profile.successBenchmarks.filter((entry) => entry?.checkpointId === checkpointId) : []
  const results = benchmarks.map((benchmark) => {
    const actual = Number(fieldAt(metric, benchmark.metric))
    let baseline
    if (benchmark.mode === 'fixed') baseline = benchmark.value
    else if (benchmark.mode === 'recent-average') {
      const direct = Number(metric?.recentAverages?.[benchmark.metric])
      const series = numericSeries(metric?.recent ?? metric?.history, benchmark.metric).slice(-benchmark.window)
      baseline = Number.isFinite(direct) ? direct : series.length > 0 ? series.reduce((sum, value) => sum + value, 0) / series.length : undefined
    } else if (benchmark.mode === 'type-median') {
      const direct = Number(metric?.typeMedians?.[benchmark.metric])
      const series = numericSeries(metric?.sameType ?? metric?.typeHistory, benchmark.metric)
      baseline = Number.isFinite(direct) ? direct : median(series)
    }
    const target = Number.isFinite(baseline) ? baseline * (benchmark.multiplier ?? 1) : undefined
    const evaluable = Number.isFinite(actual) && Number.isFinite(target)
    const passed = evaluable && (benchmark.direction === 'at-most' ? actual <= target : actual >= target)
    return {
      id: benchmark.id,
      metric: benchmark.metric,
      checkpointId,
      mode: benchmark.mode,
      direction: benchmark.direction,
      actual: Number.isFinite(actual) ? actual : null,
      baseline: Number.isFinite(baseline) ? baseline : null,
      target: Number.isFinite(target) ? target : null,
      evaluable,
      passed,
      ...(!evaluable ? { reason: `缺少可计算的指标或基准：${benchmark.id}` } : {}),
    }
  })
  return {
    ok: results.length > 0 && results.every((entry) => entry.passed),
    checkpointId,
    evaluated: results.filter((entry) => entry.evaluable).length,
    results,
  }
}
