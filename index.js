/**
 * dsh-growth-workbench — Host 侧。
 * 把 vault 里的 md 文件变成本机 loopback-only JSON API，浏览器半边（client.js）只渲染。
 * 架构照搬 dsh-legal-workbench：Cordis 插件 inject:['webServer']，把
 * /api/dsh-growth 用 kind:'prefix' 挂到 DSH 自己的 webServer 上（不开新端口）。
 * 统一响应 { ok:true, ... } / { ok:false, code, message }。
 */
import { spawn, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, relative, sep, isAbsolute, resolve, parse as parsePath, dirname } from 'node:path'
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createTable, TableValidationError } from './lib/table.js'
import { createVaultStore, VaultError, sectionsOf, withFileWriteLock, atomicWriteFile, normalizeVaultSubdir, assertPathInsideRoot } from './lib/vault.js'
import * as rules from './lib/rules.js'
import * as fm from './lib/frontmatter.js'
import * as csv from './lib/csv.js'
import { registerVaultTool } from './lib/agent-tool.js'
import { PLATFORMS, normalizePlatform, platformOptions, splitPlatforms } from './lib/platforms.js'
import { parseChecklist, checklistState, CHECKLIST_TITLE_HINTS } from './lib/checklist.js'
import { createDomainStore, VARIANT_STATUSES, VARIANT_TRANSITIONS, normalizeVariantStatus } from './lib/domain.js'
import { buildObservationPlan, canonicalOperationalSettings, createDefaultOperationalSettings, evaluatePublishGate, evaluateSuccessBenchmarks, materializeCards, migrateOperationalSettings, OperationalSettingsError } from './lib/operational-settings.js'
import { createMigrator } from './lib/migrate.js'
import { fetchLatestRelease, interpretRelease } from './lib/updates.js'

const API_PREFIX = '/api/dsh-growth'
const MAX_BODY_BYTES = 1024 * 1024

// 版本号只留一份真源：package.json。以前 /ping 里硬写着 '0.1.0'，
// 升到 0.2.0 之后这里还报旧号 —— 排查问题时先被自己的版本号骗一次。
const PKG_VERSION = (() => {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
    return String(JSON.parse(readFileSync(file, 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()

// 「检查更新」只读：问 GitHub 要 latest Release，和 PKG_VERSION 比一下。
// 缓存 10 分钟 —— 设置页可能被反复点，别把 GitHub 的匿名配额（60 次/小时）点光。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const UPDATE_CACHE_MS = 10 * 60_000
let updateCache = { at: 0, value: null }

/**
 * 安装方式只影响「怎么更新」这句提示，不影响检查本身：
 * .git 在插件目录里 = 源码 clone（或 junction 到 clone），git pull 就行；
 * 否则是市场装进 node_modules 的副本，要回市场重装。
 */
async function updateState(force) {
  const now = Date.now()
  if (!force && updateCache.value !== null && now - updateCache.at < UPDATE_CACHE_MS) return updateCache.value
  const checkedAt = new Date().toISOString()
  let value
  try {
    value = interpretRelease({ current: PKG_VERSION, release: await fetchLatestRelease(), checkedAt })
  } catch (error) {
    // 连不上 GitHub 不算错误状态：当前版本照样显示，只把原因写进 error。
    value = interpretRelease({ current: PKG_VERSION, release: null, checkedAt })
    value.error = describe(error)
  }
  value.installKind = existsSync(join(PLUGIN_DIR, '.git')) ? 'git' : 'copy'
  value.repo = 'Neon088/dsh-growth-workbench'
  updateCache = { at: Date.now(), value }
  return value
}

const DEFAULT_CARDS = [
  { id: 'accounts', workspace: 'ops', title: '账号档案', icon: '👤', enabled: true },
  { id: 'ideas', workspace: 'ops', title: '灵感箱', icon: '💡', enabled: true },
  { id: 'topics', workspace: 'ops', title: '爆款拆解', icon: '🎯', enabled: true },
  { id: 'studio', workspace: 'ops', title: '我的选题', icon: '🎬', enabled: true },
  { id: 'calendar', workspace: 'ops', title: '内容日历', icon: '🗓️', enabled: true },
  { id: 'pending', workspace: 'ops', title: '待回填数据', icon: '📥', enabled: true },
  { id: 'contentdata', workspace: 'ops', title: '数据复盘', icon: '📊', enabled: true },
  { id: 'products', workspace: 'ecom', title: '商品 / 竞品库', icon: '🏷️', enabled: true },
  { id: 'feedback', workspace: 'ecom', title: '客户反馈库', icon: '💬', enabled: true },
  { id: 'data', workspace: 'ecom', title: '电商数据复盘', icon: '📈', enabled: true },
  { id: 'campaigns', workspace: 'mkt', title: '营销方案库', icon: '📣', enabled: true },
  { id: 'sop', workspace: 'common', title: 'SOP 树', icon: '📚', enabled: true },
  { id: 'copyrules', workspace: 'common', title: '文案规则 / 语调库', icon: '✍️', enabled: true },
  { id: 'glossary', workspace: 'common', title: '术语表', icon: '🔤', enabled: true },
]

const STATUS_BY_CODE = new Map([
  ['bad_request', 400], ['bad_path', 400], ['bad_json', 400], ['bad_field', 400],
  ['bad_frontmatter', 400], ['invalid_table', 400], ['duplicate', 409], ['conflict', 409],
  ['exists', 409], ['not_found', 404], ['read_failed', 500], ['write_failed', 500],
  ['backup_failed', 500], ['list_failed', 500], ['stat_failed', 500], ['busy', 409],
])

const OPEN_HOSTS = new Set([
  'obsidian.md', 'github.com', 'bilibili.com', 'www.bilibili.com', 'xiaohongshu.com',
  'www.xiaohongshu.com', 'douyin.com', 'www.douyin.com', 'weibo.com', 'www.weibo.com',
  'mp.weixin.qq.com', 'taobao.com', 'www.taobao.com', 'tmall.com', 'www.tmall.com',
  'jd.com', 'www.jd.com', 'pinduoduo.com', 'www.pinduoduo.com', 'yangkeduo.com',
])

const DEFAULT_DIRS = {
  vaultRoot: '',
  sopDir: 'SOP',
  workbenchDir: 'Workbench',
  copyRulesDir: 'CopyRules',
  topicsDir: 'Topics',
  campaignsDir: 'Campaigns',
  dataDir: 'Data',
  feedbackDir: 'Feedback',
  productsDir: 'Products',
  accountsDir: 'Accounts',
  calendarDir: 'Calendar',
  pluginDataDir: '',
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

// 本地时区的日期。以前用 toISOString()（UTC）：东八区 00:00–08:00 之间操作，
// 日期会算成前一天、月初会算成前一月，排期和回流就会落到错的 YYYY-MM.md 里。
// now 参数只为测试可注入，正常调用不传。
function localDay(now) {
  const date = now instanceof Date ? now : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function dayInZone(zone = 'Asia/Shanghai', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const take = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return take('year') + '-' + take('month') + '-' + take('day')
}

// 选题的稳定 ID。新建时随机生成并写进 frontmatter；老笔记没有 id 时按路径算一个
// 确定性回退值（同一路径每次算出来一样），等迁移时再补写，不会因为改标题就换身份。
function newTopicId() {
  return randomBytes(6).toString('hex')
}

function topicIdOf(front, path) {
  const stored = String(front?.id ?? '').trim()
  if (stored !== '') return stored
  return 't' + createHash('sha1').update(String(path ?? '')).digest('hex').slice(0, 11)
}

function today(now) {
  return localDay(now)
}

function thisMonth(now) {
  return localDay(now).slice(0, 7)
}

function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  // Host 头校验：防 DNS rebinding。只接受本机回环地址，不能是任意域名。
  const host = String(req.headers?.host ?? '').trim().toLowerCase()
  if (host !== '') {
    let hostname = ''
    try { hostname = new URL('http://' + host).hostname.toLowerCase() } catch { return false }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return false
  }
  // Origin 头同样只接受本机页面；curl/脚本不带 Origin，照旧放行。
  const origin = String(req.headers?.origin ?? '').trim()
  if (origin !== '' && origin !== 'null') {
    let originHost = ''
    try { originHost = new URL(origin).hostname.toLowerCase() } catch { return false }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(originHost)) return false
  }
  return true
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new VaultError('请求体超过 1MB', 'bad_json'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new VaultError('请求体不是合法 JSON：' + describe(error), 'bad_json'))
      }
    })
    req.on('error', (error) => reject(new VaultError('读取请求体失败：' + describe(error), 'bad_json')))
  })
}

async function atomicWrite(file, text) {
  return withFileWriteLock(file, () => atomicWriteFile(file, text))
}

function pageBounds({ offset, limit } = {}, defaultLimit = 300) {
  const integer = (value, fallback) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback
    const number = Number(value)
    return Number.isFinite(number) ? Math.floor(number) : fallback
  }
  return { offset: Math.min(Math.max(integer(offset, 0), 0), Number.MAX_SAFE_INTEGER),
    limit: Math.min(Math.max(integer(limit, defaultLimit), 1), 1000) }
}

function safeFileName(input, fallback = '未命名') {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    // 文件名以 . 开头在 Windows 上会被拒（也是隐藏文件），顺手剥掉开头多余的点与空格。
    // 以 # 开头则在 Obsidian 的 URI 里会被当成「标题」而不是文件名。
    .replace(/^[.\s]+/, '')
    .slice(0, 60)
    .trim()
  return cleaned === '' ? fallback : cleaned
}

/**
 * 新建笔记时用户填的「目录 / 分类」：允许 a/b 两三层，每段都过一遍 safeFileName，
 * 剥掉路径分隔符和 .. 这类能跳出板块目录的写法。留空 = 直接放在板块根下。
 */
function safeSubDir(input) {
  return String(input ?? '')
    .split(/[\\/]+/)
    .map((part) => safeFileName(part, ''))
    .filter((part) => part !== '')
    .slice(0, 3)
    .join('/')
}

/**
 * 把 URI / 路径交给系统打开。失败必须说出来——以前这里把错误吞掉，
 * 前端只能看到「没反应」，根本没法判断是路径错、协议没注册还是别的。
 */
function spawnOpen(target, what) {
  const command = openCommand(target)
  // 先 spawn 再看退出码，不等回调：Windows 上 `cmd /c start` 会因为继承了
  // 管道句柄而一直挂住，GUI 程序（Obsidian）同理，等它「退出」永远等不到。
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: false })
    } catch (error) {
      reject(new VaultError(what + '失败：' + describe(error), 'open_failed'))
      return
    }
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error === undefined || error === null) resolve(true)
      else reject(new VaultError(what + '失败：' + describe(error), 'open_failed'))
    }
    child.once('error', finish)
    child.once('spawn', () => {
      // 交给系统后立刻放手，别让子进程的生命周期绑在我们的请求上。
      child.unref()
      finish(null)
    })
  })
}

// 从注册表的协议处理命令里拿出 exe 路径："E:\\Obsidian\\Obsidian.exe" "%1" → E:\Obsidian\Obsidian.exe
// 拿不到就返回空串，交给后面的兜底。
function protocolExe(target) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)
  if (scheme === null) return ''
  const key = 'HKCR\\' + scheme[1] + '\\shell\\open\\command'
  try {
    // reg query 吐的是控制台 OEM 代码页（中文系统 GBK）。只取 ASCII 的 exe 路径，
    // 用 latin1 保住字节边界就够了，按 utf8 解码反而会让匹配错位。
    const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'latin1', windowsHide: true, timeout: 4000 })
    const quoted = /"([^"]+)"/.exec(out)
    if (quoted !== null) return quoted[1]
    const bare = /REG_(?:EXPAND_)?SZ\s+(.+?\.[a-z0-9]+)\s*$/im.exec(out)
    return bare === null ? '' : bare[1].replace(/^"|"$/g, '')
  } catch {
    return ''
  }
}

function openCommand(target) {
  const custom = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(file|https?):/i.test(target)
  if (process.platform === 'win32') {
    // 自定义协议（obsidian://）走过两次弯路，记下来免得再踩：
    //  1) cmd /c start —— start 把 URI 当文件名去 ShellExecute，还自己补一个前导
    //     反斜杠，Windows 于是弹「找不到文件 '\obsidian://...'」。加引号、
    //     关延迟展开都救不了，因为它压根没把 URI 当协议。
    //  2) rundll32 url.dll,FileProtocolHandler —— 能起来，但它在转交时把 URI
    //     改写成 obsidian://open/?vault=... （open 后面多一个 /），Obsidian 收到
    //     这条命令行就只拉进程、不开窗口。
    // 最直接的办法：问注册表要 exe，把 URI 原样交给它，中间不经过任何会改写的层。
    if (custom) {
      const exe = protocolExe(target)
      if (exe !== '') return { file: exe, args: [target] }
    }
    return { file: 'explorer.exe', args: [target] }
  }
  if (process.platform === 'darwin') return { file: '/usr/bin/open', args: [target] }
  return { file: 'xdg-open', args: [target] }
}


export const inject = ['webServer']

/**
 * 本机 API 的通行证。
 *
 * DSH 的 GUI 有登录态，插件的路由却挂在它外面（同端口、不同路径），
 * 任何网页都能对 http://127.0.0.1:<port>/api/dsh-growth/... 发请求 ——
 * 旧版连 token 都不要，等于把「读写 vault」开给了互联网。
 * 现在：所有 API 请求都必须带这个进程级 token —— 浏览器页面从 /token 领，
 * 本机脚本从 <dataDir>/session-token 读（0600，只有当前用户能读）；
 * 跨站请求（sec-fetch-site: cross-site）直接 403。
 * 「没有 sec-fetch-site 头就整体放行」那条后门已经删掉：curl 和任何本机进程
 * 一样要带票，否则等于没设门槛。
 *
 * 但 /token 这一处不能只认 sec-fetch-site。实测（2026-11-15，见 token-probe.log）
 * 桌面端渲染进程发出的 fetch 根本没有 sec-fetch-site 头，只有 Origin。
 * 早先版本把 /token 限成「必须 same-origin」，页面就永远领不到票，读写全部
 * 401「缺少访问凭证」，刷新也没用 —— 当时「无头就放行」的后门恰好把数据路由
 * 捞了回来，所以看着是好的。现在 /token 只拒 cross-site：浏览器一定带这个头，
 * 跨站页面必被 403；就算漏过去，没有 CORS 响应头也读不到 JSON（同源策略）；
 * 真正会改数据的路由仍然逐个校验 token，CSRF 面没有变大。
 *
 * 事件流（EventSource 加不了自定义头）另给一张一次性 ticket：
 * POST 不了就 GET /events-ticket 换票，60 秒内有效、用一次即作废，
 * token 不再出现在 URL 和访问日志里。
 */
const AUTH_TOKEN = randomBytes(24).toString('hex')
const EVENT_TICKET_TTL_MS = 60_000
const EVENT_TICKET_MAX = 64
const eventTickets = new Map()

function pruneEventTickets(now) {
  for (const [ticket, expiresAt] of eventTickets) if (expiresAt <= now) eventTickets.delete(ticket)
}

function issueEventTicket() {
  const now = Date.now()
  pruneEventTickets(now)
  while (eventTickets.size >= EVENT_TICKET_MAX) eventTickets.delete(eventTickets.keys().next().value)
  const ticket = randomBytes(18).toString('hex')
  eventTickets.set(ticket, now + EVENT_TICKET_TTL_MS)
  return ticket
}

/** 单次使用：取走就删，过期也算无效 —— 票泄漏了也只能换到一次连接。 */
function consumeEventTicket(ticket) {
  if (typeof ticket !== 'string' || ticket === '') return false
  const expiresAt = eventTickets.get(ticket)
  if (expiresAt === undefined) return false
  eventTickets.delete(ticket)
  return expiresAt > Date.now()
}

/**
 * 刻意不导出 Config。
 *
 * 桌面外壳把「启动失败的条目」当作致命错误（dsh-unlag 原话：a plugin that cannot start is
 * worse than a plugin that does nothing）。而 Config 一旦在 schema 校验上抛错，整个条目就在
 * 启动期被拒掉 —— 这就是把这个插件塞进 profile 后 DSH 起不来的原因之一。
 *
 * 配置全部走 cordis.patch.yml 的 config 段，由 apply 里的 DEFAULT_DIRS 兜底合并；
 * 首次使用的 vault 路径存在 ~/.dsh-growth/config.json，不依赖 Cordis 的配置校验。
 */

export function apply(ctx, config) {
  const logger = ctx.logger ?? { info() {}, warn() {}, error() {} }
  const profile = { ...DEFAULT_DIRS, vaultRoot: '', ...(config ?? {}) }

  // 启动痕迹。DSH 没有主日志文件，插件加载失败又会被桌面外壳静默吞掉，
  // 所以这里自己留一行：只要这个文件出现时间戳，就说明宿主半边真的跑起来了。
  const traceDir = join(homedir(), '.dsh-growth')
  // 日志文件都要有上限：超过就轮转一份旧的，绝不无限膨胀。
  const rotateAppend = (file, line, maxBytes) => {
    try {
      let size = 0
      try { size = statSync(file).size } catch { /* 首次写入 */ }
      if (size > maxBytes) {
        try { rmSync(file + '.1', { force: true }) } catch { /* 旧轮转不存在 */ }
        try { renameSync(file, file + '.1') } catch { /* 换名失败就继续追加 */ }
      }
      appendFileSync(file, line)
    } catch {
      // 记不上不影响任何功能。
    }
  }
  const trace = (line) => {
    rotateAppend(join(traceDir, 'startup.log'), `${new Date().toISOString()} ${line}\n`, 128 * 1024)
  }
  // 例行成功探测（apply / 挂接 / 会话桥等）只在进程内记第一次；失败与状态变化永远记。
  const ROUTINE_LOG_LABELS = new Set(['apply', 'inject', 'sidebar tab:registered', 'sidebar tab:slots', 'sidebar tab:already', 'fallback overlay:skipped', 'input bridge:attached', 'openRight:ok', 'closeRight:ok'])
  const clientLogSeen = new Set()
  try {
    mkdirSync(traceDir, { recursive: true })
  } catch {}
  const configKeys = Object.keys(config ?? {}).length
  trace(`apply start; hasCtx=${ctx !== void 0}; configKeys=${configKeys}${configKeys === 12 ? '' : '; keys=' + Object.keys(config ?? {}).join(',')}`)

  let userConfig = {}
  let operationalSettings = createDefaultOperationalSettings(DEFAULT_CARDS)
  let cards = materializeCards(operationalSettings, DEFAULT_CARDS)
  let operationalSettingsLoadError = null
  let vault = null
  let domain = null
  let migrator = null
  let rulesPath = ''
  const tables = {}
  const collections = {}

  function dataDir() {
    // 优先用「已经读进内存的」用户配置：config.json 自己就放在这个目录里，
    // 所以它在保存成功之前不能反过来决定目录位置。
    const override = String(userConfig.pluginDataDir ?? '').trim()
    if (override !== '') return override
    const configured = String(profile.pluginDataDir ?? '').trim()
    return configured !== '' ? configured : join(homedir(), '.dsh-growth')
  }

  function cfg(key) {
    const override = userConfig[key]
    if (typeof override === 'string' && override.trim() !== '') return override.trim()
    const fromProfile = String(profile[key] ?? '').trim()
    if (fromProfile !== '') return fromProfile
    return DEFAULT_DIRS[key] ?? ''
  }

  function vaultRoot() {
    return cfg('vaultRoot')
  }

  // SOP 默认只管理 vault 下的 SOP/。旧逻辑在目录不存在时退回整个 vault，
  // 会让「SOP 树」变成第二个全库文件浏览器，也把其它 Obsidian 文件暴露给编辑操作。
  function sopDirValue() {
    const configured = String(cfg('sopDir') ?? '').trim()
    return configured === '' ? 'SOP' : configured
  }

  // 绝对路径 → 相对 vault 根的 posix 路径。
  // 注意：必须在 apply 里面定义，它要闭包拿 vaultRoot()；
  // 之前误放在模块顶层，所有走它的接口都炸「vaultRoot is not defined」。
  // 不在 vault 里（父目录、盘符不同）一律返回空串：宁可把按钮禁掉，
  // 也不要让用户点出一个「路径越出 vault 根目录」。
  function relToVault(abs) {
    const target = String(abs ?? '').trim()
    if (target === '') return ''
    const rel = relative(String(vaultRoot()).trim(), target).split(sep).join('/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || /^[a-zA-Z]:\//.test(rel)) return ''
    return rel
  }

  function dirOf(key) {
    return join(vaultRoot(), normalizeVaultSubdir(cfg(key)))
  }

  function createWorkbenchTable(spec) {
    // 备份路径和笔记写入/删除走同一个算法（vault.backupPathFor）：
    // 备份目录 + 原相对路径 + .bak。以前表格备份固定写「原文件旁边.md.bak」，
    // 备份散落在 Obsidian 库里会被当成正常笔记索引出来。
    return createTable({
      ...spec,
      validatePath: (file) => vault.assertInsidePath(file),
      backupPath: (file) => vault.backupPathFor(file),
    })
  }

  /**
   * 前端手上的路径花样很多：相对 vault 的「Topics/111.md」、绝对路径
   * 「D:\Notes\Topics\111.md」、URL 编码过的、只有标题没有目录的、甚至整条
   * obsidian:// URI。以前只认第一种，其余都被算成空路径 —— 于是按钮点了报
   * 「路径为空」，而「删除」因为拿不到合法路径干脆没有渲染出来。
   * 这里统一收口成相对 vault 的路径；实在对不上就原样返回，让调用方去报 not_found。
   */
  async function resolveNotePath(input) {
    let raw = String(input ?? '').trim()
    if (raw === '') return ''
    if (/%[0-9a-f]{2}/i.test(raw)) {
      try { raw = decodeURIComponent(raw) } catch { /* 不是编码就原样用 */ }
    }
    // 从 Obsidian 地址栏复制过来的整条 URI。
    if (/^obsidian:\/\//i.test(raw)) {
      try {
        raw = new URL(raw).searchParams.get('file') ?? ''
      } catch {
        raw = ''
      }
      raw = raw.trim()
      if (raw === '') return ''
      if (!/\.md$/i.test(raw)) raw += '.md'
    }
    const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')
    const fromRel = relToVault(raw)
    const candidate = fromRel !== '' ? fromRel : (absolute ? '' : raw.replace(/^[/\\]+/, ''))
    if (candidate === '') return ''
    const relay = candidate.replace(/\\/g, '/')
    if (await vault.exists(relay)) return relay
    if (!/\.md$/i.test(relay)) {
      const withSuffix = relay + '.md'
      if (await vault.exists(withSuffix)) return withSuffix
    }
    // 只剩标题时按文件名在库里找一遍 —— 卡片列表给出来的常常就是标题。
    const leaf = relay.split('/').pop().replace(/\.md$/i, '')
    if (leaf === '' || relay.includes('/')) return relay
    try {
      const { notes } = await vault.discover()
      const hit = notes.find((note) => note.path.split('/').pop().replace(/\.md$/i, '') === leaf)
      return hit === undefined ? relay : hit.path
    } catch {
      return relay
    }
  }

  function operationalRulesPath() {
    return join(dataDir(), 'operational-rules.json')
  }

  async function loadState() {
    try {
      userConfig = JSON.parse(await readFile(join(dataDir(), 'config.json'), 'utf8'))
    } catch {
      userConfig = {}
    }
    let legacyCards = DEFAULT_CARDS.map((card) => ({ id: card.id, enabled: card.enabled !== false }))
    try {
      const parsed = JSON.parse(await readFile(join(dataDir(), 'cards.json'), 'utf8'))
      if (Array.isArray(parsed)) {
        const requested = new Map(parsed.map((entry) => [String(entry?.id ?? ''), entry?.enabled !== false]))
        legacyCards = legacyCards.map((entry) => requested.has(entry.id) ? { ...entry, enabled: requested.get(entry.id) } : entry)
      }
    } catch {
      // 没有旧版卡片快照就用 catalog 默认值。
    }
    operationalSettingsLoadError = null
    try {
      await withFileWriteLock(operationalRulesPath(), async () => {
        let raw = null
        let exists = true
        try {
          raw = JSON.parse(await readFile(operationalRulesPath(), 'utf8'))
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          exists = false
        }
        operationalSettings = migrateOperationalSettings(raw, {
          legacyCards: exists ? undefined : legacyCards,
          cardCatalog: DEFAULT_CARDS,
        })
        if (!exists) {
          await atomicWriteFile(operationalRulesPath(), JSON.stringify(operationalSettings, null, 2) + '\n', {
            beforeCommit: async () => {
              try {
                await stat(operationalRulesPath())
                throw new VaultError('运营设置已由其他实例创建，重新载入后再试', 'conflict')
              } catch (error) {
                if (error instanceof VaultError) throw error
                if (error?.code !== 'ENOENT') throw error
              }
            },
          })
        }
      })
      cards = materializeCards(operationalSettings, DEFAULT_CARDS)
    } catch (error) {
      operationalSettingsLoadError = error
      cards = DEFAULT_CARDS.map((card) => {
        const legacy = legacyCards.find((entry) => entry.id === card.id)
        return { ...card, enabled: legacy?.enabled !== false }
      })
    }
  }

  async function saveUserConfig(nextUserConfig = userConfig) {
    await mkdir(dataDir(), { recursive: true })
    await atomicWrite(join(dataDir(), 'config.json'), JSON.stringify(nextUserConfig, null, 2) + '\n')
  }

  async function saveOperationalSettings(nextSettings = operationalSettings) {
    await mkdir(dataDir(), { recursive: true })
    await atomicWrite(operationalRulesPath(), JSON.stringify(nextSettings, null, 2) + '\n')
  }

  async function saveCards(nextCards = cards) {
    await mkdir(dataDir(), { recursive: true })
    const minimal = nextCards.map((card) => ({ id: card.id, enabled: card.enabled !== false }))
    await atomicWrite(join(dataDir(), 'cards.json'), JSON.stringify(minimal, null, 2) + '\n')
  }

  function publicConfig() {
    const visible = { vaultRoot: vaultRoot() }
    for (const key of Object.keys(DEFAULT_DIRS)) visible[key] = key === 'sopDir' ? sopDirValue() : cfg(key)
    return visible
  }

  // 配置和卡片都是“整份快照”写入；把准备、持久化、提交串起来，避免两个并发 PUT
  // 以相反顺序完成后，内存与磁盘各自停在不同版本。
  let configCommitQueue = Promise.resolve()
  let cardsCommitQueue = Promise.resolve()
  let operationalCommitQueue = Promise.resolve()
  function queueCommit(queueName, operation) {
    const previous = queueName === 'config' ? configCommitQueue : queueName === 'operational' ? operationalCommitQueue : cardsCommitQueue
    const next = previous.catch(() => undefined).then(operation)
    if (queueName === 'config') configCommitQueue = next
    else if (queueName === 'operational') operationalCommitQueue = next
    else cardsCommitQueue = next
    return next
  }

  function operationalPayload(settings = operationalSettings) {
    const materialized = materializeCards(settings, DEFAULT_CARDS)
    return {
      schemaVersion: settings.schemaVersion,
      revision: settings.revision,
      activeProfileId: settings.activeProfileId,
      profiles: settings.profiles,
      activeProfile: settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? null,
      cards: materialized,
    }
  }

  function activeOperationalProfile() {
    return operationalSettings.profiles.find((profile) => profile.id === operationalSettings.activeProfileId) ?? operationalSettings.profiles[0] ?? null
  }

  function closeObservationDays(profile = activeOperationalProfile()) {
    const close = Array.isArray(profile?.observationCheckpoints)
      ? profile.observationCheckpoints.find((checkpoint) => checkpoint?.close === true)
      : null
    const days = Number(close?.daysAfterPublish)
    return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 7
  }

  function inAppReminders(profile, observationPlan) {
    if (profile?.reminders?.enabled !== true || profile?.reminders?.channel !== 'in-app') return []
    const leads = Array.isArray(profile.reminders.leadHours) ? profile.reminders.leadHours : []
    return observationPlan.flatMap((checkpoint) => leads.map((leadHours) => ({
      checkpointId: checkpoint.checkpointId,
      leadHours,
      dueAt: checkpoint.dueAt,
      remindAt: new Date(new Date(checkpoint.dueAt).getTime() - leadHours * 3600000).toISOString(),
      channel: 'in-app',
      status: 'pending',
    })))
  }

  async function operationalPublishGateContext(variant) {
    const checklist = await domain.loadChecklist()
    const check = checklist === null ? null : checklistState(variant.front, checklist.items)
    const risk = String(variant.front?.riskLevel ?? '低')
    return {
      draft: { title: variant.title ?? variant.front?.title ?? '', body: variant.body ?? '' },
      checklist: check,
      checklistComplete: check?.complete === true,
      riskLevel: risk,
      riskApproved: !/(?:高|禁发|high|blocked)/i.test(risk) || check?.complete === true,
      accountId: variant.front?.accountId,
      account: { id: variant.front?.accountId, name: variant.front?.account },
      evidence: variant.front?.publishedLink ?? '',
      assets: String(variant.front?.materials ?? '').split(/[、,;；\n]+/).map((item) => item.trim()).filter(Boolean),
    }
  }

  async function evaluateOperationalBenchmarks(profile, variant, metric) {
    const checkpoints = Array.isArray(profile?.observationCheckpoints) ? profile.observationCheckpoints : []
    const publishedAt = new Date(String(variant.front?.publishedAt ?? '')).getTime()
    const metricAt = new Date(String(metric.date ?? '') + 'T23:59:59Z').getTime()
    const elapsedDays = Number.isFinite(publishedAt) && Number.isFinite(metricAt)
      ? Math.max(1, Math.floor((metricAt - publishedAt) / 86400000) + 1)
      : 1
    const checkpoint = checkpoints.filter((entry) => entry.daysAfterPublish <= elapsedDays).sort((a, b) => b.daysAfterPublish - a.daysAfterPublish)[0] ?? checkpoints[0]
    if (checkpoint === undefined) return null
    const history = (await domain.listMetrics()).filter((entry) => String(entry.variantId ?? '') !== variant.id)
    const recent = history.slice(0, 100)
    const sameType = recent.filter((entry) => normalizePlatform(entry.platform) === normalizePlatform(variant.front?.platform))
    return evaluateSuccessBenchmarks(profile, { ...metric, recent, sameType }, checkpoint.id)
  }

  function operationalFailure(error) {
    if (error instanceof VaultError) return error
    if (error instanceof OperationalSettingsError) {
      return new VaultError(error.message, error.code === 'not_found' ? 'not_found' : 'bad_field', { errors: error.errors ?? [] })
    }
    return error
  }

  function requireOperationalSettings() {
    if (operationalSettingsLoadError !== null) {
      throw new VaultError('运营设置文件无法读取，请先修复或恢复 operational-rules.json：' + describe(operationalSettingsLoadError), 'read_failed')
    }
  }

  function operationalTransaction(expectedRevision, operation, { optionalRevision = false } = {}) {
    return queueCommit('operational', () => withFileWriteLock(operationalRulesPath(), async () => {
      requireOperationalSettings()
      let before
      let current
      try {
        before = await readFile(operationalRulesPath(), 'utf8')
        current = canonicalOperationalSettings(JSON.parse(before), DEFAULT_CARDS)
      } catch (error) {
        throw operationalFailure(error)
      }
      if (!optionalRevision || expectedRevision !== undefined) {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new VaultError('expectedRevision 必须是正整数', 'bad_request')
        if (expectedRevision !== current.revision) {
          throw new VaultError('运营设置已被修改，刷新后再保存', 'conflict', {
            currentRevision: current.revision,
            current: operationalPayload(current),
          })
        }
      }
      const draft = JSON.parse(JSON.stringify(current))
      let result
      try {
        result = await operation(draft)
        draft.revision = current.revision + 1
        const next = canonicalOperationalSettings(draft, DEFAULT_CARDS)
        const text = JSON.stringify(next, null, 2) + '\n'
        await atomicWriteFile(operationalRulesPath(), text, {
          beforeCommit: async () => {
            let latest
            try { latest = await readFile(operationalRulesPath(), 'utf8') } catch { latest = '' }
            if (latest !== before) {
              let latestSettings = current
              try { latestSettings = canonicalOperationalSettings(JSON.parse(latest), DEFAULT_CARDS) } catch { /* conflict evidence falls back to current */ }
              throw new VaultError('运营设置文件已在外部修改，刷新后再保存', 'conflict', {
                currentRevision: latestSettings.revision,
                current: operationalPayload(latestSettings),
              })
            }
          },
        })
        operationalSettings = next
        cards = materializeCards(next, DEFAULT_CARDS)
        return { ...operationalPayload(next), saved: true, ...(result ?? {}) }
      } catch (error) {
        throw operationalFailure(error)
      }
    }))
  }

  function operationalRouteId(route, suffix = '') {
    const prefix = 'operational-settings/profiles/'
    if (!route.startsWith(prefix)) return ''
    const tail = suffix === '' ? route.slice(prefix.length) : route.slice(prefix.length, -suffix.length)
    if (tail === '' || tail.includes('/')) throw new VaultError('运营档案路径不合法', 'bad_path')
    let id
    try { id = decodeURIComponent(tail) } catch { throw new VaultError('运营档案路径编码不合法', 'bad_path') }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id)) throw new VaultError('运营档案 id 不合法', 'bad_field')
    return id
  }

  function dirNameOf(kind) {
    const key = { topics: 'topicsDir', campaigns: 'campaignsDir', products: 'productsDir', accounts: 'accountsDir' }[kind] ?? 'dataDir'
    return normalizeVaultSubdir(cfg(key))
  }

  // 插件写入已经主动 invalidate；外部目录发现保留原有 3 秒 TTL。
  // 空板块不反复清空全库缓存，且此处只返回该目录的笔记。
  async function listNotesUnder(dir) {
    return (await vault.discover()).notes.filter((note) => dir === '' || note.path.startsWith(dir + '/'))
  }

  // 一段 markdown 里有没有「实质内容」：模板脚手架（空的 bullet、引导 blockquote、
  // 未勾选的自检项）不算成稿；勾选的 '- [x]' 算。脚本进度和拆解进度都靠这把尺子。
  function hasFilledLine(chunk) {
    return String(chunk ?? '').split('\n').some((line) => {
      const item = line.trim()
      if (item === '' || item.startsWith('#') || item.startsWith('>')) return false
      if (/^- \[[xX]\]/.test(item)) return true
      if (item.startsWith('- [ ]')) return false
      if (item.startsWith('-') || item.startsWith('*')) {
        const value = item.slice(1).trim()
        return value !== '' && !value.endsWith('：') && !value.endsWith(':')
      }
      return true
    })
  }

  // 取某个二级标题下的内容（到下一个 ## 为止）；没有这一节返回 null。
  function sectionBodyOf(text, heading) {
    const start = String(text ?? '').indexOf(heading)
    if (start < 0) return null
    const rest = String(text).slice(start + heading.length)
    const next = rest.search(/^## /m)
    return next < 0 ? rest : rest.slice(0, next)
  }

  // 老笔记的主选题里可能还留着「## 可拍摄脚本」（脚本以前写在这里）。
  // none=没这节 / empty=只有模板脚手架 / draft=版本 A 有成稿 / ab=A、B 都有。
  function scriptProgressOf(body) {
    const section = sectionBodyOf(body, '## 可拍摄脚本')
    if (section === null) return 'none'
    // 自检区勾没勾不代表脚本写没写，进度只看版本 A/B 区。
    const checkAt = section.indexOf('### 拍摄前自检')
    const scripts = checkAt < 0 ? section : section.slice(0, checkAt)
    if (!hasFilledLine(scripts)) return 'empty'
    const bAt = scripts.indexOf('### 版本 B')
    if (bAt >= 0 && hasFilledLine(scripts.slice(bAt + '### 版本 B'.length))) return 'ab'
    return 'draft'
  }

  // 版本里的「## 版本脚本」写没写。脚本归平台版本，主选题只放拆解。
  function variantScriptFilled(variant) {
    const section = sectionBodyOf(variant?.body, '## 版本脚本')
    return section !== null && hasFilledLine(section)
  }

  // 一篇选题的脚本进度：版本里成稿优先，主选题里还留着老脚本的也算；
  // 建了版本但都没写 → empty（脚本待写）；一个版本都没有 → none。
  function scriptProgressWith(variants, body) {
    const list = variants ?? []
    const legacy = scriptProgressOf(body)
    if (legacy === 'draft' || legacy === 'ab') return legacy
    if (list.some(variantScriptFilled)) return 'draft'
    return list.length === 0 ? 'none' : 'empty'
  }

  function makeCollection(kind, { schema, sort, template, autoId = false }) {
    let indexedVault = null
    const parsedIndex = new Map()
    const collection = {
      kind, schema, sort, template,
      dirName: () => dirNameOf(kind),
      // 全索引供关联与统计使用；不是偷偷提高 UI limit。分页在过滤后单独进行。
      async all({ filters = {}, sortField = sort, desc = true, q = '', includeVariants = true } = {}) {
        if (indexedVault !== vault) { parsedIndex.clear(); indexedVault = vault }
        const dir = dirNameOf(kind)
        const notes = await listNotesUnder(dir)
        const paths = [...new Set(notes.map((note) => note.path).filter((path) => path.startsWith(dir + '/')
          && (kind !== 'data' || !path.startsWith(dir + '/回流台账/'))))]
        const pathSet = new Set(paths)
        for (const path of parsedIndex.keys()) if (!pathSet.has(path)) parsedIndex.delete(path)
        const variantsByMaster = new Map()
        if (kind === 'topics' && includeVariants) {
          for (const variant of await domain.listVariants('', { includeMetrics: false })) {
            const key = String(variant.front?.masterId ?? '')
            if (!variantsByMaster.has(key)) variantsByMaster.set(key, [])
            variantsByMaster.get(key).push(variant)
          }
        }
        const needle = String(q ?? '').trim().toLowerCase()
        const records = []
        for (const path of paths) {
          let note
          try { note = await vault.readCachedNote(path) } catch { continue }
          let cached = parsedIndex.get(path)
          if (cached?.sha1 !== note.sha1) {
            const parsed = fm.splitNote(note.text)
            cached = { sha1: note.sha1, parsed, preview: parsed.body.split('\n')
              .filter((line) => line.trim() !== '' && !line.startsWith('#')).join(' ').slice(0, 140) }
            parsedIndex.set(path, cached)
          }
          const parsed = cached.parsed
          if (needle !== '' && ![note.title, path, ...Object.values(parsed.front), parsed.body]
            .some((value) => String(value ?? '').toLowerCase().includes(needle))) continue
          const id = kind === 'topics' ? topicIdOf(parsed.front, path) : ''
          records.push({ path, title: note.title, mtimeMs: note.mtimeMs, sha1: note.sha1, front: { ...parsed.front },
            ...(kind === 'topics' ? { id, body: parsed.body,
              script: scriptProgressWith(variantsByMaster.get(id) ?? [], parsed.body) } : {}), preview: cached.preview })
        }
        return fm.sortRecords(fm.filterRecords(records, filters), sortField, desc)
      },
      async query(options = {}) {
        const bounds = pageBounds(options, 200)
        const records = await collection.all(options)
        const page = records.slice(bounds.offset, bounds.offset + bounds.limit)
        return { records: page, total: records.length, ...bounds, truncated: bounds.offset + page.length < records.length }
      },
      // 保持领域层/工具的旧 array 契约，新的 HTTP 调用使用 query 的明确 metadata。
      async list(options = {}) { return (await collection.query(options)).records },
      async findById(input) {
        const id = String(input ?? '').trim()
        if (id === '') throw new VaultError('缺少记录 ID', 'bad_request')
        const records = await collection.all({ includeVariants: false })
        const hits = records.filter((record) => String(record.id ?? record.front?.id ?? '') === id)
        if (hits.length > 1) throw new VaultError('多个记录使用同一 ID，不能猜选：' + id, 'conflict')
        if (hits.length === 0) throw new VaultError('记录不存在：' + id, 'not_found')
        return hits[0]
      },
      async create(input) {
        const front = fm.normalizeFront(schema, input)
        if (autoId && String(front.id ?? '').trim() === '') front.id = newTopicId()
        const title = safeFileName(input?.title ?? front[schema[0].key] ?? '')
        const sub = safeSubDir(input?.dir ?? input?.folder ?? '')
        const rel = dirNameOf(kind) + '/' + (sub === '' ? '' : sub + '/') + title + '.md'
        const created = await vault.createNote(rel, fm.renderFromTemplate(schema, front, template(front)))
        vault.invalidate()
        return { ...created, path: rel }
      },
      async read(path) {
        const note = await vault.readNote(path)
        const parsed = fm.splitNote(note.text)
        return { ...note, front: parsed.front, body: parsed.body, ...(kind === 'topics' ? { id: topicIdOf(parsed.front, note.path) } : {}) }
      },
      async update(path, { front: frontInput, body, expectedSha1 } = {}) {
        const note = await vault.readNote(path)
        const parsed = fm.splitNote(note.text)
        const patch = fm.normalizeFrontPatch(schema, frontInput, parsed.front)
        if (autoId) {
          const id = topicIdOf(parsed.front, note.path)
          if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== id
            && !(String(parsed.front.id ?? '').trim() === '' && patch.id === '')) {
            throw new VaultError('记录 ID 是稳定身份，不能通过属性编辑修改', 'bad_field')
          }
          // 正文-only 不改原 YAML；属性编辑/显式迁移再持久化原有 fallback 身份。
          if (String(parsed.front.id ?? '').trim() === '' && Object.keys(patch).length > 0) patch.id = id
        }
        const nextBody = body === undefined ? parsed.body : String(body)
        return vault.writeNote(path, fm.buildNote(patch, nextBody, note.text), { expectedSha1: expectedSha1 || note.sha1 })
      },
    }
    return collection
  }

  function build() {
    if (vaultRoot() === '') {
      vault = null
      return
    }
    for (const key of Object.keys(DEFAULT_DIRS)) {
      if (key !== 'vaultRoot' && key !== 'pluginDataDir') normalizeVaultSubdir(cfg(key))
    }
    vault = createVaultStore({
      vaultRoot: vaultRoot(),
      sopDir: sopDirValue(),
      backupDir: join(vaultRoot(), cfg('workbenchDir'), '.backups'),
    })

    tables.glossary = createWorkbenchTable({
      header: ['中文', '英文', '领域', '标签', '备注'],
      keys: ['zh', 'en', 'domain', 'tags', 'note'],
      idKeys: ['zh', 'en'],
      heading: '# 指标与黑话',
      intro: '> 运营 / 电商 / 营销常用指标与黑话，一张表。',
      label: '术语',
    })
    tables.ideas = createWorkbenchTable({
      header: ['日期', '来源', '来源URL', '内容', '状态', '去向'],
      keys: ['date', 'source', 'sourceUrl', 'content', 'status', 'outcome'],
      // 老表有两种：4 列（没有「去向」）和 5 列（没有「来源URL」）。补列发生在算 id 之前，
      // 所以老行的 id 不会变，不会出现「升级一次全变新行」。
      legacy: [
        { cells: 5, at: [{ index: 2 }] },
        { cells: 4, at: [{ index: 2 }, { index: 5 }] },
      ],
      idKeys: ['date', 'content'],
      heading: '# 灵感箱',
      intro: '> 想到就丢一行，定期清进选题库。状态：新 / 已用 / 已废弃；已用的填「去向」，写上它变成了哪篇选题。来源URL 可直接在面板里预览。',
      label: '灵感',
    })
    // 老反馈表有两种：8 列（还没有「来源」）和 6 列（还没有处理意见/处理结果）。
    // 读到老行时按列数把缺的列补成空，idKeys 仍是日期+内容，老行 id 不变。
    tables.feedback = createWorkbenchTable({
      header: ['日期', '渠道', '来源', '情感', '内容', '标签', '处理意见', '处理结果', '状态'],
      keys: ['date', 'channel', 'source', 'sentiment', 'content', 'tags', 'advice', 'resolution', 'status'],
      idKeys: ['date', 'content'],
      legacy: [{ cells: 8, at: [{ index: 2 }] }, { cells: 6, at: [{ index: 2 }, { index: 6 }, { index: 7 }] }],
      heading: '# 客户反馈',
      intro: '> 情感：正 / 负 / 中性。状态：未处理 / 跟进中 / 已处理。处理意见 / 处理结果：怎么打算处理的、最后处理成什么样。来源：平台 / 内容（发布过的文章或视频，也就是笔记）/ 商品（自家或竞品里挑具体一个）。',
      label: '反馈',
    })

    collections.topics = makeCollection('topics', {
      autoId: true,
      schema: [
        { key: 'platform', label: '平台', required: true, max: 100 },
        // 账号档案（Accounts/）的稳定 id + 名称副本：选题先选一个默认账号，
        // 建平台版本时默认带过去；档案改名不影响已有笔记的显示（按 id 反查新名字）。
        { key: 'account', label: '账号', max: 100 },
        { key: 'accountId', label: '账号ID', max: 40 },
        // 选题策划三件套（2026-11-08 策划团建议）：只挂 frontmatter，正文不重复。
        { key: 'audience', label: '目标人群', max: 300 },
        { key: 'goal', label: '内容目标', max: 300 },
        { key: 'angle', label: '一句话角度', max: 300 },
        { key: 'date', label: '日期', required: true, max: 20 },
        { key: 'link', label: '链接', max: 300 },
        { key: 'status', label: '状态', max: 20 },
        // 拆解 vs 选题（2026-11-08 拆分）：type==='拆解' 是拆解别人的案例，只留在爆款拆解卡；
        // type==='选题' 是自己的，才进我的选题/日历管线。老笔记没写 type 时两边都显示。
        // 不进 schema 的字段会被 normalizeFront 丢掉，所以 type 必须在这里挂名。
        { key: 'type', label: '类型', max: 20 },
        { key: 'views', label: '播放/阅读', max: 20 },
        { key: 'likes', label: '赞/收藏', max: 20 },
        { key: 'tags', label: '标签', max: 100 },
        { key: 'core', label: '核心', max: 300 },
        { key: 'structure', label: '结构', max: 600 },
        { key: 'memoryPoint', label: '记忆点', max: 600 },
        { key: 'origin', label: '来源', max: 200 },
        { key: 'sourceUrl', label: '来源链接', max: 300 },
        { key: 'sourceTitle', label: '来源标题', max: 200 },
        { key: 'id', label: 'ID', max: 40 },
        // 从拆解派生选题时写上：指回源拆解笔记的 12 位 id，详情页靠它互相跳。
        { key: 'sourceId', label: '源拆解', max: 40 },
      ],
      sort: '_mtime',
      // 新建带一张最小选题卡：把策划三件套摊在正文开头，填的时候不用再翻属性面板。
      // 只三行，不再是以前那种「基本信息/一键拆解/脚本」整副模板。
      // 模板按 type 分叉（2026-11-09 用户拍板；拆解要素骨架来自内容策划团意见）：
      // 拆解别人 → 原文信息 / 钩子 / 结构 / 记忆点 / 可复用的招；自己的选题 → 最小选题卡三行。
      // frontmatter 里已有的 origin/sourceTitle/core/memoryPoint 字段直接摊进对应小节，填过就不白写。
      template: (front) => String(front?.type ?? '') === '拆解'
        ? [
          '## 原文信息',
          '- 来源：' + String(front?.origin ?? '') + (String(front?.sourceTitle ?? '') === '' || String(front?.sourceTitle ?? '') === String(front?.origin ?? '') ? '' : '（' + String(front.sourceTitle) + '）'),
          '- 链接：' + String(front?.sourceUrl ?? ''),
          '- 数据：播放/阅读 · 赞/收藏（待回填）',
          '',
          '## 前 3 秒凭什么抓人',
          '- ',
          '',
          '## 结构拆解',
          '- 开头：',
          '- 中段：',
          '- 结尾：',
          '',
          '## 记忆点',
          '- ' + String(front?.memoryPoint ?? ''),
          '',
          '## 可复用的招',
          '- ' + String(front?.core ?? ''),
          '',
        ].join('\n')
        // 选题卡三件套只挂 frontmatter，正文不再重复同一组值；
        // 老笔记里由旧模板生成的重复小节，在详情页由 stripDuplicateTopicCard 只隐藏重复内容。
        : '',
    })

    domain = createDomainStore({
      vault,
      workbenchDir: String(cfg('workbenchDir')).replace(/\\/g, '/'),
      topics: collections.topics,
      dataDir: dirOf('dataDir'),
      // 自检清单交给领域层，但清单在哪儿由这里说了算（vault 里那份 SOP 文件）。
      checklistProvider: () => readChecklistDoc(),
      accountProvider: async (id) => {
        const wanted = String(id ?? '').trim()
        if (wanted === '') return null
        const accounts = await collections.accounts.all({ includeVariants: false })
        return accounts.find((record) => String(record.id ?? record.front?.id ?? '') === wanted) ?? null
      },
      timezone: 'Asia/Shanghai',
    })
    migrator = createMigrator({ vault, topics: collections.topics, domain })

    collections.campaigns = makeCollection('campaigns', {
      schema: [
        { key: 'platform', label: '平台', required: true, max: 100 },
        { key: 'status', label: '状态', required: true, max: 20 },
        { key: 'start', label: '开始', max: 20 },
        { key: 'end', label: '结束', max: 20 },
        { key: 'budget', label: '预算', max: 20 },
        { key: 'goal', label: '目标', max: 100 },
      ],
      sort: '_mtime',
      template: (front) => [
        '## 目标',
        '- ' + (front.goal ?? ''),
        '',
        '## 预算与节奏',
        '- 预算：' + (front.budget ?? '-'),
        '- 周期：' + (front.start ?? '?') + ' ~ ' + (front.end ?? '?'),
        '',
        '## 渠道与素材',
        '- 渠道：',
        '- 素材：',
        '',
        '## 复盘',
        '### 效果对比',
        '| 指标 | 预期 | 实际 |',
        '| --- | --- | --- |',
        '|  |  |  |',
        '',
        '### 经验',
        '- ',
      ].join('\n'),
    })

    collections.products = makeCollection('products', {
      schema: [
        { key: 'kind', label: '类型（自家/竞品）', required: true, max: 10 },
        { key: 'platform', label: '平台', max: 100 },
        { key: 'price', label: '价格', max: 20 },
        { key: 'sales', label: '销量/势头', max: 30 },
        { key: 'status', label: '状态', max: 20 },
        { key: 'tags', label: '标签', max: 100 },
        { key: 'link', label: '链接', max: 300 },
      ],
      sort: '_mtime',
      template: () => [
        '## 卖点',
        '- ',
        '',
        '## 主图 / 详情策略',
        '- ',
        '',
        '## 价格与促销',
        '- ',
        '',
        '## 差评要点',
        '- ',
      ].join('\n'),
    })

    // 账号档案：平台 + 账号名 + 定位 + 目标人群。选题和平台版本都引用它的 id，
    // 排期时按平台挑账号，不用每次手打账号名（手打必然出现「主号 / 大号 / 抖音主号」三种写法）。
    collections.accounts = makeCollection('accounts', {
      autoId: true,
      schema: [
        { key: 'name', label: '账号名', required: true, max: 20 },
        { key: 'platform', label: '平台', required: true, max: 100 },
        { key: 'positioning', label: '定位', max: 200 },
        { key: 'audience', label: '目标人群', max: 200 },
        { key: 'status', label: '状态', max: 20 },
        { key: 'note', label: '备注', max: 300 },
        { key: 'id', label: 'ID', max: 40 },
      ],
      sort: '_mtime',
      template: () => '',
    })

    collections.data = makeCollection('data', {
      schema: [
        { key: 'period', label: '周期（2026-W44 / 2026-11）', required: true, max: 20 },
        { key: 'platform', label: '平台', max: 30 },
        { key: 'gmv', label: 'GMV', max: 20 },
        { key: 'traffic', label: '流量', max: 20 },
        { key: 'conv', label: '转化率', max: 20 },
        { key: 'roi', label: 'ROI', max: 20 },
        { key: 'mom', label: '环比', max: 20 },
        // 出处和口径是硬规则 H3「数据必须说得出出处」要求的两个字段。
        // 以前这张表只有指标没有来源，于是同一句「GMV 12 万」没人说得清是哪天、
        // 哪个后台、含不含退款 —— 三个月后连自己都不敢引用。
        { key: 'source', label: '数据来源', max: 120 },
        { key: 'caliber', label: '统计口径', max: 120 },
      ],
      sort: 'period',
      template: (front) => [
        '## 核心指标',
        '| 指标 | 本期 | 上期 | 环比 |',
        '| --- | --- | --- | --- |',
        '| GMV | ' + (front.gmv ?? '') + ' |  | ' + (front.mom ?? '') + ' |',
        '| 流量 | ' + (front.traffic ?? '') + ' |  |  |',
        '| 转化率 | ' + (front.conv ?? '') + ' |  |  |',
        '| ROI | ' + (front.roi ?? '') + ' |  |  |',
        '',
        '## 数据出处',
        '- 来源：' + (front.source || '（待填：哪个后台、哪张表、哪一天导出的）'),
        '- 口径：' + (front.caliber || '（待填：含不含退款、按哪个时间窗、按 GMV 还是成交额）'),
        '',
        '## 变化解读',
        '- 涨在哪：',
        '- 跌在哪：',
        '- 原因假设：',
        '',
        '## 下期动作',
        '- ',
      ].join('\n'),
    })

    rulesPath = join(dirOf('copyRulesDir'), 'rules.md')
  }

  // 工作台自己管的目录（相对 vault 根的 posix 前缀）。
  // 「仅工作台」搜索用它过滤；vault 里往往还堆着大量无关目录（比如一整个
  // 编程笔记库），搜「选题」能返回 80 条全来自那边，工作台自己的 0 条，
  // 结果就是看着像「搜全库没反应」。
  function workbenchPrefixes() {
    const keys = ['sopDir', 'topicsDir', 'campaignsDir', 'dataDir', 'productsDir', 'accountsDir', 'calendarDir', 'feedbackDir', 'copyRulesDir', 'workbenchDir']
    const seen = new Set()
    for (const key of keys) {
      const value = key === 'sopDir' ? sopDirValue() : String(cfg(key) ?? '')
      const dir = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (dir !== '') seen.add(dir)
    }
    return [...seen]
  }

  /**
   * 批注（高亮 + 备注）的读接口。
   *
   * 存储选择：直接写进笔记正文，用 Obsidian 自己的语法
   *   ==高亮的那段==%%备注内容%%
   * 这样在 Obsidian 里也能看到（阅读视图里 %%...%% 是隐藏的，只剩高亮），
   * 工作台和 Obsidian 始终是同一份数据，不引入第二套存储。
   * 代价是原文大改之后位置会漂移，所以按「原文片段」定位，找不到就明说。
   */
  function annotationsOf(text, relPath) {
    const source = String(text ?? '')
    const lines = source.split(/\r?\n/)
    const out = []
    const pattern = /==([^=\n]{1,400})==(?:%%([^%\n]{0,400})%%)?/g
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      // 跳过 frontmatter 区域
      if (index === 0 && line.trim() === '---') {
        const close = lines.indexOf('---', 1)
        if (close > 0) index = close
        continue
      }
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        out.push({
          id: (relPath ?? '') + ':' + index + ':' + match.index,
          path: relPath ?? '',
          line: index + 1,
          text: match[1],
          note: match[2] ?? '',
        })
      }
    }
    return out
  }

  // 跨月汇总用：把 Calendar/ 下所有 YYYY-MM.md 列出来（新的在前）。
  async function calendarMonths() {
    const dir = dirOf('calendarDir')
    let names = []
    try {
      names = await readdir(dir)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((name) => /^\d{4}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, 7))
      .sort()
      .reverse()
  }

  /**
   * 选题路径可能对不上：日历里存的可能是「Topics/羽绒服.md」，实际文件叫
   * 「Topics/爆款拆解-羽绒服-2026-11-01.md」。先按原样试，找不到再按文件名找唯一匹配。
   */
  async function resolveTopicPath(path) {
    const clean = String(path ?? '').trim().replace(/\\/g, '/')
    if (clean === '') return { ok: false, code: 'bad_request', message: 'topicPath 为空' }
    if (!clean.toLowerCase().endsWith('.md')) {
      return { ok: false, code: 'bad_request', message: 'topicPath 必须是 .md 笔记：' + clean }
    }
    // 只认 Topics/ 下的笔记。以前这里对任意路径都放行，指向别处时后面 read 会失败，
    // 但日历那一行已经被改了 —— 结果就是「日历变了、笔记没变」，而且没人知道。
    // dirOf 返回的是绝对路径，日历里存的是相对 vault 的路径，这里要比相对的那一份。
    const topicsDir = String(cfg('topicsDir') ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const under = topicsDir === '' || clean === topicsDir || clean.startsWith(topicsDir + '/')
    if (!under) {
      return { ok: false, code: 'bad_request', message: '选题笔记必须在 ' + topicsDir + '/ 下：' + clean }
    }
    try {
      await vault.readNote(clean)
      return { ok: true, path: clean }
    } catch (error) {
      if (error?.code !== 'not_found') {
        return { ok: false, code: error?.code ?? 'vault_error', message: describe(error) }
      }
    }
    const base = clean.split('/').pop() ?? clean
    const stem = base.replace(/\.md$/i, '').trim()
    // 只有目录没有文件名（例如 'Topics/'）时 stem 是空串，而 includes('') 恒为真 ——
    // 以前这会让「唯一匹配」变成「随便挑一篇覆盖」。必须在这里挡住。
    if (stem === '') {
      return { ok: false, code: 'bad_request', message: 'topicPath 只有目录没有文件名：' + clean }
    }
    const records = await collections.topics.all({ includeVariants: false })
    const exact = records.filter((record) => (record.path.split('/').pop() ?? '') === base)
    if (exact.length === 1) return { ok: true, path: exact[0].path }
    if (exact.length > 1) {
      return { ok: false, code: 'conflict', message: '同名笔记不止一篇：' + exact.map((record) => record.path).join(' / ') }
    }
    // 只做「标题包含 stem」这一个方向；反向的 stem.includes(title) 会让短标题命中一大片。
    const fuzzy = records.filter((record) => String(record.title ?? '').includes(stem))
    if (fuzzy.length === 1) return { ok: true, path: fuzzy[0].path }
    if (fuzzy.length > 1) {
      return {
        ok: false,
        code: 'conflict',
        message: '标题含「' + stem + '」的选题有多篇：' + fuzzy.map((record) => record.path).join(' / ')
      }
    }
    return { ok: false, code: 'not_found', message: '找不到这篇选题笔记：' + clean }
  }

  // 「待回填数据」的缺口：日历里标了「已发」，但同选题同平台还没有平台版本的排期。
  // 服务端一次算完，前端不要再自己过滤一遍 —— 两个地方各算一次，迟早算出两个数。
  async function pendingGapsOf() {
    if (domain === null) return { variants: [], gaps: [] }
    const masters = (await collections.topics.all({ includeVariants: false }))
      .filter((record) => !String(record.path ?? '').startsWith('Topics/测试/'))
    const masterIdOf = (master) => String(master.id ?? master.front?.id ?? '')
    const masterById = new Map(masters.map((master) => [masterIdOf(master), master]))
    const allVariants = await domain.listVariants()
    const hasPublishFact = (variant) => String(variant.front?.publishedAt ?? '').trim() !== ''
    const published = allVariants.filter((variant) => ['已发', '待回填'].includes(String(variant.status))
      && hasPublishFact(variant)
      && masterById.has(String(variant.front?.masterId ?? '')))
    // 覆盖判断按「选题 + 平台」这一对，而且要看收纳中的版本：
    // 收纳只影响日常显示，不能让已经发布的内容重新变成缺口。
    const covered = new Set()
    for (const variant of allVariants) {
      // 只有真的发出去过的版本才算覆盖。旧「已归档」笔记已由领域层恢复成
      // 原生命周期状态，所以这里不再把收纳当成发布事实。
      // 以前草稿、待审也一并算上 —— 日历标了已发、版本还躺在草稿里，缺口被静默吞掉，
      // 待回填数据上半段只收已发/数据回流，于是两边都不显示，这条内容凭空消失。
      const status = String(variant.status ?? '')
      const countsAsPublished = ['已发', '待回填', '已结案'].includes(status) && hasPublishFact(variant)
      if (!countsAsPublished) continue
      const master = masterById.get(String(variant.front?.masterId ?? ''))
      if (master === undefined) continue
      covered.add(String(master.path ?? '') + '|' + normalizePlatform(String(variant.front?.platform ?? '')))
    }
    const gaps = []
    for (const month of await calendarMonths()) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      for (const entry of state.entries) {
        if (String(entry.status) !== '已发') continue
        const topicPath = String(entry.topicPath ?? '').trim()
        // 纯商品行（挂了商品档案、没挂选题）本来就不需要平台版本，不算缺口。
        if (String(entry.productPath ?? '').trim() !== '' && topicPath === '') continue
        if (covered.has(topicPath + '|' + normalizePlatform(String(entry.platform ?? '')))) continue
        gaps.push({ ...entry, month, normalizedPlatform: normalizePlatform(entry.platform) })
      }
    }
    gaps.sort((left, right) => String(right.date).localeCompare(String(left.date)))
    return { variants: published, gaps }
  }

  // 状态机上的最短路径：日历那边只会说「这条已发了」，中间经过哪几步是系统的事。
  // 和客户端 variantPathTo 同一套算法 —— 状态机本身只有 lib/domain.js 一份。
  function transitionPathOf(from, to) {
    const start = String(from ?? '') || '在写'
    if (start === to) return []
    const queue = [[start]]
    const seen = new Set([start])
    while (queue.length > 0) {
      const path = queue.shift()
      const last = path[path.length - 1]
      for (const next of (VARIANT_TRANSITIONS[last] ?? [])) {
        if (seen.has(next)) continue
        if (next === to) return path.slice(1).concat([next])
        seen.add(next)
        queue.push(path.concat([next]))
      }
    }
    return null
  }

  // 日历把某条标成「已发」，等于说「这条真的发出去了」。那同选题同平台的平台版本
  // 也得跟着走完状态机 —— 否则日历记一本账、版本记另一本，谁都不知道哪本是准的。
  //
  // 分两步：先 resolve（只读，算清楚该推哪一版、推不推得动），再 apply（真写）。
  // 分开是因为日历那一行和版本文件是两次写盘 —— 推不动的话，日历一个字节都不该写。
  // 以前是先写日历再推版本，推不动时日历已经写成「已发」了，接口还返回 200 装作没事。
  //
  // blocking 标记两件事：
  //   blocking = true  → 这一行推不动是因为「推它」本身有矛盾（挂的版本不存在、平台对不上、
  //                       同平台多个版本没指定推哪一版、门禁没过）。这时候整条拒绝，
  //                       日历一个字节都不写 —— 让日历说「已发」而版本还在「在写」，
  //                       两本账就对不上了。
  //   blocking = false → 这一行压根没有可推进的版本（纯商品排期、老行没挂版本、
  //                       同平台还没建版本）。没有东西要推进，不构成矛盾，日历照写，
  //                       只把原因带回去让前端说一句。
  async function resolveCalendarAdvance(entry) {
    if (domain === null) return { ok: false, reason: '还没连接 vault', blocking: false }
    const topicPath = String(entry.topicPath ?? '').trim()
    if (topicPath === '') return { ok: false, reason: '这条没挂选题笔记', blocking: false }
    const masters = await collections.topics.all({ includeVariants: false })
    const master = masters.find((record) => String(record.path ?? '') === topicPath)
    if (master === undefined) return { ok: false, reason: '找不到选题笔记：' + topicPath, blocking: false }
    const platform = normalizePlatform(String(entry.platform ?? ''))
    const variants = await domain.listVariants(master.id)
    // 日历这一行如果挂了版本ID，就是它 —— 同平台多个版本时不再需要猜。
    const wantedVariantId = String(entry.variantId ?? '').trim()
    let variant = null
    if (wantedVariantId !== '') {
      variant = variants.find((item) => String(item.id) === wantedVariantId) ?? null
      if (variant === null) return { ok: false, blocking: true, reason: '日历挂的平台版本不存在了：' + wantedVariantId }
      if (normalizePlatform(String(variant.front?.platform ?? '')) !== platform) {
        return { ok: false, blocking: true, reason: '日历的平台「' + platform + '」与这一版不一致，可能刚被改过' }
      }
    } else {
      const samePlatform = variants.filter((item) => normalizePlatform(String(item.front?.platform ?? '')) === platform)
      if (samePlatform.length === 0) return { ok: false, blocking: false, reason: '这条选题在「' + platform + '」还没有平台版本' }
      // 老行没有版本ID。同一个平台挂着好几个版本（主号 / 测试号 / 矩阵号）时分不清该推哪一个：
      // 以前这里取第一个，结果「把测试号推成已发、真正排期的那版没动」还报成功 ——
      // 宁可如实说推不了，让人自己在日历行上选一个版本。
      if (samePlatform.length > 1) {
        return {
          ok: false,
          blocking: true,
          ambiguous: true,
          reason: '这条选题在「' + platform + '」有 ' + samePlatform.length + ' 个版本，日历这行还没指定版本，请选一个再标已发',
        }
      }
      variant = samePlatform[0]
    }
    const steps = transitionPathOf(variant.status, '已发')
    if (steps === null) return { ok: false, blocking: true, reason: '「' + variant.status + '」走不到「已发」' }
    // 预检：只读，不写盘。门禁（禁发 / 高风险没勾完自检）在这里就会被拦下，
    // 拦下了就整条拒绝 —— 日历不写，版本也不动。
    const preflight = await domain.preflightSteps(variant.path, steps)
    if (preflight.ok !== true) return { ok: false, blocking: true, reason: preflight.reason }
    return { ok: true, variant, steps, status: variant.status }
  }

  // 真正把版本推进去。只在 resolve 通过之后调用。
  async function applyCalendarAdvance(resolved, options = {}) {
    if (resolved.ok !== true) return resolved
    const profile = activeOperationalProfile()
    let operational = null
    let publishOptions = options
    if (resolved.steps.includes('已发') && profile !== null) {
      const gate = evaluatePublishGate(profile, await operationalPublishGateContext(resolved.variant))
      if (!gate.ok) return { ok: false, blocking: true, reason: gate.failed.map((entry) => entry.reason).join('；'), publishGate: gate }
      const publishedAt = String(options.at ?? '').trim() || new Date().toISOString()
      const observationPlan = buildObservationPlan(profile, publishedAt)
      const closeDays = observationPlan.find((checkpoint) => checkpoint.close)?.daysAfterPublish ?? closeObservationDays(profile)
      publishOptions = { ...options, at: publishedAt, reviewDays: closeDays }
      operational = { profileId: profile.id, observationPlan, reminders: inAppReminders(profile, observationPlan) }
    }
    let current = resolved.variant
    try {
      for (const step of resolved.steps) current = await domain.transitionVariant(current.path, step, {
        actor: 'calendar',
        ...(step === '已发' ? { at: publishOptions.at, reviewDays: publishOptions.reviewDays, link: publishOptions.link } : {}),
      })
    } catch (error) {
      if (String(current.sha1 ?? '') !== String(resolved.variant.sha1 ?? '')) {
        try {
          await vault.writeNote(resolved.variant.path, resolved.variant.text, { expectedSha1: current.sha1 })
        } catch (rollbackError) {
          return {
            ok: false,
            partial: true,
            reason: '平台版本推进失败，且版本回滚失败：' + (rollbackError?.message ?? String(rollbackError)),
            cause: error?.message ?? String(error),
            steps: resolved.steps,
          }
        }
      }
      return { ok: false, reason: error?.message ?? String(error), steps: resolved.steps }
    }
    return { ok: true, status: current.status, steps: resolved.steps, ...(operational === null ? {} : { operational }) }
  }

  // 版本的发布状态往前走了，日历上挂着它的那一行也要跟着走 ——
  // 否则同一个平台版本在两个地方显示两个状态，版本卡说「已发」、日历说「待发」，
  // 用户只能靠猜。平台版本是唯一真源，日历行状态是它的投影。
  //
  // 只往前投影，不往后拉：日历行如果已经比版本更靠前（老数据、手工改过），
  // 保持原样 —— 把它拉回来等于用一次状态变更抹掉用户已经记下的事实。
  const CALENDAR_STATUS_RANK = { 在写: 0, 待发: 1, 已发: 2, 待回填: 3 }
  async function calendarProjectionPlans(variantId, status, { cancel = false } = {}) {
    const id = String(variantId ?? '').trim()
    const target = String(status ?? '').trim()
    if (id === '') return []
    const plans = []
    for (const month of await calendarMonths()) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      if (state.warning !== undefined) throw new VaultError('日历 ' + month + ' 读取失败：' + state.warning, state.code ?? 'read_failed')
      const before = state.entries ?? []
      let next = before
      if (cancel) {
        next = before.filter((entry) => !(String(entry.variantId ?? '').trim() === id
          && ['在写', '待发'].includes(String(entry.status ?? '').trim())
          && String(entry.date ?? '') >= today()))
      } else if (CALENDAR_STATUS_RANK[target] !== undefined) {
        next = before.map((entry) => {
          if (String(entry.variantId ?? '').trim() !== id) return entry
          const current = String(entry.status ?? '').trim()
          return (CALENDAR_STATUS_RANK[current] ?? -1) < CALENDAR_STATUS_RANK[target] ? { ...entry, status: target } : entry
        })
      }
      const changed = next.length !== before.length || next.some((entry, index) => entry !== before[index])
      if (changed) plans.push({ month, cal, before, next, sha1: state.sha1 ?? '' })
    }
    return plans
  }

  async function applyCalendarPlans(plans) {
    const applied = []
    try {
      for (const plan of plans) {
        const written = await plan.cal.table.replaceAll(plan.cal.file, plan.next, { expectedSha1: plan.sha1 })
        if (written.ok !== true) throw new VaultError('日历 ' + plan.month + ' 同步失败：' + String(written.error ?? '未知错误'), written.code ?? 'write_failed')
        applied.push({ ...plan, writtenSha1: written.sha1 })
      }
      return applied
    } catch (error) {
      const rollbackFailed = []
      for (const plan of applied.slice().reverse()) {
        const rolled = await plan.cal.table.replaceAll(plan.cal.file, plan.before, { expectedSha1: plan.writtenSha1 })
        if (rolled.ok !== true) rollbackFailed.push({ month: plan.month, error: rolled.error ?? '回滚失败' })
      }
      if (rollbackFailed.length > 0) throw new VaultError('日历同步失败，且部分回滚失败，请检查相关月份', 'conflict', { partial: true, rollbackFailed })
      throw error
    }
  }

  async function rollbackCalendarPlans(applied) {
    const failed = []
    for (const plan of applied.slice().reverse()) {
      const rolled = await plan.cal.table.replaceAll(plan.cal.file, plan.before, { expectedSha1: plan.writtenSha1 })
      if (rolled.ok !== true) failed.push({ month: plan.month, error: rolled.error ?? '回滚失败' })
    }
    return failed
  }

  async function transitionVariantWithCalendar(variant, to, options = {}) {
    const target = normalizeVariantStatus(to)
    const profile = activeOperationalProfile()
    let operational = null
    let effectiveOptions = options
    if (target === '已发' && profile !== null) {
      const gate = evaluatePublishGate(profile, await operationalPublishGateContext(variant))
      if (!gate.ok) {
        throw new VaultError(gate.failed.map((entry) => entry.reason).join('；'), 'bad_request', { publishGate: gate })
      }
      const publishedAt = String(options.at ?? '').trim() || new Date().toISOString()
      const observationPlan = buildObservationPlan(profile, publishedAt)
      const closeDays = observationPlan.find((checkpoint) => checkpoint.close)?.daysAfterPublish ?? closeObservationDays(profile)
      effectiveOptions = { ...options, at: publishedAt, reviewDays: closeDays }
      operational = {
        profileId: profile.id,
        observationPlan,
        reminders: inAppReminders(profile, observationPlan),
      }
    }
    const plans = await calendarProjectionPlans(variant.id, target, { cancel: target === '已取消' })
    const moved = await domain.transitionVariant(variant.path, target, effectiveOptions)
    try {
      const applied = await applyCalendarPlans(plans)
      return {
        variant: moved,
        calendarSynced: applied.map((plan) => ({ month: plan.month, rows: plan.next.length })),
        ...(operational === null ? {} : { operational }),
      }
    } catch (error) {
      try {
        await vault.writeNote(variant.path, variant.text, { expectedSha1: moved.sha1 })
      } catch (rollbackError) {
        throw new VaultError('状态与日历同步失败，版本回滚也失败，请手动检查', 'conflict', {
          partial: true, cause: error?.message ?? String(error), rollbackError: rollbackError?.message ?? String(rollbackError),
        })
      }
      throw new VaultError('状态没有保存：日历同步失败，版本已恢复原状态。' + (error?.message ?? String(error)), error?.code ?? 'conflict')
    }
  }

  async function syncCalendarStatusForVariant(variantId, status) {
    const plans = await calendarProjectionPlans(variantId, status)
    return applyCalendarPlans(plans)
  }

  // 概览卡片上那个数字：跨月还在等回流的平台版本数。
  // 只和「待回填数据」卡实际列出的行同源（已发 / 待回填的平台版本）。
  // 日历里「已发但还没建平台版本」的缺口不在这里凑数：那种行在卡片里没有可录入的
  // 版本，点进去也找不到；把它算进来只会让首页数字和卡片行数对不上。
  async function pendingCountOf() {
    const { variants } = await pendingGapsOf()
    return variants.length
  }

  // 商品档案的反向聚合：这个商品被哪些内容带过，累计带货多少。
  // 关联键是日历的 productPath（P0-2 加的列），归一化时看最后两段路径，避开写成绝对路径或只写文件名的情况。
  function tailKey(path) {
    const parts = String(path ?? '').replace(new RegExp('\\\\', 'g'), '/').split('/').filter((part) => part !== '')
    return parts.slice(-2).join('/').toLowerCase()
  }

  function toNumber(value) {
    const raw = String(value ?? '').replace(/[,\s]/g, '').replace(/[^0-9.\-]/g, '')
    if (raw === '' || raw === '-' || raw === '.') return 0
    const num = Number(raw)
    return Number.isFinite(num) ? num : 0
  }

  function percentOf(value) {
    const raw = String(value ?? '').trim().replace(/%/g, '').replace(/[,\s]/g, '')
    if (raw === '') return null
    const num = Number(raw)
    return Number.isFinite(num) ? num : null
  }

  async function productRollup() {
    requireVault()
    const months = await calendarMonths()
    const rows = []
    for (const month of months) {
      const table = calendarTableFor(month)
      const read = await table.table.read(table.file)
      for (const entry of read.entries) rows.push({ month, ...entry })
    }
    // 已发 / 数据回流 的才算「带过」，选题和创作中的不统计 GMV。
    const live = rows.filter((row) => ['已发', '待回填'].includes(String(row.status ?? '')))
    const byProduct = new Map()
    for (const row of live) {
      const key = tailKey(row.productPath)
      if (key === '') continue
      const bucket = byProduct.get(key) ?? { key, productPath: String(row.productPath ?? ''), items: [], gmv: 0, views: 0, convSum: 0, convSamples: 0 }
      const note = String(row.note ?? '')
      // GMV / 转化率现在有结构化列，不再从备注里猜。旧备注里的播放数只做只读兼容，
      // 新写入和商品汇总都不依赖它。
      const pick = (label) => {
        const hit = new RegExp('(?:' + label + ')' + '\\s*[:：=]?\\s*([0-9.]+)\\s*(万|w)?', 'i').exec(note)
        if (hit === null) return 0
        const scale = hit[2] === undefined ? 1 : 10000
        return toNumber(hit[1]) * scale
      }
      const gmv = toNumber(row.gmv)
      const conv = percentOf(row.conv)
      const views = pick('播放|vues|views|观看')
      bucket.items.push({ month: row.month, id: row.id, date: row.date, platform: row.platform, topic: row.topic, status: row.status, topicPath: row.topicPath, note: row.note, gmv, conv, views })
      bucket.gmv += gmv
      bucket.views += views
      if (conv !== null) {
        bucket.convSum += conv
        bucket.convSamples += 1
      }
      byProduct.set(key, bucket)
    }
    const products = [...byProduct.values()]
      .map(({ convSum, convSamples, ...bucket }) => ({ ...bucket, conv: convSamples === 0 ? null : convSum / convSamples, convSamples }))
      .sort((a, b) => b.gmv - a.gmv)
    return { products, linkedCount: live.length, months: months.length }
  }

  // 每个平台版本先取最新累计快照，再按主选题汇总。不能直接取主选题最后一行：
  // 同一选题抖音 1 万、视频号 2 万，榜单应该是 3 万；也不能把各平台多日累计值重复相加。
  // 播放/赞/评/转只有台账这一个来源：旧接口把同样的数字再写进选题 frontmatter，
  // 两处一旦不一致就永远对不上（榜单读台账、选题卡读 frontmatter），接口已删。
  async function latestMetricByMaster() {
    if (domain === null) return new Map()
    const metrics = await domain.listMetrics()
    const latestByVariant = new Map()
    for (const metric of metrics) {
      const variantId = String(metric.variantId ?? '')
      if (variantId !== '' && !latestByVariant.has(variantId)) latestByVariant.set(variantId, metric)
    }
    const byMaster = new Map()
    for (const metric of latestByVariant.values()) {
      const masterId = String(metric.masterId ?? '')
      if (masterId === '') continue
      const aggregate = byMaster.get(masterId) ?? { views: 0, likes: 0, comments: 0, shares: 0, orders: 0, gmv: 0, date: '', variants: 0 }
      for (const key of ['views', 'likes', 'comments', 'shares', 'orders', 'gmv']) aggregate[key] += toNumber(metric[key])
      aggregate.date = String(metric.date ?? '') > aggregate.date ? String(metric.date ?? '') : aggregate.date
      aggregate.variants += 1
      byMaster.set(masterId, aggregate)
    }
    return byMaster
  }

  // 选题榜：内容线按播放排，带货线按 ROI。播放/赞/评/转全部来自回流台账。
  async function topicBoards() {
    requireVault()
    const topics = await collections.topics.all({ includeVariants: false })
    // 平台版本台账里有更细的互动数据：按主选题取最新一条，补足评论/转发维度。
    const latestMetric = await latestMetricByMaster()
    const scored = topics.map((record) => {
      const front = record.front ?? {}
      const metric = latestMetric.get(String(record.id ?? front.id ?? '')) ?? {}
      const views = toNumber(metric.views)
      const likes = toNumber(metric.likes)
      const comments = toNumber(metric.comments)
      const shares = toNumber(metric.shares)
      return {
        path: record.path,
        title: String(record.title ?? ''),
        platform: normalizePlatform(front.platform),
        status: String(front.status ?? ''),
        // 拆解 vs 选题：type==='拆解' 是拆解别人的案例，只进爆款拆解卡；
        // type==='选题' 是自己的，进我的选题和日历管线。老笔记没写 type 时两边都显示
        // （跟客户端的排除式判断保持一致，别一处含一处不含）。
        type: String(front.type ?? '').trim(),
        views,
        likes,
        comments,
        shares,
        // 没回流数据的拆解不能留在榜单里赛跑，单独列出来提醒去回填。
        measured: views > 0 || likes > 0 || comments > 0 || shares > 0,
      }
    })
    // 「爆款拆解」这一榜排除 type==='选题'。以前这里不过滤，12 条选题全塞进内容榜，
    // 卡片写着「爆款拆解排行」排的却是自己的选题；而客户端那张卡按 type 排除，
    // 两边数出来的不是一个东西。
    const isBreakdown = (item) => item.type !== '选题'
    const content = scored.filter((item) => isBreakdown(item) && item.measured).sort((a, b) => b.views - a.views || b.likes - a.likes)
    const unmeasured = scored.filter((item) => isBreakdown(item) && !item.measured)
    const data = await collections.data.all({ includeVariants: false })
    const roi = data.map((record) => ({
      path: record.path,
      title: String(record.title ?? ''),
      period: String(record.front?.period ?? ''),
      gmv: toNumber(record.front?.gmv),
      traffic: toNumber(record.front?.traffic),
      conv: String(record.front?.conv ?? ''),
      roi: toNumber(record.front?.roi),
      mom: String(record.front?.mom ?? ''),
    // 以前这里是 .filter(item => item.roi > 0)：roi 没填（或为 0）的周期整条消失，
    // 于是「按 GMV」榜永远看不到那些有成交、没算 ROI 的周。现在只要有任一指标就留着，
    // 排序仍按 ROI 降序 —— 没 ROI 的自然沉到最后，而不是不存在。
    })).filter((item) => item.roi > 0 || item.gmv > 0 || item.traffic > 0).sort((a, b) => b.roi - a.roi || b.gmv - a.gmv)
    return { content, unmeasured, roi }
  }

  function calendarTableFor(month) {
    const target = String(month ?? '').trim() || thisMonth()
    if (!/^\d{4}-\d{2}$/.test(target)) throw new VaultError('月份格式应为 YYYY-MM', 'bad_request')
    return {
      month: target,
      file: join(dirOf('calendarDir'), target + '.md'),
      table: createWorkbenchTable({
        header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案', '选题ID', '版本ID', '账号', 'GMV', '转化率'],
        keys: ['date', 'platform', 'topic', 'status', 'note', 'link', 'topicPath', 'productPath', 'topicId', 'variantId', 'account', 'gmv', 'conv'],
        // 老月份的表有好几种列数，按单元格数挑补列规则（缺的列插回它原来的位置）：
        //   5 列 = 没有「备注」，在第 4 列后补空串，不然「链接」会被当成备注、原链接整个丢掉；
        //   6 列 = 没有关联键；7 列 = 只有选题笔记、没有商品档案；8 列 = 没有选题ID；9 列 = 没有版本ID。
        legacy: [
          { cells: 5, at: [{ index: 4 }] },
          { cells: 6, at: [{ index: 6 }, { index: 7 }] },
          { cells: 7, at: [{ index: 7 }] },
          { cells: 8, at: [{ index: 8 }] },
          { cells: 9, at: [{ index: 9 }, { index: 10 }] },
          { cells: 10, at: [{ index: 10 }] },
          // 11 列是加入 GMV / 转化率之前的现行表；最后两格补空，旧列顺序不动。
          { cells: 11, at: [] },
        ],
        // 主键按这一行的内容动态算：
        //   有选题ID → 选题ID+平台（改主题不会换行）；
        //   还没回填选题ID → 日期+平台+主题（升级那一刻不会把同天同平台的多行合并）；
        //   挂了版本ID → 再加一个版本ID（同选题同平台的多个版本各排各的）。
        idKeys: (values) => {
          const base = String(values?.topicId ?? '').trim() !== ''
            ? ['topicId', 'platform']
            : ['date', 'platform', 'topic']
          return String(values?.variantId ?? '').trim() === '' ? base : [...base, 'variantId']
        },
        idFallbackKeys: ['date', 'platform', 'topic'],
        heading: '# 内容日历 ' + target,
        intro: '> 状态：在写 / 待发 / 已发 / 待回填。选题笔记 / 商品档案填 vault 内相对路径（如 Topics/xxx.md）。GMV 填金额，转化率填百分数（如 3.2）。选题ID / 版本ID / 账号由系统自动填写。',
        label: '日历',
      }),
    }
  }

  // 日历读出来一份「归一过的」视图：平台名收敛成规范名，供展示和筛选用。
  // 只改内存，绝不写盘 —— 用户哪天想起自己写的是「bilibili」也该还是 bilibili。
  function normalizeCalendarEntries(entries) {
    return (entries ?? []).map((entry) => ({ ...entry, platform: normalizePlatform(entry.platform) }))
  }

  // 写侧守卫：日历一行只放一个平台。
  //
  // 以前「抖音 / 知乎」写在同一格里。格子里的东西拿去做主键就散了：同一格多平台时，
  // 表格按「选题ID + 平台」算行号都算不出来（平台本身就是一串），改一次主题就换一行，
  // 平台筛选也永远匹配不上那半串。
  //
  // 要同步发多个平台，走「分发到多个平台」—— 一次建 N 版、排 N 行，每行一个平台，
  // 每行一个版本 id，账才对得上。
  //
  // allowSame 的用处：老行里已经有这种格子时，改它的别的字段还得能用（别把人的数据锁死），
  // 但不能新写、也不能把别的行改成这样。
  function assertSinglePlatformCell(value, { allowSame = '' } = {}) {
    const list = splitPlatforms(String(value ?? ''))
    if (list.length <= 1) return
    const raw = String(value ?? '').trim()
    if (allowSame !== '' && raw === allowSame) return
    throw new VaultError('日历一行只能放一个平台；「' + list.join(' / ') + '」请用「分发到多个平台」一次排 N 行', 'bad_field')
  }

  // 日历行第一次保存时把选题的稳定 id 写进去。缺这个值时表格按老主键
  // date+platform+topic 算 id，改一次「主题」就会换一行；补上之后 id 就稳定了。
  async function calendarRowWithTopicId(row) {
    const next = { ...(row ?? {}) }
    next.status = normalizeVariantStatus(next.status) || '在写'
    const id = String(next.topicId ?? '').trim()
    const raw = String(next.topicPath ?? '').trim()
    let topic = null
    if (id !== '') {
      try { topic = await collections.topics.findById(id) } catch (error) {
        if (error.code !== 'not_found') throw error
      }
    }
    if (raw !== '') {
      const target = await resolveTopicPath(raw)
      if (target.ok === true) {
        const linked = await collections.topics.read(target.path)
        if (topic !== null && topic.id !== linked.id) throw new VaultError('日历选题 ID 与路径指向不同笔记', 'bad_field')
        topic = linked
      }
    }
    if (topic !== null) { next.topicId = topic.id; next.topicPath = topic.path }
    // 未关联的独立日历行仍可保存；可识别的关联必须写完整规范路径。
    return next
  }

  // 按稳定 ID / 完整路径建索引，跨目录同名绝不能仅凭尾段认领。
  async function topicsScheduleIndex() {
    const map = new Map()
    const notes = await listNotesUnder(dirNameOf('topics'))
    const paths = new Set(notes.map((note) => note.path))
    const leaves = new Map()
    for (const path of paths) {
      const leaf = path.split('/').pop()
      if (!leaves.has(leaf)) leaves.set(leaf, [])
      leaves.get(leaf).push(path)
    }
    const put = (key, hit) => {
      if (key === '') return
      const previous = map.get(key)
      if (previous === undefined || hit.date < previous.date) map.set(key, hit)
    }
    for (const month of await calendarMonths()) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      for (const entry of state.entries ?? []) {
        const date = String(entry.date ?? '').slice(0, 10)
        if (date === '') continue
        const hit = { month, date, status: String(entry.status ?? '') }
        const id = String(entry.topicId ?? '').trim()
        if (id !== '') put('id:' + id, hit)
        let path = String(entry.topicPath ?? '').trim().replace(/^\[\[|\]\]$/g, '').split('\\|')[0].replace(/\\/g, '/')
        if (path !== '' && !path.toLowerCase().endsWith('.md')) path += '.md'
        if (!paths.has(path)) {
          const candidates = path.includes('/') ? [] : leaves.get(path) ?? []
          path = candidates.length === 1 ? candidates[0] : ''
        }
        if (path !== '') put('path:' + path, hit)
      }
    }
    return map
  }

  function scheduleForTopic(record, index) {
    const path = String(record?.path ?? '').replace(/\\/g, '/')
    const id = String(record?.id ?? record?.front?.id ?? '')
    return index.get('path:' + path) ?? (id === '' ? undefined : index.get('id:' + id))
  }

  // 「同选题 + 同平台 + 某个版本」才是现在日历里的一行。
  // variantId 为空的是升级前的老行（只按选题+平台记），只在它还是这个平台唯一一条排期时才算给那一版。
  function scheduleKeyOf(masterId, platform, variantId = '') {
    const id = String(masterId ?? '').trim()
    if (id === '') return ''
    const base = id + '|' + normalizePlatform(String(platform ?? ''))
    const version = String(variantId ?? '').trim()
    return version === '' ? base : base + '|' + version
  }

  // 每个平台版本在日历里排在哪天：先按「选题ID|平台|版本ID」建精确索引；
  // 老行没写版本ID的单独放一组，读的时候再决定敢不敢认给某一版。
  async function variantScheduleIndex() {
    const byVariant = new Map()
    const byBase = new Map()
    for (const month of await calendarMonths()) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      for (const entry of state.entries ?? []) {
        const base = scheduleKeyOf(entry.topicId, entry.platform)
        if (base === '') continue
        const hit = {
          month,
          date: String(entry.date ?? '').slice(0, 10),
          id: String(entry.id ?? ''),
          status: String(entry.status ?? ''),
          variantId: String(entry.variantId ?? ''),
          platform: String(entry.platform ?? ''),
        }
        if (hit.variantId === '') {
          if (!byBase.has(base)) byBase.set(base, [])
          byBase.get(base).push(hit)
        } else if (!byVariant.has(base + '|' + hit.variantId)) {
          byVariant.set(base + '|' + hit.variantId, hit)
        }
      }
    }
    return { byVariant, byBase }
  }

  // 某个版本排在哪天：先按版本ID精确找；老行没写版本ID时，
  // 只有「这个选题+平台只剩一个版本、且只有一条老排期」才敢认给它 —— 多个版本绝不猜。
  function scheduleForVariant(variant, schedule, siblingCount = 1) {
    const masterId = variant?.front?.masterId
    const platform = variant?.front?.platform
    const exact = schedule?.byVariant?.get(scheduleKeyOf(masterId, platform, variant?.id))
    if (exact !== undefined) return exact
    const legacy = schedule?.byBase?.get(scheduleKeyOf(masterId, platform)) ?? []
    if (legacy.length === 1 && siblingCount <= 1) return legacy[0]
    return null
  }

  // 平台版本的「计划哪天发」只有一个来源：内容日历。版本笔记上不再记日期字段。
  // 同选题同平台到底有几个版本：老日历行（没写版本ID）只有在同平台只有一个版本时才敢认，
  // 否则「这一行排的是哪一版」本来就是分不清的，认了就是猜。
  function samePlatformCount(variants, variant) {
    const platform = normalizePlatform(variant?.front?.platform)
    const masterId = String(variant?.front?.masterId ?? '')
    return variants.filter((item) => String(item?.front?.masterId ?? '') === masterId && normalizePlatform(item?.front?.platform) === platform).length
  }

function scheduledDateOf(variant, schedule, siblingCount = 1) {
    const hit = scheduleForVariant(variant, schedule, siblingCount)
    return String(hit?.date ?? '').trim()
  }

  // 三组各自的下一个编号：新增一条硬规则应该接着 H7，而不是全库最大的那个。
  function nextIdsOf(items) {
    const out = {}
    for (const section of rules.RULES_SECTIONS) out[section.key] = rules.nextRuleId(items, section.key)
    return out
  }

  async function readRulesState() {
    if (rulesPath === '') throw new VaultError('还没配置 vault 根目录', 'bad_request')
    await vault.assertInsidePath(rulesPath)
    let text
    try {
      text = await readFile(rulesPath, 'utf8')
    } catch (error) {
      // 从零开始跑：文件还没有时当场铺一份空模板（目录一并建出来），
      // 不让用户对着 ENOENT 猜路径。
      if (error?.code !== 'ENOENT') throw error
      text = seedRules(today())
      await mkdir(dirname(rulesPath), { recursive: true })
      try {
        await writeFile(rulesPath, text, { encoding: 'utf8', flag: 'wx' })
      } catch (writeError) {
        if (writeError?.code !== 'EEXIST') throw writeError
        text = await readFile(rulesPath, 'utf8')
      }
    }
    return { text, sha1: rules.sha1Of(text) }
  }

  /**
   * 发布前自检清单：唯一真源是 vault 里 SOP 那份《发布前检查清单.md》。
   *
   * 找文件而不是写死完整路径 —— 用户把 SOP 挪个目录、换个名字都不该让清单失联。
   * 找不到（或者文件里一条自检项都没有）就返回 null：门禁会明确告诉人
   * 「没找到这份清单」，而不是假装全过了。
   */
  async function readChecklistDoc() {
    if (vault === null) return null
    const prefix = String(sopDirValue() ?? '').trim().replace(/^\/+|\/+$/g, '')
    const dirs = [...new Set([prefix, String(cfg('workbenchDir')).trim()])]
    for (const dir of dirs) {
      let listed = []
      try {
        listed = dir === ''
          ? (await vault.discover()).notes.map((note) => note.path)
          : await vault.listUnder(dir)
      } catch {
        continue
      }
      const hit = listed.find((rel) => {
        const name = rel.split('/').pop().replace(/\.md$/i, '')
        return CHECKLIST_TITLE_HINTS.some((hint) => name.includes(hint))
      })
      if (hit === undefined) continue
      const note = await vault.readNote(hit)
      const items = parseChecklist(note.text)
      if (items.length === 0) continue
      const uri = await vault.uriFor(hit)
      return { items, path: hit, uri }
    }
    return null
  }

  function seedRules(stamp) {
    return [
      '# 文案规则 / 语调库',
      '',
      '> hard = 禁忌（违反必改） · soft = 风格（尽量遵守） · watch = 待观察（证据不足，先记录）。',
      '> 每条写清「证据」是哪篇稿子/哪次数据得出的，「反例」是被毙掉的写法。',
      '',
      '## 状态一览',
      '',
      '| 指标 | 数值 |',
      '| --- | --- |',
      '| 硬规则数 | 0 |',
      '| 软规则数 | 0 |',
      '| 待观察 | 0 |',
      '| 最后整合 | ' + stamp + ' |',
      '',
      '## 硬规则',
      '',
      '## 软规则',
      '',
      '## 待观察',
      '',
    ].join('\n')
  }

  async function ensureSeeds() {
    if (vault === null) return
    // 从零开始跑的板块：目录还不存在时先把建出来，别等第一次写入才发现路径缺了。
    // （列目录/写文件本身都会 mkdir，这里兜的是「读一个空板块」的场景——
    //  discover 对缺失目录返回 missing，用户看到的却是「找不到路径」。）
    const dirKeys = ['sopDir', 'workbenchDir', 'copyRulesDir', 'topicsDir', 'campaignsDir', 'dataDir', 'feedbackDir', 'productsDir', 'accountsDir', 'calendarDir']
    for (const key of dirKeys) await vault.assertInsidePath(key === 'sopDir' ? join(vaultRoot(), sopDirValue()) : dirOf(key))
    for (const key of dirKeys) {
      const dir = normalizeVaultSubdir(key === 'sopDir' ? sopDirValue() : cfg(key))
      if (dir === '' || dir === '.') continue
      try {
        await mkdir(join(vaultRoot(), dir), { recursive: true })
      } catch (error) {
        logger.warn('growth-workbench: ensure dir ' + dir + ' — ' + describe(error))
      }
    }
    const seeds = [
      { file: join(dirOf('workbenchDir'), '指标与黑话.md'), text: tables.glossary.serialize([]) },
      { file: join(dirOf('workbenchDir'), '灵感箱.md'), text: tables.ideas.serialize([]) },
      { file: join(dirOf('feedbackDir'), '客户反馈.md'), text: tables.feedback.serialize([]) },
      { file: rulesPath, text: seedRules(today()) },
    ]
    for (const seed of seeds) {
      try {
        await vault.assertInsidePath(seed.file)
        await mkdir(join(seed.file, '..'), { recursive: true })
        await writeFile(seed.file, seed.text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') logger.warn('growth-workbench: seed ' + seed.file + ' — ' + describe(error))
      }
    }
  }

  async function requireTable(result) {
    if (result.ok === true) return result
    throw new TableValidationError(result.error, result.code ?? 'invalid_table')
  }

  function requireVault() {
    if (vault === null) throw new VaultError('还没配置 vault 根目录，先点「设置」填一个 Obsidian vault 路径', 'bad_request')
  }

  // 选题阶段只有一个口径：frontmatter 和日历排期里较「靠后」的那个状态说了算。
  // 以前首页用这个合并口径、我的选题只看 frontmatter，两个地方会同时显示
  // 「创作中 0」和一张写着创作中的卡；现在统一由后端算好 `stage` 给前端。
  function topicStageOf(frontStatus, scheduleStatus) {
    const map = { 选题: '在写', 创作中: '在写', 待审: '待发', 已排期: '待发', 数据回流: '待回填', 已回填: '待回填' }
    const norm = (value) => map[String(value ?? '').trim()] ?? String(value ?? '').trim()
    const front = norm(frontStatus)
    const sched = norm(scheduleStatus)
    if (['已发', '待回填'].includes(front) || ['已发', '待回填'].includes(sched)) return 'shipped'
    return ['在写', '待发'].includes(front) || ['在写', '待发'].includes(sched) ? 'doing' : 'backlog'
  }

  async function summary() {
    requireVault()
    const [discovery, ideas, glossary, feedback] = await Promise.all([
      vault.discover({ force: true }),
      tables.ideas.read(join(dirOf('workbenchDir'), '灵感箱.md')),
      tables.glossary.read(join(dirOf('workbenchDir'), '指标与黑话.md')),
      tables.feedback.read(join(dirOf('feedbackDir'), '客户反馈.md')),
    ])
    const cal = calendarTableFor(thisMonth())
    const [calendar, topics, campaigns, products, dataRecords, accounts] = await Promise.all([
      cal.table.read(cal.file),
      collections.topics.all({ includeVariants: false }),
      collections.campaigns.all({ includeVariants: false }),
      collections.products.all({ includeVariants: false }),
      collections.data.all({ includeVariants: false }),
      collections.accounts.all({ includeVariants: false }),
    ])
    // 回流台账也躺在 Data/ 下，但它记的是「按平台版本按天」的明细，不是周期复盘。
    // 不过滤的话首页「电商数据复盘」的条数会被台账文件撑大（3 个周期会显示成 5 条）。
    const dataPeriods = dataRecords.filter((record) => !String(record.path ?? '').includes('/回流台账/'))
    // 我的选题的摘要数字和卡片分区用同一口径：笔记 frontmatter 或日历排期任一说
    // 「创作中」就算创作中；任一说已发/数据回流就算已发（回流写回是终态）。
    const studioSchedule = await topicsScheduleIndex()
    const stageOf = (record) => {
      const hit = scheduleForTopic(record, studioSchedule)
      return topicStageOf(record?.front?.status, hit?.status)
    }
    let ruleCounts = { hard: 0, soft: 0, watch: 0 }
    try {
      const state = await readRulesState()
      ruleCounts = rules.countsOf(rules.parseRules(state.text).items)
    } catch {
      ruleCounts = { hard: 0, soft: 0, watch: 0 }
    }
    const sopPrefix = sopDirValue().replace(/^\/+|\/+$/g, '')
    const inSop = (path) => path === sopPrefix || path.startsWith(sopPrefix + '/')
    // 数据复盘 = 回流台账里的记录条数（播放/赞/评/转的唯一来源）。
    const metrics = domain === null ? [] : await domain.listMetrics()
    return {
      sopNotes: discovery.notes.filter((note) => inSop(note.path)).length,
      contentDataCount: metrics.length,
      contentDataLatest: metrics.length === 0 ? '' : String(metrics[0].date ?? '').slice(0, 7),
      topics: topics.length,
      topicsDoing: topics.filter((record) => stageOf(record) === 'doing').length,
      topicsScripted: topics.filter((record) => record.script === 'draft' || record.script === 'ab').length,
      campaignsActive: campaigns.filter((record) => String(record.front?.status ?? '').includes('进行')).length,
      campaignsTotal: campaigns.length,
      productsMine: products.filter((record) => String(record.front?.kind ?? '').includes('自家')).length,
      productsRival: products.filter((record) => String(record.front?.kind ?? '').includes('竞品')).length,
      accountsTotal: accounts.length,
      dataLatest: dataPeriods[0]?.front?.period ?? '',
      dataCount: dataPeriods.length,
      ideasNew: ideas.entries.filter((entry) => entry.status !== '已用' && entry.status !== '丢弃' && entry.status !== '已废弃').length,
      ideasTotal: ideas.entries.length,
      glossary: glossary.entries.length,
      // 负面「还没人管」= 情感是负、状态是「未处理」。
      // 以前这里写的是「不是已处理/闭环」—— 把「跟进中」也算成没人管，
      // 而客户端那张卡按「未处理」算，两边数出来的不是一个数（同一个库里 1 vs 0）。
      // 现在两边同一个口径：有跟进中就是有人在管，不算「没人管」。
      feedbackNegativeOpen: feedback.entries.filter((entry) => String(entry.sentiment).includes('负') && String(entry.status).trim() === '未处理').length,
      feedbackTotal: feedback.entries.length,
      pendingCount: await pendingCountOf(),
      calendarMonth: cal.month,
      calendarPending: calendar.entries.filter((entry) => ['在写', '待发'].includes(String(entry.status))).length,
      calendarTotal: calendar.entries.length,
      ruleCounts,
    }
  }

  async function handle(req, route, url) {
    const method = req.method ?? 'GET'
    const q = (key) => String(url.searchParams.get(key) ?? '')
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readJsonBody(req) : {}

    if (route === '' || route === 'ping') return { ping: true, version: PKG_VERSION }

    // 检查更新：只读。不下载、不解压、不覆盖任何文件 —— 更新动作留给用户。
    if (route === 'update-check' && method === 'GET') return await updateState(q('force') === '1')

    // 浏览器半边的诊断落点。面板跑在别人的页面里，控制台不是随时都能看，
    // 所以让它把自己的探测结果写进本机文件：重启一次就能看清是哪一层没接上。
    if (route === 'client-log' && method === 'POST') {
      try {
        // 例行成功探测（每次加载/每次开会话都会报）只在进程内记第一次：
        // 要的是「哪一层没接上」，不是把成功路径刷满整个文件。失败类永远记。
        const label = String(body?.label ?? '')
        if (!ROUTINE_LOG_LABELS.has(label) || !clientLogSeen.has(label)) {
          clientLogSeen.add(label)
          rotateAppend(join(traceDir, 'client.log'), `${new Date().toISOString()} ${JSON.stringify(body)}\n`, 1024 * 1024)
        }
      } catch {
        // 记不上不影响任何功能。
      }
      return { logged: true }
    }

    /**
     * vault 根目录不是随便什么路径都能填：填成 C:\ 或 C:\Windows 之后，
     * 后面所有「相对 vault 根」的判断全部失效，等于把整个磁盘交给插件；
     * 更糟的是 /open-vault 会拿它去 spawn 系统默认程序。
     * 这里当场挡住盘符根、系统目录和不存在/不是目录的路径。
     */
    async function assertVaultRoot(input) {
      const raw = String(input ?? '').trim()
      if (raw === '') return ''
      if (!isAbsolute(raw)) throw new VaultError('vault 根目录要填绝对路径，例如 G:\\Obsidian', 'bad_request')
      const resolved = resolve(raw)
      const normalized = resolved.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
      const rootPart = parsePath(resolved).root.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
      if (normalized === rootPart) throw new VaultError('不能把整个磁盘当 vault 根目录：' + resolved, 'bad_request')
      // 系统目录要按「去掉盘符之后」的尾部比较：c:/windows 的尾巴是 /windows，
      // 否则带盘符的写法会一路放行（实测 C:\Windows 曾经通过）。
      const tailOnly = normalized.replace(/^[a-z]:/, '')
      const banned = ['/windows', '/program files', '/program files (x86)', '/programdata', '/system volume information', '/$recycle.bin']
      for (const entry of banned) {
        if (tailOnly === entry || tailOnly.startsWith(entry + '/')) {
          throw new VaultError('这是系统目录，不适合当 vault：' + resolved, 'bad_request')
        }
      }
      let info = null
      try {
        info = await stat(resolved)
      } catch {
        throw new VaultError('这个目录不存在：' + resolved, 'bad_request')
      }
      if (!info.isDirectory()) throw new VaultError('这不是文件夹：' + resolved, 'bad_request')
      return resolved
    }

    if (route === 'state' && method === 'GET') {
      return {
        config: publicConfig(), dataDir: dataDir(), configured: vaultRoot() !== '', cards,
        operationalSettings: operationalSettingsLoadError === null ? {
          schemaVersion: operationalSettings.schemaVersion,
          revision: operationalSettings.revision,
          activeProfileId: operationalSettings.activeProfileId,
          profiles: operationalSettings.profiles,
        } : null,
        ...(operationalSettingsLoadError === null ? {} : { operationalSettingsError: { code: 'read_failed', message: describe(operationalSettingsLoadError) } }),
      }
    }

    if (route === 'health' && method === 'GET') {
      const startedAt = Date.now()
      const root = vaultRoot()
      let vaultReadable = false
      let vaultMessage = root === '' ? '尚未连接 vault' : ''
      if (root !== '') {
        try {
          const info = await stat(root)
          vaultReadable = info.isDirectory()
          if (!vaultReadable) vaultMessage = 'vault 路径不是文件夹'
        } catch (error) {
          vaultMessage = 'vault 目录不可读：' + describe(error)
        }
      }
      return {
        version: PKG_VERSION,
        configured: root !== '',
        vaultReadable,
        vaultMessage,
        watcher: root !== '' && existsSync(root) && ensureVaultWatcher() !== null ? 'active' : 'fallback',
        elapsedMs: Date.now() - startedAt,
      }
    }

    if (route === 'operational-settings' && method === 'GET') {
      requireOperationalSettings()
      return operationalPayload()
    }

    if (route === 'operational-settings/profiles' && method === 'POST') {
      return operationalTransaction(body?.expectedRevision, (draft) => {
        const supplied = body?.profile ?? {}
        const id = String(supplied.id ?? '').trim()
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id)) throw new VaultError('运营档案 id 不合法', 'bad_field')
        if (draft.profiles.some((profile) => profile.id === id)) throw new VaultError('运营档案已存在：' + id, 'duplicate')
        const base = createDefaultOperationalSettings(DEFAULT_CARDS).profiles[0]
        const profile = body?.replace === true
          ? { ...supplied, id }
          : {
            ...base,
            id,
            name: supplied.name,
            description: supplied.description ?? '',
            goals: supplied.goals ?? [],
            content: supplied.content ?? base.content,
            audience: supplied.audience ?? base.audience,
            platforms: supplied.platforms ?? [],
            accounts: supplied.accounts ?? [],
          }
        draft.profiles.push(profile)
        if (body?.activate === true) draft.activeProfileId = id
        return { createdProfile: profile }
      })
    }

    if (route === 'operational-settings/active-profile' && method === 'PUT') {
      return operationalTransaction(body?.expectedRevision, (draft) => {
        const id = String(body?.profileId ?? '')
        const profile = draft.profiles.find((entry) => entry.id === id)
        if (profile === undefined) throw new VaultError('找不到运营档案：' + id, 'not_found')
        draft.activeProfileId = id
        return { activeProfile: profile }
      })
    }

    if (route.startsWith('operational-settings/profiles/') && route.endsWith('/rules') && method === 'PUT') {
      const id = operationalRouteId(route, '/rules')
      return operationalTransaction(body?.expectedRevision, (draft) => {
        const profile = draft.profiles.find((entry) => entry.id === id)
        if (profile === undefined) throw new VaultError('找不到运营档案：' + id, 'not_found')
        const next = body?.rules ?? {}
        for (const key of ['workflow', 'automation', 'publishGates', 'observationCheckpoints', 'aiContext', 'reminders', 'successBenchmarks']) profile[key] = next[key]
        return { profile }
      })
    }

    if (route.startsWith('operational-settings/profiles/') && route.endsWith('/workspaces') && method === 'PUT') {
      const id = operationalRouteId(route, '/workspaces')
      return operationalTransaction(body?.expectedRevision, (draft) => {
        const profile = draft.profiles.find((entry) => entry.id === id)
        if (profile === undefined) throw new VaultError('找不到运营档案：' + id, 'not_found')
        profile.cardLayout = body?.cardLayout
        return { profile }
      })
    }

    if (route.startsWith('operational-settings/profiles/') && !route.slice('operational-settings/profiles/'.length).includes('/')) {
      const id = operationalRouteId(route)
      if (method === 'PUT') {
        return operationalTransaction(body?.expectedRevision, (draft) => {
          const index = draft.profiles.findIndex((entry) => entry.id === id)
          if (index < 0) throw new VaultError('找不到运营档案：' + id, 'not_found')
          if (body?.profile?.id !== undefined && body.profile.id !== id) throw new VaultError('运营档案 id 不能修改', 'bad_field')
          const current = draft.profiles[index]
          const next = body?.profile ?? {}
          if (body?.replace === true) {
            draft.profiles[index] = { ...next, id }
          } else {
            draft.profiles[index] = {
              ...current,
              name: next.name,
              description: next.description,
              goals: next.goals,
              content: next.content,
              audience: next.audience,
              platforms: next.platforms,
              accounts: next.accounts,
            }
          }
          return { profile: draft.profiles[index] }
        })
      }
      if (method === 'DELETE') {
        return operationalTransaction(body?.expectedRevision, (draft) => {
          const index = draft.profiles.findIndex((entry) => entry.id === id)
          if (index < 0) throw new VaultError('找不到运营档案：' + id, 'not_found')
          if (draft.profiles.length === 1) throw new VaultError('至少保留一个运营档案', 'bad_request')
          if (draft.activeProfileId === id) throw new VaultError('请先切换运营档案，再删除当前档案', 'bad_request')
          draft.profiles.splice(index, 1)
          return { deletedProfileId: id }
        })
      }
    }

    if (route === 'config' && method === 'PUT') {
      return queueCommit('config', async () => {
        const root = await assertVaultRoot(body?.vaultRoot)
        const nextDataDir = String(body?.pluginDataDir ?? '').trim()
        if (nextDataDir !== '' && nextDataDir !== dataDir()) {
          throw new VaultError('数据目录只能由 DSH 启动配置指定，不能在运行中修改', 'bad_request')
        }
        const nextDirs = {}
        const resetSop = typeof body?.sopDir === 'string' && body.sopDir.trim() === ''
        // 全部校验完再改内存/落盘；子目录不能利用 ../ 或链接绕过 vault 边界。
        for (const key of Object.keys(DEFAULT_DIRS)) {
          if (key === 'vaultRoot' || key === 'pluginDataDir') continue
          const supplied = typeof body?.[key] === 'string' ? body[key].trim() : ''
          const raw = supplied || (key === 'sopDir' && resetSop ? DEFAULT_DIRS.sopDir : String(cfg(key) ?? ''))
          const dir = raw === '' ? '' : normalizeVaultSubdir(raw, { allowEmpty: false })
          if (supplied !== '') nextDirs[key] = dir
          if ((root || vaultRoot()) !== '') await assertPathInsideRoot(root || vaultRoot(), join(root || vaultRoot(), dir))
        }
        const nextUserConfig = { ...userConfig, ...nextDirs }
        if (root !== '') nextUserConfig.vaultRoot = root
        if (resetSop) delete nextUserConfig.sopDir
        await saveUserConfig(nextUserConfig)
        userConfig = nextUserConfig
        build()
        vault?.invalidate()
        await ensureSeeds()
        return { saved: true, configured: vaultRoot() !== '', dataDir: dataDir(), config: publicConfig(), cards }
      })
    }

    if (route === 'cards' && method === 'PUT') {
      if (!Array.isArray(body?.cards)) return { cards }
      return operationalTransaction(body?.expectedRevision, (draft) => {
        const requested = new Map(body.cards.map((entry) => [String(entry?.id ?? ''), entry.enabled !== false]))
        const profile = draft.profiles.find((entry) => entry.id === draft.activeProfileId)
        profile.cardLayout = profile.cardLayout.map((entry) => requested.has(entry.id) ? { ...entry, visible: requested.get(entry.id) } : entry)
        return {}
      }, { optionalRevision: true })
    }

    if (route === 'overview' && method === 'GET') return { summary: await summary() }
    if (route === 'boards' && method === 'GET') return topicBoards()
    if (route === 'product-rollup' && method === 'GET') return productRollup()

    requireVault()

    // ── v2 领域层接口 ────────────────────────────────────────────────────
    // 主选题 = Topics 笔记；平台版本 = Workbench/平台版本 下的笔记；指标 = Data/回流台账。
    // 这些接口是给后续 UI 和迁移脚本用的，旧接口暂时保留，避免一次性改坏面板。
    const v2 = route.startsWith('v2/') ? route.slice(3).split('/').filter((part) => part !== '') : []
    function realMasterRecords(records) {
      return records.filter((record) => !String(record.path ?? '').startsWith('Topics/测试/'))
    }
    async function findMasterRecord(id) {
      const wanted = String(id ?? '').trim()
      // 直接按 ID 打开主选题时允许命中 Topics/测试/（测试笔记也要能看平台版本）；
      // 只有列表 / 矩阵 / 队列这些聚合视图才过滤测试数据。
      return collections.topics.findById(wanted)
    }

    if (v2[0] === 'state' && v2.length === 1 && method === 'GET') {
      const masters = realMasterRecords(await collections.topics.all({ includeVariants: false }))
      return {
        version: 2,
        statuses: VARIANT_STATUSES,
        transitions: VARIANT_TRANSITIONS,
        masters,
      }
    }
    if (v2[0] === 'migration' && v2.length === 2 && v2[1] === 'preview' && method === 'GET') {
      // 迁移是低频操作，但每次都必须看磁盘现状：用户在 Obsidian 里刚放进来
      // 的旧选题不能被 3 秒的发现缓存漏掉，否则预览会少算、补 id 也会漏。
      vault?.invalidate()
      return { migration: await migrator.preview() }
    }
    if (v2[0] === 'migration' && v2.length === 2 && v2[1] === 'apply' && method === 'POST') {
      vault?.invalidate()
      return { migration: await migrator.apply({ dryRun: body?.dryRun === true }) }
    }
    function groupVariants(variants) {
      const groups = new Map()
      for (const variant of variants) {
        const id = String(variant.front?.masterId ?? '')
        if (!groups.has(id)) groups.set(id, [])
        groups.get(id).push(variant)
      }
      return groups
    }

    if (v2[0] === 'checklist' && v2.length === 1 && method === 'GET') {
      // 自检清单直接给前端渲染：条目、来源文件、Obsidian 链接。
      // 前端不再自己抄一份 —— 抄一份就会和 SOP 那份对不上。
      const doc = await readChecklistDoc()
      if (doc === null) return { items: [], total: 0, path: '', uri: '', missing: true }
      return { items: doc.items, total: doc.items.length, path: doc.path, uri: doc.uri, missing: false }
    }
    if (v2[0] === 'masters' && v2.length === 1 && method === 'GET') {
      const masters = realMasterRecords(await collections.topics.all({ includeVariants: false }))
      const grouped = groupVariants(await domain.listVariants('', { includeMetrics: false }))
      for (const master of masters) {
        const variants = grouped.get(String(master.id)) ?? []
        const counts = Object.fromEntries(VARIANT_STATUSES.map((status) => [status, variants.filter((variant) => variant.status === status).length]))
        master.variants = { total: variants.length, counts }
      }
      return { masters }
    }
    if (v2[0] === 'masters' && v2.length === 1 && method === 'POST') {
      const created = await collections.topics.create(body)
      const record = await collections.topics.read(created.path)
      return { master: { ...record, variants: await domain.variantSummary(record.id) } }
    }
    if (v2[0] === 'masters' && v2.length === 2 && method === 'GET') {
      const master = await findMasterRecord(v2[1])
      const variants = await domain.listVariants(master.id)
      // 平台版本列表要显示「已排 11-08」，点「排期」还要落到那一行 ——
      // 所以在这里把日历里「同选题 + 同平台」的那条挂上去，别让前端自己扫一遍日历表。
      const schedule = await variantScheduleIndex()
      for (const variant of variants) {
        variant.schedule = scheduleForVariant(variant, schedule, samePlatformCount(variants, variant))
      }
      return { master, variants }
    }
    if (v2[0] === 'masters' && v2.length === 2 && (method === 'PUT' || method === 'PATCH')) {
      const master = await findMasterRecord(v2[1])
      return { written: await collections.topics.update(master.path, body) }
    }
    if (v2[0] === 'masters' && v2.length === 3 && v2[2] === 'variants' && method === 'GET') {
      const master = await findMasterRecord(v2[1])
      const variants = await domain.listVariants(master.id)
      // 平台版本列表要显示「已排 11-08」，点「排期」还要落到那一行 ——
      // 所以在这里把日历里「同选题 + 同平台」的那条挂上去，别让前端自己扫一遍日历表。
      const schedule = await variantScheduleIndex()
      for (const variant of variants) {
        variant.schedule = scheduleForVariant(variant, schedule, samePlatformCount(variants, variant))
      }
      return { variants }
    }
    if (v2[0] === 'masters' && v2.length === 3 && v2[2] === 'variants' && method === 'POST') {
      return { variant: await domain.createVariant({ ...body, masterId: v2[1] }) }
    }
    if (v2[0] === 'variants' && v2.length === 1 && method === 'GET') {
      const variants = await domain.listVariants(q('masterId'))
      // 我的选题卡片上的版本行也要显示「这一版排在哪天」：多版本各自排期之后，
      // 只看主选题的日期会以为两版同一天。
      const schedule = await variantScheduleIndex()
      for (const variant of variants) variant.schedule = scheduleForVariant(variant, schedule, samePlatformCount(variants, variant))
      return { variants }
    }
    if (v2[0] === 'variants' && v2.length === 2 && method === 'GET') return { variant: await domain.getVariant(v2[1]) }
    if (v2[0] === 'variants' && v2.length === 2 && (method === 'PUT' || method === 'PATCH')) {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.updateVariant(variant.path, body) }
    }
    if (v2[0] === 'variants' && v2.length === 2 && method === 'DELETE') {
      // 删一个平台版本。和 delete-note 同一条路：先备份再删，带 sha1 校验，
      // 免得把 Obsidian 里刚改过的版本删掉。主选题不动。
      const variant = await domain.getVariant(v2[1])
      const latest = await vault.readNote(variant.path)
      const expected = String(body?.expectedSha1 ?? (q('expectedSha1') || q('sha1'))).trim()
      if (expected !== '' && expected !== latest.sha1) {
        throw new VaultError('这个平台版本在别处被改过（Obsidian 里？），刷新后再删', 'conflict')
      }
      await vault.deleteNote(variant.path, { expectedSha1: expected || latest.sha1 })
      vault.invalidate()
      return { deleted: variant.path }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'transition' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return transitionVariantWithCalendar(variant, body?.to ?? body?.status, {
        actor: body?.actor, at: body?.at, reviewDays: body?.reviewDays, link: body?.link,
      })
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'archive' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.archiveVariant(variant.path, { actor: body?.actor }) }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'restore' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      const restored = await domain.restoreVariant(variant.path)
      return { variant: restored }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'metrics' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      if (!['已发', '待回填', '已结案'].includes(variant.status)) throw new VaultError('只有已经发布的版本才能回填数据', 'bad_request')
      if (String(variant.front?.publishedAt ?? '').trim() === '') throw new VaultError('这个版本没有实际发布时间，不能回填发布后数据；请先在版本或日历中确认发布', 'bad_request')
      const metric = await domain.appendMetric({ ...body, variantId: variant.id, masterId: variant.front?.masterId, platform: variant.front?.platform, account: variant.front?.account, dataDir: dirOf('dataDir') })
      const profile = activeOperationalProfile()
      const benchmark = profile === null ? null : await evaluateOperationalBenchmarks(profile, variant, metric.entry)
      const observationPlan = profile === null ? [] : buildObservationPlan(profile, variant.front.publishedAt)
      return {
        metric,
        operational: profile === null ? null : {
          profileId: profile.id,
          benchmark,
          observationPlan,
          reminders: inAppReminders(profile, observationPlan),
        },
      }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'close-review' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.closeReview(variant.path, body?.metricId, { actor: body?.actor, insight: body?.insight }) }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'start-review' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.startReview(variant.path, body?.reviewDays, { actor: body?.actor }) }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'correct-identity' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      const calendarPlans = []
      const account = await collections.accounts.findById(body?.accountId)
      const platform = normalizePlatform(String(account.front?.platform ?? ''))
      const accountName = String(account.front?.name ?? '').trim()
      for (const month of await calendarMonths()) {
        const cal = calendarTableFor(month)
        const state = await cal.table.read(cal.file)
        if (state.warning !== undefined) throw new VaultError('日历 ' + month + ' 读取失败：' + state.warning, state.code ?? 'read_failed')
        const before = state.entries ?? []
        const next = before.map((entry) => String(entry.variantId ?? '') === variant.id
          ? { ...entry, platform, account: accountName }
          : entry)
        if (next.some((entry, index) => entry !== before[index])) calendarPlans.push({ month, cal, before, next, sha1: state.sha1 ?? '' })
      }
      const applied = await applyCalendarPlans(calendarPlans)
      try {
        const corrected = await domain.correctVariantIdentity(variant.path, body?.accountId)
        return { variant: corrected, calendarSynced: applied.map((plan) => plan.month) }
      } catch (error) {
        const rollbackFailed = await rollbackCalendarPlans(applied)
        if (rollbackFailed.length > 0) throw new VaultError('归属纠正失败，且部分日历回滚失败，请手动检查', 'conflict', { partial: true, cause: error?.message ?? String(error), rollbackFailed })
        throw error
      }
    }
    if (v2[0] === 'matrix' && v2.length === 1 && method === 'GET') {
      const month = q('month') || thisMonth()
      const masters = realMasterRecords(await collections.topics.all({ includeVariants: false }))
      // 日期只有一个真源：内容日历。没排期的版本不进月视图 ——
      // 没有排期的版本不进月视图：以前空日期每个月都放进来，同一个版本被数了十二遍。
      const schedule = await variantScheduleIndex()
      const rows = []
      const grouped = groupVariants(await domain.listVariants())
      for (const master of masters) {
        const all = grouped.get(String(master.id)) ?? []
        const variants = all.filter((variant) => {
          const date = scheduledDateOf(variant, schedule, samePlatformCount(all, variant))
          return date !== '' && date.startsWith(month)
        })
        for (const variant of variants) variant.schedule = scheduleForVariant(variant, schedule, samePlatformCount(all, variant))
        if (variants.length === 0) continue
        rows.push({ master: { id: master.id, title: master.title, path: master.path }, variants })
      }
      return { month, rows }
    }
    if (v2[0] === 'queue' && v2.length === 1 && method === 'GET') {
      const month = q('month') || thisMonth()
      const masters = realMasterRecords(await collections.topics.all({ includeVariants: false }))
      const schedule = await variantScheduleIndex()
      const items = []
      const grouped = groupVariants(await domain.listVariants())
      for (const master of masters) {
        const variants = grouped.get(String(master.id)) ?? []
        for (const variant of variants) {
          // 发布队列只列本月仍在写或待发、且没有被收纳的版本。
          if (variant.archived || !['在写', '待发'].includes(variant.status)) continue
          // 没排期的不属于任何一个月：它属于「还没定日子」，不是「本月待发」。
          const date = scheduledDateOf(variant, schedule, samePlatformCount(variants, variant))
          if (date === '' || !date.startsWith(month)) continue
          variant.schedule = scheduleForVariant(variant, schedule, samePlatformCount(variants, variant))
          items.push({ master: { id: master.id, title: master.title, path: master.path }, variant })
        }
      }
      items.sort((left, right) => String(left.variant.schedule?.date ?? '').localeCompare(String(right.variant.schedule?.date ?? '')) || String(left.master.title).localeCompare(String(right.master.title), 'zh'))
      return { month, items }
    }
    // 「待回填数据」的数据来源：已发布（或已在回流中）的平台版本。
    // 数据按版本记，不按选题记 —— 同一条选题在抖音和 小红书 的数字本来就不一样，
    // 写进同一篇选题笔记的 views/likes 只会互相覆盖（旧接口就吃过这个亏）。
    if (v2[0] === 'pending' && v2.length === 1 && method === 'GET') {
      const masters = realMasterRecords(await collections.topics.all({ includeVariants: false }))
      const masterById = new Map(masters.map((master) => [String(master.id ?? master.front?.id ?? ''), master]))
      const items = []
      // 「已排/未排发布」以内容日历为准：把同选题+同平台的排期挂上，和我的选题列表同一口径。
      const schedule = await variantScheduleIndex()
      const allVariants = await domain.listVariants()
      const siblingCounts = new Map()
      for (const variant of allVariants) {
        const key = JSON.stringify([String(variant.front?.masterId ?? ''), normalizePlatform(variant.front?.platform)])
        siblingCounts.set(key, (siblingCounts.get(key) ?? 0) + 1)
      }

      for (const variant of allVariants) {
        if (variant.archived || !['已发', '待回填'].includes(variant.status)) continue
        // 状态文字不是发布事实。旧数据可能手工写成「已发」，但没有经过发布动作，
        // 因而没有实际发布时间。这类矛盾记录留在版本处修正，不能进入发布后的回填队列。
        if (String(variant.front?.publishedAt ?? '').trim() === '') continue
        const master = masterById.get(String(variant.front?.masterId ?? ''))
        // 主选题被删或落在测试目录的版本不往这里列：没有标题的行点了也没处去。
        if (master === undefined) continue
        variant.schedule = scheduleForVariant(variant, schedule, siblingCounts.get(JSON.stringify([String(variant.front?.masterId ?? ''), normalizePlatform(variant.front?.platform)])) ?? 0)
        items.push({
          master: { id: master.id, title: master.title, path: master.path },
          variant,
        })
      }
      const todayKey = dayInZone('Asia/Shanghai')
      const taskOf = (item) => {
        const front = item.variant.front ?? {}
        const publishedAt = String(front.publishedAt ?? '').trim()
        const dueDate = String(front.reviewDueAt ?? '').slice(0, 10)
        const hasMetric = item.variant.latestMetric !== null && item.variant.latestMetric !== undefined
        // publishedAt 已在入队前验证。这里只兜旧数据里缺观察截止的情况；
        // 它仍有真实发布时间，可以回填，只是无法按截止日排序。
        if (dueDate === '') return { kind: 'unscheduled_review', label: '未设截止', dueDate: '', rank: 4 }
        if (dueDate < todayKey) return { kind: 'overdue', label: '逾期', dueDate, rank: 0 }
        if (dueDate === todayKey) return { kind: 'due_today', label: '今日截止', dueDate, rank: 1 }
        if (!hasMetric) return { kind: 'unrecorded', label: '未录入', dueDate, rank: 2 }
        return { kind: 'upcoming', label: '观察中', dueDate, rank: 3 }
      }
      for (const item of items) item.reviewTask = taskOf(item)
      items.sort((left, right) => left.reviewTask.rank - right.reviewTask.rank
        || String(left.reviewTask.dueDate || '9999-12-31').localeCompare(String(right.reviewTask.dueDate || '9999-12-31'))
        || String(left.master.title).localeCompare(String(right.master.title), 'zh'))
      return { items }
    }
    if (v2[0] === 'ledger' && v2.length === 1 && method === 'GET') {
      const month = q('month').trim()
      const masters = await collections.topics.all({ includeVariants: false })
      const masterById = new Map(masters.map((master) => [String(master.id ?? master.front?.id ?? ''), master]))
      const variants = await domain.listVariants()
      const variantById = new Map(variants.map((variant) => [String(variant.id), variant]))
      const rows = (await domain.listMetrics())
        .filter((metric) => month === '' || String(metric.date ?? '').startsWith(month) || String(metric.file ?? '').endsWith('/' + month + '.md'))
        .map((metric) => {
          const master = masterById.get(String(metric.masterId ?? ''))
          const variant = variantById.get(String(metric.variantId ?? ''))
          return {
            ...metric,
            masterTitle: master === undefined ? '' : master.title,
            masterPath: master === undefined ? '' : master.path,
            variantPath: variant === undefined ? '' : variant.path,
            variantStatus: variant === undefined ? '' : variant.status,
          }
        })
      return { month, rows }
    }

    if (route === 'search' && method === 'GET') {
      if (q('q').trim() === '') return { matches: [] }
      const scope = q('scope') === 'all' ? 'all' : 'workbench'
      // scope=workbench（默认）只搜工作台自己那几类目录；
      // 传 scope=all 才搜整个 vault。先按全量取，再过滤，免得
      // limit 被无关目录占满之后工作台自己的命中条数所剩无几。
      const prefixes = workbenchPrefixes()
      const raw = await vault.search(q('q'), { limit: scope === 'all' ? 80 : 400 })
      if (scope === 'all') return { matches: raw, scope, prefixes }
      const inScope = raw.filter((hit) => prefixes.some((dir) => (dir === '' ? !hit.path.includes('/') : hit.path.startsWith(dir + '/'))))
      return { matches: inScope.slice(0, 80), scope, prefixes, total: inScope.length }
    }

    const prefixOf = () => String(sopDirValue() ?? '').trim().replace(/^\/+|\/+$/g, '')
    // tree() 里笔记节点的 path 已经是 vault 根相对路径（relOf），目录节点则是相对 sopDir 的。
    // 所以只给目录补前缀，笔记保持原样 —— 补两次会变成 SOP/SOP/xxx.md。
    const withPrefix = (nodes, prefix) => (prefix === ''
      ? nodes
      : nodes.map((node) => (node.type === 'dir'
        ? {
          ...node,
          path: prefix + '/' + node.path,
          children: withPrefix(node.children, prefix),
        }
        : node)))
    const treePayload = async () => {
      const prefix = prefixOf()
      const scope = prefix === '' ? 'vault' : 'sop'
      const tree = await vault.tree({ scope })
      return { tree: withPrefix(tree, prefix), scope: 'sop', root: prefix }
    }
    if (route === 'sop' && method === 'GET') return treePayload()
    // SOP 搜索只在 SOP 子目录内进行。通用板块不能借搜索入口读写其它 Obsidian 文件夹。
    if (route === 'sop/search' && method === 'GET') {
      const needle = q('q').trim().toLowerCase()
      if (needle === '') return { matches: [] }
      const payload = await treePayload()
      const visible = new Set()
      const walk = (nodes) => {
        for (const node of nodes) {
          if (node.type === 'note') visible.add(node.path)
          else walk(node.children)
        }
      }
      walk(payload.tree)
      const raw = await vault.search(q('q'), { limit: 400 })
      const matches = []
      for (const hit of raw) {
        if (prefixOf() !== '' && hit.path !== prefixOf() && !hit.path.startsWith(prefixOf() + '/')) continue
        matches.push({ ...hit, inTree: visible.has(hit.path) })
        if (matches.length >= 60) break
      }
      return { matches, total: matches.length, root: payload.root, global: false }
    }
    if (route === 'sop/refresh' && method === 'POST') {
      vault.invalidate()
      return treePayload()
    }
    // 笔记路径一律相对 vault 根（目录树给的就是这种路径）。
    // 配了 sopDir 时，老客户端可能还传相对该目录的路径，这里兜一层补上前缀。
    const notePathOf = (raw) => {
      const rel = String(raw ?? '').trim().replace(/\\/g, '/')
      if (rel === '') throw new VaultError('路径为空', 'bad_request')
      const prefix = prefixOf()
      if (prefix === '') return rel
      if (rel.startsWith(prefix + '/')) return rel
      if (!rel.includes('/')) return prefix + '/' + rel
      return prefix + '/' + rel
    }
    if (route === 'annotations' && method === 'GET') {
      const target = await resolveNotePath(q('path'))
      if (target === '' || !(await vault.exists(target))) return { annotations: [], path: target }
      const note = await vault.readNote(target)
      return { annotations: annotationsOf(note.text, target), path: target, sha1: note.sha1 }
    }
    if (route === 'sop/note' && method === 'GET') {
      const target = notePathOf(q('note'))
      const note = await vault.readNote(target)
      return { note: { ...note, sections: sectionsOf(note.text) } }
    }
    if (route === 'sop/note' && method === 'DELETE') {
      const target = notePathOf(q('note'))
      return { deleted: await vault.deleteNote(target, { expectedSha1: q('sha1') }) }
    }
    if (route === 'sop/note' && method === 'PUT') {
      if (typeof body?.text !== 'string') throw new VaultError('text 必填', 'bad_request')
      const target = notePathOf(q('note'))
      return { written: await vault.writeNote(target, body.text, { expectedSha1: body.expectedSha1 }) }
    }
    if (route === 'sop/note' && method === 'POST') {
      if (typeof body?.text !== 'string') throw new VaultError('text 必填', 'bad_request')
      const name = safeFileName(body.title ?? '') + '.md'
      // 子目录可以是「02 Work/01 工作 SOP」这种多级路径，也可以带 SOP/ 前缀
      // （界面上刚从目录树里点进来的路径就带前缀）。统一规范成相对 SOP/ 的段。
      const segsOf = (raw) => String(raw ?? '')
        .replace(/\\/g, '/')
        .split('/')
        .map((seg) => seg.trim())
        .filter((seg) => seg !== '' && seg !== '.')
      const locked = segsOf(prefixOf())
      const segs = segsOf(body.folder)
      const rel = (segs.length >= locked.length && locked.every((seg, index) => segs[index] === seg)
        ? segs.slice(locked.length)
        : segs)
      if (rel.some((seg) => seg === '..') || rel.some((seg) => /[:*?"<>|]/.test(seg))) {
        throw new VaultError('子目录名不合法：' + String(body.folder), 'bad_path')
      }
      const root = prefixOf()
      const folder = [root, ...rel].filter((seg) => seg !== '').join('/')
      return { created: await vault.createNote((folder === '' ? '' : folder + '/') + name, body.text) }
    }

    const simpleTables = {
      glossary: {
        table: () => tables.glossary,
        file: () => join(dirOf('workbenchDir'), '指标与黑话.md'),
        defaults: () => ({ zh: '', en: '', domain: '', tags: '', note: '' }),
      },
      ideas: {
        table: () => tables.ideas,
        file: () => join(dirOf('workbenchDir'), '灵感箱.md'),
        defaults: () => ({ date: today(), source: '', sourceUrl: '', content: '', status: '新', outcome: '' }),
      },
      feedback: {
        table: () => tables.feedback,
        file: () => join(dirOf('feedbackDir'), '客户反馈.md'),
        defaults: () => ({ date: today(), channel: '', source: '', sentiment: '', content: '', tags: '', advice: '', resolution: '', status: '未处理' }),
      },
    }
    if (Object.prototype.hasOwnProperty.call(simpleTables, route)) {
      const spec = simpleTables[route]
      const specPath = relToVault(spec.file())
      if (method === 'GET') {
        const state = await spec.table().read(spec.file())
        return { entries: state.entries, exists: state.exists, warning: state.warning, code: state.code, path: specPath, sha1: state.sha1 ?? '' }
      }
      const options = { expectedSha1: String(body?.expectedSha1 ?? (q('expectedSha1') || q('sha1'))).trim() }
      if (method === 'POST') return requireTable(await spec.table().add(spec.file(), { ...spec.defaults(), ...body }, options))
      if (method === 'PUT') return requireTable(await spec.table().update(spec.file(), String(body?.id ?? ''), body, options))
      if (method === 'DELETE') return requireTable(await spec.table().remove(spec.file(), q('id'), options))
    }

    // 同名笔记只有「类型相同」才复用；同名但类型不同（拆解 vs 选题）另建一篇。
    async function reusableTopic(title, wantType) {
      const base = safeFileName(String(title ?? '').trim())
      if (base === '') return { rel: '', title: '', existing: null }
      let candidate = base
      for (let index = 0; index < 20; index += 1) {
        const rel = dirNameOf('topics') + '/' + candidate + '.md'
        if (!(await vault.exists(rel))) return { rel: '', title: candidate, existing: null }
        const existing = await collections.topics.read(rel)
        if (String(existing?.front?.type ?? '') === wantType) return { rel, title: candidate, existing }
        candidate = base + '（' + wantType + (index === 0 ? '' : String(index + 1)) + '）'
      }
      throw new VaultError('同名笔记太多，建不了新的', 'conflict')
    }

    // 灵感 → 建选题：建一篇拆解笔记，然后把这行灵感标成「已用」并写上「去向」。
    // 两步的顺序是先建笔记再改表 —— 笔记建失败就整条失败，表不动（不会出现「灵感没了、笔记也没有」）。
    if (route === 'ideas/promote' && method === 'POST') {
      const id = String(body?.id ?? '')
      if (id === '') throw new VaultError('缺少灵感 id', 'bad_request')
      const file = join(dirOf('workbenchDir'), '灵感箱.md')
      const before = await tables.ideas.read(file)
      const row = (before.entries ?? []).find((entry) => entry.id === id)
      if (row === undefined) throw new VaultError('这条灵感已经不在灵感箱里了', 'not_found')
      const title = String(body?.title ?? row.content ?? '').trim()
      if (title === '') throw new VaultError('灵感没有内容，没法建选题', 'bad_request')
      const type = String(body?.type ?? '') === '选题' ? '选题' : '拆解'
      // 「收为拆解」必须选平台；「做选题」可以先不选，平台留「待定」后补。
      const requestedPlatform = String(body?.platform ?? '').trim()
      const platform = requestedPlatform === '' ? (type === '选题' ? '待定' : '') : normalizePlatform(requestedPlatform)
      if (platform === '') throw new VaultError('建拆解要先选平台', 'bad_request')
      const noteTitle = title.slice(0, 60)
      // 同名笔记只有类型相同才复用；同名但类型不同（拆解 vs 选题）另建一篇。
      const reusable = await reusableTopic(noteTitle, type)
      if (reusable.existing !== null) {
        const existing = reusable.existing
        const after = await tables.ideas.update(file, id, {
          ...row,
          status: '已用',
          outcome: reusable.rel,
        }, { expectedSha1: before.sha1 })
        return {
          created: { path: reusable.rel, sha1: existing.sha1, type: String(existing.front?.type ?? '') },
          updated: after?.ok !== false,
          existing: true,
        }
      }
      const created = await collections.topics.create({
        title: reusable.title,
        platform,
        date: today(),
        dir: String(body?.dir ?? ''),
        tags: String(body?.tags ?? row.source ?? ''),
        origin: String(row.content ?? ''),
        // 灵感箱里抓到的来源要跟着选题走，不能建完选题就断链。
        sourceUrl: String(body?.sourceUrl ?? row.sourceUrl ?? '').trim(),
        sourceTitle: String(body?.sourceTitle ?? row.content ?? '').trim(),
        status: '在写',
        // 灵感箱：收为拆解 = 拆解别人的案例；做选题 = 自己的选题。
        type,
      })
      const after = await tables.ideas.update(file, id, {
        ...row,
        status: '已用',
        outcome: created.path,
      }, { expectedSha1: before.sha1 })
      if (after?.ok === false) {
        // 笔记已经建好了，表没改成 —— 如实告诉前端，让它提示用户手动标一下。
        return { created, updated: false, warning: after.error ?? '灵感箱那行没改成' }
      }
      return { created, updated: true }
    }

    // 客户反馈 → 选题：反馈里的原话先进选题的来源，建好后把反馈标成跟进中。
    // 顺序和灵感箱一致：先建笔记，再改反馈表；建笔记失败时反馈一个字都不动。
    if (route === 'feedback/promote' && method === 'POST') {
      const id = String(body?.id ?? '').trim()
      if (id === '') throw new VaultError('缺少反馈 id', 'bad_request')
      const file = join(dirOf('feedbackDir'), '客户反馈.md')
      const before = await tables.feedback.read(file)
      const row = (before.entries ?? []).find((entry) => entry.id === id)
      if (row === undefined) throw new VaultError('这条反馈已经不在反馈库里了', 'not_found')
      const content = String(row.content ?? '').trim()
      if (content === '') throw new VaultError('这条反馈没有内容，没法转选题', 'bad_request')
      const requestedPlatform = String(body?.platform ?? '').trim()
      const sourceText = [row.source, row.channel].map((value) => String(value ?? '')).join(' ')
      const platform = requestedPlatform !== ''
        ? normalizePlatform(requestedPlatform)
        : (PLATFORMS.find((name) => sourceText.includes(name)) ?? '待定')
      const title = String(body?.title ?? content.split(/\r?\n/)[0]).trim().replace(/\s+/g, ' ').slice(0, 60)
      if (title === '') throw new VaultError('反馈没有可用的标题', 'bad_request')

      const appendNote = (value, note) => {
        const current = String(value ?? '').trim()
        if (current.includes(note)) return current
        return current === '' ? note : current + '；' + note
      }
      const updateFeedback = async (createdPath) => {
        const noteRef = '转选题：' + createdPath
        const nextStatus = ['跟进中', '已处理'].includes(String(body?.status ?? '').trim())
          ? String(body.status).trim()
          : (String(row.status ?? '').trim() === '已处理' ? '已处理' : '跟进中')
        const after = await tables.feedback.update(file, id, {
          ...row,
          status: nextStatus,
          advice: appendNote(row.advice, noteRef),
          resolution: appendNote(row.resolution, '已进入选题管线：' + createdPath),
        }, { expectedSha1: before.sha1 })
        return after
      }

      const reusable = await reusableTopic(title, '选题')
      if (reusable.existing !== null) {
        const after = await updateFeedback(reusable.rel)
        return {
          created: reusable.existing,
          existing: true,
          updated: after?.ok !== false,
          feedback: after?.entry ?? null,
          ...(after?.ok === false ? { warning: after.error ?? '反馈那行没改成' } : {}),
        }
      }
      const provenance = [
        content,
        String(row.channel ?? '').trim() === '' ? '' : '渠道：' + String(row.channel).trim(),
        String(row.source ?? '').trim() === '' ? '' : '来源：' + String(row.source).trim(),
      ].filter((part) => part !== '').join('；')
      const created = await collections.topics.create({
        title: reusable.title,
        platform: platform === '' ? '待定' : platform,
        date: today(),
        tags: String(row.tags ?? ''),
        origin: provenance.slice(0, 200),
        sourceUrl: /^https?:\/\//i.test(String(row.source ?? '').trim()) ? String(row.source).trim() : '',
        sourceTitle: ('客户反馈' + (String(row.channel ?? '').trim() === '' ? '' : ' · ' + String(row.channel).trim())).slice(0, 200),
        status: '在写',
        type: '选题',
      })
      const createdRecord = await collections.topics.read(created.path)
      const after = await updateFeedback(created.path)
      if (after?.ok === false) {
        return { created: createdRecord, updated: false, warning: after.error ?? '反馈那行没改成' }
      }
      return { created: createdRecord, updated: true, feedback: after?.entry ?? null }
    }

    if (route === 'calendar' && method === 'GET') {
      const cal = calendarTableFor(q('month'))
      const calPath = relToVault(cal.file)
      const state = await cal.table.read(cal.file)
      // 顺带把平台候选一起给前端：前端就不用自己扫全表去重，也就不会出现
      // 拼写不一致的同一个平台在下拉里分裂成两项。
      const known = []
      for (const entry of state.entries ?? []) known.push(entry.platform)
      await Promise.all((await calendarMonths()).map(async (month) => {
        if (month === cal.month) return
        const other = calendarTableFor(month)
        const otherState = await other.table.read(other.file)
        for (const entry of otherState.entries ?? []) known.push(entry.platform)
      }))
      return {
        month: cal.month,
        entries: normalizeCalendarEntries(state.entries),
        exists: state.exists,
        warning: state.warning,
        code: state.code,
        sha1: state.sha1,
        path: calPath,
        platforms: platformOptions(known),
      }
    }
    if (route === 'calendar' && method === 'POST') {
      const cal = calendarTableFor(body?.month)
      assertSinglePlatformCell(body?.platform)
      const row = await calendarRowWithTopicId(body)
      if (!['在写', '待发'].includes(String(row.status))) throw new VaultError('新建排期只能从「在写」或「待发」开始', 'bad_request')
      return { month: cal.month, ...(await requireTable(await cal.table.add(cal.file, row, { expectedSha1: body?.expectedSha1 }))) }
    }
    // 「分发到多个平台」：一次动作，N 个平台各建一版、各排一行。
    //
    // 落库形态是「一行一平台一版本」：日历一行只放一个平台，一个平台一个版本文件。
    // 「同一篇内容同步发多个平台」这件事由这个接口一次做完 —— 客户端不再自己拼 N 次请求
    // （拼 N 次的话中途失败就留下半截：一个平台建好了，另一个没建，用户根本看不出来）。
    // N 行用一次 addMany 写进去：一次锁、一次备份、一次原子写，要么全成要么全不成。
    if (route === 'calendar/fanout' && method === 'POST') {
      const cal = calendarTableFor(body?.month)
      const wanted = []
      for (const item of Array.isArray(body?.platforms) ? body.platforms : []) {
        for (const one of splitPlatforms(String(item ?? ''))) {
          if (!wanted.includes(one)) wanted.push(one)
        }
      }
      if (wanted.length === 0) throw new VaultError('至少要选一个平台', 'bad_request')
      const date = String(body?.date ?? '').trim()
      if (date === '') throw new VaultError('排期要填日期', 'bad_request')
      const masters = await collections.topics.all({ includeVariants: false })
      const master = masters.find((record) => String(record.id ?? '') === String(body?.topicId ?? '').trim())
        ?? masters.find((record) => String(record.path ?? '') === String(body?.topicPath ?? '').trim())
      if (master === undefined) throw new VaultError('找不到这条选题笔记：' + String(body?.topicPath ?? body?.topicId ?? ''), 'not_found')
      const status = normalizeVariantStatus(body?.status) || '待发'
      if (!['在写', '待发'].includes(status)) throw new VaultError('批量分发只能创建「在写」或「待发」排期', 'bad_request')
      const accounts = body?.accounts && typeof body.accounts === 'object' ? body.accounts : {}
      const accountIds = body?.accountIds && typeof body.accountIds === 'object' ? body.accountIds : {}
      const known = await domain.listVariants(master.id)
      const state = await cal.table.read(cal.file)
      const existingIds = new Set((state.entries ?? []).map((entry) => entry.id))
      const results = []
      const failed = []
      const rows = []
      for (const platform of wanted) {
        const account = String(accounts[platform] ?? '').trim()
        const accountId = String(accountIds[platform] ?? '').trim()
        // 同一平台同一账号的版本已经存在就复用：再建一份只会让回流台账分成两笔，
        // 榜单也并不到一起（同一个平台两个版本，数据对不上）。
        let variant = known.find((item) => normalizePlatform(String(item.front?.platform ?? '')) === platform
          && String(item.front?.accountId ?? '').trim() === accountId) ?? null
        let variantCreated = false
        if (variant === null) {
          try {
            variant = await domain.createVariant({ masterId: master.id, platform, account, accountId, status: '在写' })
            variantCreated = true
            known.push(variant)
          } catch (error) {
            failed.push({ platform, error: error?.message ?? String(error) })
            continue
          }
        }
        const row = {
          date,
          platform,
          topic: String(body?.topic ?? master.title ?? '').trim(),
          status,
          note: String(body?.note ?? ''),
          link: String(body?.link ?? ''),
          topicPath: String(master.path ?? ''),
          productPath: String(body?.productPath ?? ''),
          topicId: String(master.id ?? ''),
          variantId: String(variant.id ?? ''),
          account,
          gmv: String(body?.gmv ?? ''),
          conv: String(body?.conv ?? ''),
        }
        const rowId = cal.table.idOf(row)
        const rowExists = existingIds.has(rowId)
        if (!rowExists) rows.push(row)
        results.push({
          platform,
          variantId: String(variant.id ?? ''),
          rowId,
          variantCreated,
          rowCreated: !rowExists,
        })
      }
      if (rows.length > 0) {
        const written = await cal.table.addMany(cal.file, rows, { expectedSha1: body?.expectedSha1 })
        if (written.ok !== true) {
          // 一次都没写进去：版本已经建好的那些要说清楚，别让人以为全成了。
          for (const item of results) {
            if (item.rowCreated) failed.push({ platform: item.platform, error: written.error ?? '排期没能写入' })
          }
          throw new VaultError('批量分发只完成了一部分；已建立的平台版本会保留，请只重试失败项', 'conflict', {
            month: cal.month,
            partial: true,
            results: results.map((item) => ({ ...item, rowCreated: false })),
            failed,
          })
        }
      }
      if (failed.length > 0) {
        throw new VaultError('批量分发只完成了一部分；请查看失败项后重试', 'conflict', {
          month: cal.month, partial: true, results, failed,
        })
      }
      return { month: cal.month, results, failed: [] }
    }
    if (route === 'calendar' && method === 'PUT') {
      const cal = calendarTableFor(body?.month)
      const before = await cal.table.read(cal.file)
      const current = (before.entries ?? []).find((entry) => entry.id === String(body?.id ?? ''))
      if (current === undefined) throw new VaultError('日历里找不到这条：' + String(body?.id ?? ''), 'not_found')
      const next = await calendarRowWithTopicId({ ...current, ...body })
      // 一行只能一个平台。老行里已经有一格多平台的，允许改别的字段（别把人的数据锁死），
      // 但不许新写成多平台，也不许把别的行改成这样。
      assertSinglePlatformCell(next.platform, { allowSame: current.platform })
      // 从别的状态改成「已发」= 这条真的发出去了：平台版本必须跟着走到「已发」，
      // 否则日历记一本账、版本记另一本，谁都不知道哪本是准的。
      //
      // 顺序很重要：先 resolve（只读 + 门禁预检），推不动就整条拒绝 —— 日历一个字节都不写。
      // 以前是「先写日历、再推版本，推不动就当没事返回 200」：日历已经写成「已发」，
      // 版本还躺在草稿里，两本账从此对不上，而且没人知道哪儿错了。
      const wantsPublish = String(next.status) === '已发' && String(current.status) !== '已发'
      const planned = wantsPublish ? await resolveCalendarAdvance(next) : null
      if (planned !== null && planned.ok !== true && planned.blocking === true) {
        // 有矛盾：挂的版本不存在、平台对不上、同平台多个版本没指定推哪一版、门禁没过。
        throw new VaultError(planned.reason, planned.ambiguous === true ? 'conflict' : 'bad_request')
      }
      const result = { month: cal.month, ...(await requireTable(await cal.table.update(cal.file, current.id, next, { expectedSha1: body?.expectedSha1 }))) }
      if (planned !== null && planned.ok === true) {
        const applied = await applyCalendarAdvance(planned, { at: body?.publishedAt, reviewDays: body?.reviewDays, link: next.link })
        if (applied.ok !== true) {
          // 日历写成功了、版本没推上去（多半是推之前版本被别人在 Obsidian 里改了）：
          // 把日历这一行改回原样，不留「日历已发、版本没发」的裂缝。
          const rolled = await cal.table.update(cal.file, current.id, current, { expectedSha1: result.sha1 })
          if (rolled.ok !== true) {
            throw new VaultError('平台版本没能推进，日历这一行也回滚失败，请手动检查：' + applied.reason, 'conflict')
          }
          throw new VaultError('平台版本没能推进（日历已改回原样）：' + applied.reason, 'conflict')
        }
        result.advanced = applied
      } else if (planned !== null) {
        if (String(next.topicPath ?? '').trim() !== '' || String(next.topicId ?? '').trim() !== '') {
          const rolled = await cal.table.update(cal.file, current.id, current, { expectedSha1: result.sha1 })
          if (rolled.ok !== true) throw new VaultError('缺少平台版本，且日历回滚失败，请手动检查', 'conflict')
          throw new VaultError('内容排期必须关联平台版本后才能确认已发布：' + planned.reason, 'bad_request')
        }
        result.advanced = { ...planned, activityCompleted: true }
      }
      return result
    }
    // 待回填数据：只给「缺口」—— 日历里标了「已发」但同选题同平台还没有平台版本的行。
    // 有版本的行在上半段按平台版本录，这里再列一遍就是同一件事两个入口。
    if (route === 'pending' && method === 'GET') {
      const months = await calendarMonths()
      const { gaps } = await pendingGapsOf()
      // rows 是缺口列表，total 必须跟着 gaps 走；以前它数的是所有「已发」日历行，
      // 连已经有平台版本、不缺口的行也算进去，于是同一个响应里 total 和 rows 对不上。
      return { rows: gaps, months, total: gaps.length }
    }
    // 旧接口 POST /pending/writeback（把播放/赞写回选题 frontmatter）已删除。
    // 同一份数据有两个落点 —— 选题 frontmatter 和回流台账 —— 是「重复」的根源：
    // 榜单读台账、选题卡读 frontmatter，两边永远对不上。现在唯一写入口是
    // POST /v2/variants/:id/metrics，只写回流台账。
    if (route === 'calendar' && method === 'DELETE') {
      const cal = calendarTableFor(q('month'))
      return { month: cal.month, ...(await requireTable(await cal.table.remove(cal.file, q('id'), { expectedSha1: body?.expectedSha1 ?? (q('expectedSha1') || q('sha1')) }))) }
    }

    function validateCampaign(front, markdown = '') {
      const start = String(front?.start ?? '').trim()
      const end = String(front?.end ?? '').trim()
      if (start !== '' && end !== '' && end < start) throw new VaultError('结束日期不能早于开始日期', 'bad_field')
      if (String(front?.status ?? '').trim() !== '已结束') return
      const text = String(markdown ?? '')
      const metricsSection = text.split(/^###\s+效果对比\s*$/m)[1]?.split(/^###\s+/m)[0] ?? ''
      const metricRows = metricsSection.split('\n')
        .filter((line) => line.trim().startsWith('|'))
        .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
      const actualColumn = metricRows[0]?.findIndex((cell) => cell === '实际') ?? -1
      const hasActual = actualColumn >= 0 && metricRows.slice(2).some((cells) => {
        const value = String(cells[actualColumn] ?? '').trim()
        return value !== '' && value !== '-' && !/^:?-{3,}:?$/.test(value)
      })
      const review = text.split(/^###\s+经验\s*$/m)[1]?.split(/^#{1,3}\s+/m)[0] ?? ''
      const hasReview = review.split('\n').some((line) => line.trim() !== '' && !/^[-*]\s*$/.test(line.trim()))
      if (!hasActual && !hasReview) throw new VaultError('方案标为「已结束」前，至少填写一项实际效果或复盘经验', 'bad_request')
    }

    for (const kind of ['topics', 'campaigns', 'products', 'accounts', 'data']) {
      const collection = collections[kind]
      if (route === kind + '/list' && method === 'GET') {
        const filters = {}
        for (const [key, value] of url.searchParams) {
          if (['sort', 'desc', 'limit', 'offset', 'q'].includes(key) || key.startsWith('f_')) continue
          filters[key] = value
        }
        for (const [key, value] of url.searchParams) if (key.startsWith('f_') && key.length > 2) filters[key.slice(2)] = value
        const page = await collection.query({ filters, q: q('q'), sortField: q('sort') || collection.sort,
          desc: q('desc') !== 'false', ...pageBounds({ offset: q('offset'), limit: q('limit') }, 300) })
        const records = page.records
        // 选题列表附带排期信息：前端「排期」按钮好直接跳到已排的那一天。
        if (kind === 'topics') {
          const scheduleIndex = await topicsScheduleIndex()
          // 播放/赞/评/转只有台账一个源，挂在 record.metrics 上给前端读。
          // front.views 现在永远为空（旧回写接口已删），前端不要再读它。
          const latestMetric = await latestMetricByMaster()
          for (const record of records) {
            const hit = scheduleForTopic(record, scheduleIndex)
            if (hit !== undefined) record.schedule = hit
            record.stage = topicStageOf(record.front?.status, hit?.status)
            const metric = latestMetric.get(String(record.id ?? record.front?.id ?? ''))
            if (metric !== undefined) record.metrics = metric
          }
        }
        return { ...page, records, schema: collection.schema }
      }
      if (route === kind + '/create' && method === 'POST') {
        if (kind === 'campaigns') {
          if (String(body?.status ?? '').trim() === '已结束') throw new VaultError('新方案不能直接建成「已结束」；先记录执行结果，再在详情中结束', 'bad_request')
          validateCampaign(body)
        }
        return { created: await collection.create(body) }
      }
      if (route === kind + '/record' && method === 'GET') {
        const path = q('path') || (await collection.findById(q('id'))).path
        const record = await collection.read(path)
        if (kind === 'topics' && record?.path) {
          const scheduleIndex = await topicsScheduleIndex()
          const hit = scheduleForTopic(record, scheduleIndex)
          if (hit !== undefined) record.schedule = hit
          record.stage = topicStageOf(record.front?.status, hit?.status)
          const metric = (await latestMetricByMaster()).get(String(record.id ?? record.front?.id ?? ''))
          if (metric !== undefined) record.metrics = metric
        }
        return { record }
      }
      if (route === kind + '/record' && method === 'PUT') {
        if (kind === 'campaigns') {
          const current = await collection.read(q('path'))
          validateCampaign({ ...current.front, ...(body?.front ?? {}) }, body?.body === undefined ? current.body : body.body)
        }
        return { written: await collection.update(q('path'), body) }
      }
    }

    // 拆解 → 建选题：从一篇拆解笔记派生「自己的选题」进我的选题（2026-11-08 拆分）。
    // 拆解笔记只管「为什么火」，不进 选题→创作→回流 管线；选题才排期、才建平台版本。
    // 标题/平台/标签先照搬源笔记，正文留空（新建不铺模板），frontmatter 带 sourceId 指回源拆解。
    if (route === 'topics/derive' && method === 'POST') {
      const sourcePath = String(body?.source ?? '').trim()
      if (sourcePath === '') throw new VaultError('缺少 source（拆解笔记路径）', 'bad_request')
      const source = await collections.topics.read(sourcePath)
      if (source === null || source === undefined) throw new VaultError('拆解笔记不存在：' + sourcePath, 'not_found')
      // 源标题就是文件名（Topics/<标题>.md）；底层 vault.readNote 不带 title 字段，从路径取。
      const noteTitle = String(body?.title ?? '').trim() !== '' ? String(body.title).trim() : String(sourcePath).split('/').pop().replace(/\.md$/, '')
      // 同名笔记只有类型是「选题」才复用；同名拆解笔记不能顶替选题。
      const reusable = await reusableTopic(noteTitle, '选题')
      if (reusable.existing !== null) {
        return { created: reusable.existing, existing: true }
      }
      const created = await collections.topics.create({
        title: reusable.title,
        platform: String(body?.platform ?? '').trim() !== '' ? String(body.platform).trim() : String(source.front?.platform ?? ''),
        date: today(),
        tags: String(source.front?.tags ?? ''),
        // 原视频链接跟着选题走：写自己的稿子时还要回头参照原文。
        link: String(source.front?.sourceUrl ?? source.front?.link ?? ''),
        status: '在写',
        type: '选题',
        sourceId: String(source.front?.id ?? source.id ?? ''),
      })
      const record = await collections.topics.read(created.path)
      return { created: record }
    }

    if (route === 'data/import' && method === 'POST') {
      const raw = String(body?.csv ?? '')
      if (raw.trim() === '') throw new VaultError('csv 文本必填', 'bad_request')
      const rows = csv.parseCsv(raw)
      if (rows.length < 2) throw new VaultError('CSV 至少要有表头 + 一行数据', 'bad_request')
      const header = rows[0].map((value) => value.trim())
      // 猜列名时把中文标签一起给出去：平台导出的 CSV 表头是中文（「周期」「GMV」），
      // 只拿英文 key 去猜，一列都匹配不上 —— 导进来的表全是空的，还看不出是哪里错了。
      const fields = collections.data.schema.map((item) => ({ key: item.key, label: item.label }))
      const mapping = body?.mapping !== undefined && Object.keys(body.mapping).length > 0
        ? body.mapping
        : csv.guessMapping(header, fields)
      const records = csv.applyMapping(rows, mapping, { numericFields: ['gmv', 'traffic', 'conv', 'roi', 'mom'] })
      const archiveDir = join(dirOf('dataDir'), 'csv')
      const archive = join(archiveDir, 'import-' + today() + '-' + safeFileName(body?.name ?? 'data', 'data').replace(/\s+/g, '_') + '-' + randomBytes(8).toString('hex') + '.csv')
      await vault.assertInsidePath(archive)
      await mkdir(archiveDir, { recursive: true })
      // 归档保存提交的原文：不能用重复表头做 object key，再序列化丢掉列。
      await withFileWriteLock(archive, () => writeFile(archive, raw, { encoding: 'utf8', flag: 'wx' }))
      // 归档不是落库。以前这里把解析结果原样返回就结束了 —— 原文躺在 Data/csv/ 里，
      // 而「电商数据复盘」那张卡读的是 Data/ 下的周期复盘笔记，两边永远对不上，
      // 用户导完 CSV 看到「解析出 N 行」却发现卡上还是老数据，以为是自己看错了。
      // 现在逐行写进周期复盘：一条记录 = 一篇笔记（周期 + 平台各一条）。
      const archiveRef = relToVault(archive)
      const existing = await collections.data.all({ includeVariants: false })
      const byTitle = new Map(existing.map((record) => [String(record.title ?? ''), record]))
      const written = []
      const failed = []
      for (const row of records) {
        const period = String(row?.period ?? '').trim()
        if (period === '') {
          failed.push({ row, error: '没有周期（period）—— 这一行不知道该归到哪一期' })
          continue
        }
        const platform = String(row?.platform ?? '').trim()
        const title = safeFileName(platform === '' ? period : period + '-' + platform, 'period')
        const front = {
          period,
          platform,
          gmv: String(row?.gmv ?? ''),
          traffic: String(row?.traffic ?? ''),
          conv: String(row?.conv ?? ''),
          roi: String(row?.roi ?? ''),
          mom: String(row?.mom ?? ''),
          // 出处：这份数字是从哪个文件导出来的。口径：CSV 里有就照抄，没有就明说还没填。
          source: String(row?.source ?? '').trim() !== '' ? String(row.source).trim() : 'CSV 导入：' + archiveRef,
          caliber: String(row?.caliber ?? '').trim(),
        }
        try {
          const hit = byTitle.get(title)
          if (hit !== undefined) {
            const updated = await collections.data.update(hit.path, { front })
            written.push({ title, path: updated.path ?? hit.path, updated: true })
          } else {
            const created = await collections.data.create({ ...front, title })
            written.push({ title, path: created.path, updated: false })
          }
        } catch (error) {
          failed.push({ row, error: error?.message ?? String(error) })
        }
      }
      return {
        mapping,
        header,
        records,
        count: records.length,
        archive,
        written,
        failed,
      }
    }

    if (route === 'rules' && method === 'GET') {
      const state = await readRulesState()
      const parsed = rules.parseRules(state.text)
      // uriFor 只吃相对 vault 根的路径，这里换算过去，前端就能直接拿去打开。
      return { text: state.text, sha1: state.sha1, items: parsed.items, counts: rules.countsOf(parsed.items), nextId: rules.nextRuleId(parsed.items), nextIds: nextIdsOf(parsed.items), path: relToVault(rulesPath) }
    }

    if (route === 'rules' && method === 'PUT') {
      return withFileWriteLock(rulesPath, async () => {
        const current = await readRulesState()
        if (typeof body?.expectedSha1 === 'string' && body.expectedSha1 !== '' && body.expectedSha1 !== current.sha1) {
          throw new VaultError('规则文件在别处被改过（Obsidian 里？），刷新后再保存', 'conflict')
        }
        let nextText
        if (typeof body?.text === 'string' && body.text.trim() !== '') {
          nextText = body.text
        } else if (Array.isArray(body?.items)) {
          const parsed = rules.parseRules(current.text)
          const merged = parsed.items
            .map((item) => {
              const incoming = body.items.filter((entry) => entry?.id === item.id).pop()
              if (incoming === undefined) return item
              if (incoming.remove === true) return null
              return {
                ...item,
                section: incoming.section ?? item.section,
                title: incoming.title ?? item.title,
                fields: { ...item.fields, ...(incoming.fields ?? {}) },
              }
            })
            .filter((item) => item !== null)
          for (const incoming of body.items) {
            if (incoming?.remove === true) continue
            if (merged.some((item) => item.id === incoming?.id)) continue
            const normalized = rules.normalizeRule(incoming, { existingIds: merged.map((item) => item.id) })
            if (!normalized.ok) throw new VaultError(normalized.error, 'bad_field')
            merged.push(normalized.item)
          }
          nextText = rules.renderRules({ structure: parsed.structure, items: merged })
        } else {
          throw new VaultError('要么给 text，要么给 items', 'bad_request')
        }
        nextText = rules.refreshCounts(nextText, rules.parseRules(nextText).items)
        await vault.assertInsidePath(rulesPath + '.bak')
        try {
          await atomicWriteFile(rulesPath + '.bak', current.text)
        } catch (error) {
          throw new VaultError('备份失败，未写入：' + describe(error), 'backup_failed')
        }
        await atomicWriteFile(rulesPath, nextText, { beforeCommit: async () => {
          await vault.assertInsidePath(rulesPath)
          let latest
          try { latest = await readFile(rulesPath, 'utf8') } catch (error) {
            if (error?.code === 'ENOENT') throw new VaultError('规则文件已在别处删除，未写入', 'conflict')
            throw error
          }
          if (rules.sha1Of(latest) !== current.sha1) throw new VaultError('规则文件在保存前已被修改，未写入', 'conflict')
        } })
        const parsedNext = rules.parseRules(nextText)
        return {
          sha1: rules.sha1Of(nextText),
          items: parsedNext.items,
          counts: rules.countsOf(parsedNext.items),
          nextId: rules.nextRuleId(parsedNext.items),
          nextIds: nextIdsOf(parsedNext.items),
        }
      })
    }

    if (route === 'open-obsidian' && method === 'POST') {
      // 兼容绝对路径：前端偶尔拿到的是 <vaultRoot>/x.md，先换回相对路径，
      // 否则 uriFor 会把整条 F: 路径塞进 file 参数，Obsidian 当然找不到。
      const raw = await resolveNotePath(body?.path)
      if (raw === '') throw new VaultError('不确定要打开哪篇：路径为空', 'bad_request')
      if (!(await vault.exists(raw))) throw new VaultError('vault 里没有这篇：' + raw, 'not_found')
      const uri = await vault.uriFor(raw, { vaultName: body?.vault })
      await spawnOpen(uri, '唤起 Obsidian ')
      return { uri, path: raw }
    }
    if (route === 'delete-note' && method === 'POST') {
      // 每个板块都能删掉当前这一篇。和 /sop/note 的删除同一条路：先备份再删，
      // 冲突校验保留（库里被别人改过就拒绝，不覆盖手改的内容）。
      const raw = await resolveNotePath(body?.path)
      if (raw === '') throw new VaultError('不确定要删除哪篇：路径为空', 'bad_request')
      const latest = await vault.readNote(raw)
      const expected = String(body?.expectedSha1 ?? (q('expectedSha1') || q('sha1'))).trim()
      if (expected !== '' && expected !== latest.sha1) {
        throw new VaultError('这篇在别处被改过（Obsidian 里？），刷新后再删', 'conflict')
      }
      await vault.deleteNote(raw, { expectedSha1: latest.sha1 })
      vault.invalidate()
      return { deleted: raw }
    }
    if (route === 'open-vault' && method === 'POST') {
      await spawnOpen(vaultRoot(), '打开 vault 目录')
      return { opened: vaultRoot() }
    }
    if (route === 'open-url' && method === 'POST') {
      let target
      try {
        target = new URL(String(body?.url ?? ''))
      } catch {
        throw new VaultError('URL 不合法', 'bad_request')
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new VaultError('只支持 http(s)', 'bad_request')
      if (!OPEN_HOSTS.has(target.hostname)) throw new VaultError('域名不在白名单：' + target.hostname, 'bad_request')
      await spawnOpen(target.toString(), '打开链接')
      return { opened: target.toString() }
    }

    throw new VaultError('未知路径或方法：' + method + ' ' + API_PREFIX + '/' + route, 'not_found')
  }

  /**
   * 文件变化推送（Server-Sent Events）。
   *
   * 前端原来靠 1.5 秒轮询「这篇的 sha1 变了没有」，改完文件总有一小段延迟。
   * 这里用 fs.watch 递归盯住 vault：Obsidian 一存盘、agent 一写回，
   * 立刻把最新 sha1 推给正开着这篇的页面 —— 延迟只剩下一次文件写入。
   *
   * 只推 sha1，不推正文：页面收到之后自己走原来的 /topics/record 或 /v2/variants/:id，
   * 采纳/冲突的逻辑完全复用，推送这一层不碰内容。
   */
  const changeListeners = new Set()
  let vaultWatcher = null
  let vaultWatcherRoot = ''

  function ensureVaultWatcher() {
    const root = vaultRoot()
    if (root === '' || !existsSync(root)) return null
    if (vaultWatcher !== null && vaultWatcherRoot === root) return vaultWatcher
    if (vaultWatcher !== null) {
      try { vaultWatcher.close() } catch { /* 已经关了就算了 */ }
      vaultWatcher = null
    }
    vaultWatcherRoot = root
    try {
      vaultWatcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (filename === null || filename === undefined) return
        const rel = String(filename).split(sep).join('/')
        if (rel === '') return
        for (const entry of changeListeners) {
          if (entry.path !== rel) continue
          // 编辑器存盘常常是「写临时文件 + 改名」，一次保存会来好几条事件：合并一下。
          if (entry.timer !== null) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => { entry.timer = null; void entry.fire() }, 40)
        }
      })
      // 目录被删/盘符掉线时 watcher 会报错；关掉等下一次请求重建，别把进程带崩。
      vaultWatcher.on('error', () => {
        try { vaultWatcher.close() } catch { /* 同上 */ }
        vaultWatcher = null
        vaultWatcherRoot = ''
      })
    } catch {
      vaultWatcher = null
      vaultWatcherRoot = ''
    }
    return vaultWatcher
  }

  async function serveEvents(req, res, url) {
    const rel = String(url.searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.write(': connected\n\n')
    const entry = {
      path: rel,
      timer: null,
      fire: async () => {
        let sha1 = ''
        try {
          if (vault !== null && vault !== undefined) sha1 = String((await vault.readNote(rel)).sha1 ?? '')
        } catch {
          // 文件刚被删或改名：推空 sha1，前端下一轮会走自己的错误分支。
          sha1 = ''
        }
        try { res.write('data: ' + JSON.stringify({ sha1 }) + '\n\n') } catch { /* 连接已断 */ }
      },
    }
    if (rel !== '') {
      changeListeners.add(entry)
      ensureVaultWatcher()
    }
    // 心跳：中间有代理/休眠时，静默连接会被掐掉；25 秒一句注释就能保住。
    const beat = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* 连接已断 */ }
    }, 25000)
    // 心跳不该把进程钉住：连接活着时它照常发，进程要退出时它不拦着。
    if (typeof beat.unref === 'function') beat.unref()
    const done = () => {
      changeListeners.delete(entry)
      if (entry.timer !== null) clearTimeout(entry.timer)
      clearInterval(beat)
    }
    req.on('close', done)
    req.on('error', done)
    res.on('close', done)
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (!isLoopback(req)) {
      res.statusCode = 403
      res.end(JSON.stringify({ ok: false, code: 'forbidden', message: '只允许本机访问' }))
      return
    }
    const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
    // ── 门槛：所有路由都要凭证，只有 /token 自己例外 ──
    // sec-fetch-site 是浏览器自己加的、网页改不了：cross-site 一律拒（上面已处理）。
    // /token 只对「确认是跨站」的调用关死；桌面端的 fetch 不带这个头，它必须能领票，
    // 否则整页停在「缺少访问凭证」。领到的票只在本进程有效，跨站页面即使发出
    // 请求也读不到响应（没有 CORS 头，受同源策略限制）。
    const site = String(req.headers?.['sec-fetch-site'] ?? '')
    if (site === 'cross-site') {
      res.statusCode = 403
      res.end(JSON.stringify({ ok: false, code: 'forbidden', message: '不接受跨站请求' }))
      return
    }
    if (route === 'token' && String(req.method ?? 'GET').toUpperCase() === 'GET') {
      // 把调用方的来源指纹记下来：判断「桌面端到底发了什么头」靠这条日志，
      // 别再拿 curl 的 header 去猜浏览器。
      try {
        rotateAppend(join(dataDir(), 'token-probe.log'), `${new Date().toISOString()} ${JSON.stringify({
          site,
          origin: String(req.headers?.origin ?? ''),
          referer: String(req.headers?.referer ?? ''),
          ua: String(req.headers?.['user-agent'] ?? '').slice(0, 120),
        })}\n`, 256 * 1024)
      } catch { /* 日志失败不影响领票 */ }
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, token: AUTH_TOKEN }))
      return
    }
    // 事件流：EventSource 带不了头，用一次性 ticket 换连接（token 不进 URL）。
    if (route === 'v2/events') {
      if (!consumeEventTicket(String(url.searchParams.get('ticket') ?? ''))) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, code: 'unauthorized', message: '实时通道的票无效、已用或过期，刷新一下工作台页面' }))
        return
      }
      await serveEvents(req, res, url)
      return
    }
    if (String(req.headers?.['x-dsh-growth-token'] ?? '') !== AUTH_TOKEN) {
      res.statusCode = 401
      res.end(JSON.stringify({ ok: false, code: 'unauthorized', message: '缺少访问凭证，刷新一下工作台页面' }))
      return
    }
    if (route === 'events-ticket') {
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, ticket: issueEventTicket(), ttlMs: EVENT_TICKET_TTL_MS }))
      return
    }
    try {
      const payload = await handle(req, route, url)
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, ...payload }))
    } catch (error) {
      const code = error?.code !== undefined && STATUS_BY_CODE.has(error.code) ? error.code : 'internal'
      res.statusCode = STATUS_BY_CODE.get(code) ?? 500
      // extra 里装的是「为什么失败」的具体证据（冲突时的 latest 内容与 sha1），
      // 不带给前端，前端就只能干瞪眼看着一句报错，没法让人选「用我的还是用他的」。
      const extra = error?.extra !== null && typeof error?.extra === 'object' ? error.extra : {}
      res.end(JSON.stringify({ ok: false, code, message: describe(error), ...extra }))
      if (code === 'internal') logger.error('growth-workbench ' + route + ': ' + describe(error))
    }
  }

  ctx.effect(() => {
    // 本机脚本要能带着凭证调接口：把进程级 token 落到 <dataDir>/session-token。
    // 0600：只有当前用户可读；页面仍然走 /token 领，不读这个文件。
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(join(dataDir(), 'session-token'), AUTH_TOKEN + '\n', { mode: 0o600 })
    } catch { /* 落盘失败只影响命令行脚本，页面照旧能领票 */ }
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return () => {
      if (typeof dispose === 'function') dispose()
      for (const entry of changeListeners) if (entry.timer !== null) clearTimeout(entry.timer)
      changeListeners.clear()
      if (vaultWatcher !== null) {
        try { vaultWatcher.close() } catch { /* 已经关了就算了 */ }
        vaultWatcher = null
        vaultWatcherRoot = ''
      }
    }
  })

  /**
   * 对话侧工具 growth_vault：让 agent 真的能把结果写回 vault。
   *
   * 只靠提示词里那句「改完请写回」太软 —— agent 完全可以装作写完了，
   * 而用户只在工作台里看到一篇没变化的笔记。有了工具，写回才是可执行的契约：
   * 它会拿到 sha1、被冲突拒绝、也会在成功时返回真实路径。
   *
   * 宿主没装 tools 服务时 ctx.inject 不会激活，插件其余部分不受影响。
   */
  ctx.effect(() => registerVaultTool(ctx, {
    vaultRoot: () => vaultRoot(),
    dirs: {
      topics: cfg('topicsDir'),
      campaigns: cfg('campaignsDir'),
      products: cfg('productsDir'),
      data: cfg('dataDir'),
      feedback: cfg('feedbackDir'),
      copyrules: cfg('copyRulesDir'),
    },
    boards: async () => {
      const out = []
      for (const [id, dirKey] of [['topics', 'topicsDir'], ['campaigns', 'campaignsDir'], ['products', 'productsDir'], ['data', 'dataDir']]) {
        let count = 0
        try {
          count = (await collections[id].all({ includeVariants: false })).length
        } catch {
          count = 0
        }
        out.push({ id, folder: cfg(dirKey), noteCount: count, fields: collections[id].schema.map((item) => item.key) })
      }
      out.push({ id: 'sop', folder: sopDirValue(), noteCount: null, fields: [] })
      return out
    },
    listRecords: async (board, limit, options) => {
      if (collections[board] === undefined) throw new VaultError('没有这个板块：' + board, 'bad_request')
      if (options !== undefined && options.create === true) {
        const created = await collections[board].create({
          ...(options.front ?? {}),
          title: options.title,
          ...(options.directory === undefined ? {} : { dir: options.directory }),
        })
        vault.invalidate()
        return { path: created.path, sha1: created.sha1 ?? '' }
      }
      const records = await collections[board].list({ limit: Math.min(Math.max(limit, 1), 200) })
      return records.map((record) => ({
        path: record.path,
        title: record.title,
        sha1: record.sha1,
        front: record.front,
        preview: record.preview,
      }))
    },
    listSop: async (limit, options) => {
      if (options !== undefined && options.create === true) {
        // 目录树节点给的是 name 不是 title；子目录可以是多级的，逐段消毒。
        const title = String(options.title ?? '').trim()
        if (title === '') throw new VaultError('新建 SOP 需要标题', 'bad_request')
        const sub = String(options.directory ?? '')
          .replace(/[\\/]+/g, '/')
          .split('/')
          .map((seg) => safeFileName(seg.trim(), ''))
          .filter((seg) => seg !== '')
          .join('/')
        const head = sopDirValue() + '/'
        const rel = head + (sub === '' ? '' : sub + '/') + safeFileName(title) + '.md'
        const text = typeof options.markdown === 'string' && options.markdown.trim() !== ''
          ? options.markdown
          : '# ' + title + '\n\n'
        const created = await vault.createNote(rel, text)
        vault.invalidate()
        return { path: rel, sha1: created.sha1 ?? '' }
      }
      const roots = await vault.tree({ scope: 'sop' })
      const flat = []
      const walk = (nodes) => {
        for (const node of nodes ?? []) {
          if (node.type === 'note') flat.push({ path: node.path, title: node.name, preview: node.preview })
          else walk(node.children)
        }
      }
      walk(roots)
      return flat.slice(0, limit < 0 ? 200 : limit)
    },
    readNote: async (path) => {
      const resolved = await resolveNotePath(path)
      if (resolved === '') throw new VaultError('不确定要读写哪篇：路径为空', 'bad_path')
      const note = await vault.readNote(resolved)
      const parsed = fm.splitNote(note.text)
      return { ...note, path: resolved, front: parsed.front, body: parsed.body }
    },
    ensureNote: async (path, patch) => {
      const resolved = await resolveNotePath(path)
      if (resolved === '') throw new VaultError('不确定要写哪篇：路径为空', 'bad_path')
      const note = await vault.readNote(resolved)
      const parsed = fm.splitNote(note.text)
      const nextFront = patch.front ?? {}
      const nextBody = patch.body === undefined ? parsed.body : String(patch.body)
      const text = patch.text === undefined ? fm.buildNote(nextFront, nextBody, note.text) : String(patch.text)
      const written = await vault.writeNote(resolved, text, { expectedSha1: patch.expectedSha1 || note.sha1 })
      vault.invalidate()
      return { path: resolved, sha1: written.sha1 ?? '', mtimeMs: written.mtimeMs ?? 0 }
    },
    updateRecord: async (board, path, patch) => {
      const resolved = await resolveNotePath(path)
      const written = await collections[board].update(resolved, patch)
      vault.invalidate()
      return { path: resolved, sha1: written.sha1 ?? '', mtimeMs: written.mtimeMs ?? 0 }
    },
  }, logger))

  loadState()
    .then(async () => {
      build()
      await ensureSeeds()
    })
    .catch((error) => logger.error('growth-workbench init: ' + describe(error)))
}
