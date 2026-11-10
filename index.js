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
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createTable, TableValidationError } from './lib/table.js'
import { createVaultStore, VaultError, sectionsOf } from './lib/vault.js'
import * as rules from './lib/rules.js'
import * as fm from './lib/frontmatter.js'
import * as csv from './lib/csv.js'
import { registerVaultTool } from './lib/agent-tool.js'
import { normalizePlatform, platformOptions } from './lib/platforms.js'
import { createDomainStore, VARIANT_STATUSES, VARIANT_TRANSITIONS } from './lib/domain.js'
import { createMigrator } from './lib/migrate.js'

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

const DEFAULT_CARDS = [
  { id: 'accounts', workspace: 'ops', title: '账号档案', icon: '👤', enabled: true },
  { id: 'ideas', workspace: 'ops', title: '灵感箱', icon: '💡', enabled: true },
  { id: 'topics', workspace: 'ops', title: '爆款拆解（别人的）', icon: '🎯', enabled: true },
  { id: 'studio', workspace: 'ops', title: '我的选题', icon: '🎬', enabled: true },
  { id: 'calendar', workspace: 'ops', title: '内容日历', icon: '🗓️', enabled: true },
  { id: 'pending', workspace: 'ops', title: '待回填数据', icon: '📥', enabled: true },
  { id: 'contentdata', workspace: 'ops', title: '数据复盘', icon: '📊', enabled: true },
  { id: 'products', workspace: 'ecom', title: '商品 / 竞品库', icon: '🏷️', enabled: true },
  { id: 'data', workspace: 'ecom', title: '电商数据复盘', icon: '📈', enabled: true },
  { id: 'feedback', workspace: 'ecom', title: '客户反馈库', icon: '💬', enabled: true },
  { id: 'campaigns', workspace: 'mkt', title: '营销方案库', icon: '📣', enabled: true },
  { id: 'sop', workspace: 'common', title: 'SOP 树', icon: '📚', enabled: true },
  { id: 'glossary', workspace: 'common', title: '术语表', icon: '🔤', enabled: true },
  { id: 'copyrules', workspace: 'common', title: '文案规则 / 语调库', icon: '✍️', enabled: true },
]

const STATUS_BY_CODE = new Map([
  ['bad_request', 400], ['bad_path', 400], ['bad_json', 400], ['bad_field', 400],
  ['bad_frontmatter', 400], ['invalid_table', 400], ['duplicate', 409], ['conflict', 409],
  ['exists', 409], ['not_found', 404], ['read_failed', 500], ['write_failed', 500],
  ['backup_failed', 500], ['list_failed', 500], ['stat_failed', 500],
])

const OPEN_HOSTS = new Set([
  'obsidian.md', 'github.com', 'bilibili.com', 'www.bilibili.com', 'xiaohongshu.com',
  'www.xiaohongshu.com', 'douyin.com', 'www.douyin.com', 'weibo.com', 'www.weibo.com',
  'mp.weixin.qq.com', 'taobao.com', 'www.taobao.com', 'tmall.com', 'www.tmall.com',
  'jd.com', 'www.jd.com', 'pinduoduo.com', 'www.pinduoduo.com', 'yangkeduo.com',
])

const DEFAULT_DIRS = {
  vaultRoot: '',
  sopDir: '',
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
  await mkdir(join(file, '..'), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
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
 * 现在：浏览器请求必须带这个进程级 token（先从 /token 领，跨站拿不到），
 * 跨站请求直接 403；没有 sec-fetch 头的本机命令行/脚本照旧放行。
 */
const AUTH_TOKEN = randomBytes(24).toString('hex')

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
  const trace = (line) => {
    try {
      appendFileSync(join(traceDir, 'startup.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      // 记不住就算了，绝不能因为日志把插件搞挂。
    }
  }
  try {
    mkdirSync(traceDir, { recursive: true })
  } catch {}
  trace(`apply start; hasCtx=${ctx !== void 0}; configKeys=${Object.keys(config ?? {}).length}`)

  let userConfig = {}
  let cards = DEFAULT_CARDS.map((card) => ({ ...card }))
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

  // SOP 目录默认跟随 vault 根目录：用户没单独指定时，vault 里有 SOP/ 子目录
  // 就用 SOP/，没有就退回整个 vault。这样换 vault 根目录时 SOP 树自动跟过去，
  // 用户不需要再维护第二个路径。
  function sopDirValue() {
    const configured = String(cfg('sopDir') ?? '').trim()
    if (configured !== '') return configured
    try {
      if (vaultRoot() !== '' && existsSync(join(vaultRoot(), 'SOP'))) return 'SOP'
    } catch {
      // 路径不可读就当作没有 SOP/，退回整个 vault。
    }
    return ''
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
    return join(vaultRoot(), cfg(key))
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

  async function loadState() {
    try {
      userConfig = JSON.parse(await readFile(join(dataDir(), 'config.json'), 'utf8'))
    } catch {
      userConfig = {}
    }
    try {
      const parsed = JSON.parse(await readFile(join(dataDir(), 'cards.json'), 'utf8'))
      if (Array.isArray(parsed)) {
        const byId = new Map(cards.map((card) => [card.id, card]))
        for (const entry of parsed) {
          const existing = byId.get(String(entry?.id ?? ''))
          if (existing !== undefined) existing.enabled = entry.enabled !== false
        }
      }
    } catch {
      // 没有自定义就用默认。
    }
  }

  async function saveUserConfig() {
    await mkdir(dataDir(), { recursive: true })
    await atomicWrite(join(dataDir(), 'config.json'), JSON.stringify(userConfig, null, 2) + '\n')
  }

  async function saveCards() {
    await mkdir(dataDir(), { recursive: true })
    const minimal = cards.map((card) => ({ id: card.id, enabled: card.enabled !== false }))
    await atomicWrite(join(dataDir(), 'cards.json'), JSON.stringify(minimal, null, 2) + '\n')
  }

  function dirNameOf(kind) {
    if (kind === 'topics') return cfg('topicsDir')
    if (kind === 'campaigns') return cfg('campaignsDir')
    if (kind === 'products') return cfg('productsDir')
    if (kind === 'accounts') return cfg('accountsDir')
    return cfg('dataDir')
  }

  // discover() 有 3 秒缓存：某个目录还没出现在缓存里时（刚建的、刚写的新文件），
  // 立刻失效重扫一次，否则「建完立刻列表」会看见空目录。
  async function listNotesUnder(dir) {
    let { notes } = await vault.discover()
    const known = notes.some((note) => note.path.startsWith(dir + '/'))
    if (!known) {
      vault.invalidate()
      notes = (await vault.discover()).notes
    }
    return notes
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
    return {
      kind,
      schema,
      sort,
      template,
      dirName: () => dirNameOf(kind),
      async list({ filters = {}, sortField = sort, desc = true, limit = 200 } = {}) {
        const dir = dirNameOf(kind)
        const notes = await listNotesUnder(dir)
        const paths = [...new Set(notes.map((note) => note.path).filter((path) => path.startsWith(dir + '/')))]
        // 脚本进度现在看平台版本里的「## 版本脚本」。一次把版本全读出来按
        // masterId 分组，免得每篇选题各扫一遍版本目录。
        const variantsByMaster = new Map()
        if (kind === 'topics') {
          for (const variant of await domain.listVariants('')) {
            const key = String(variant.front?.masterId ?? '')
            if (!variantsByMaster.has(key)) variantsByMaster.set(key, [])
            variantsByMaster.get(key).push(variant)
          }
        }
        const records = []
        for (const path of paths) {
          let note
          try {
            note = await vault.readNote(path)
          } catch {
            continue
          }
          const parsed = fm.splitNote(note.text)
          const id = kind === 'topics' ? topicIdOf(parsed.front, path) : ''
          records.push({
            path,
            title: note.title,
            mtimeMs: note.mtimeMs,
            sha1: note.sha1,
            front: parsed.front,
            ...(kind === 'topics' ? { id } : {}),
            // 列表里带上正文：我的选题点「创作」换一条时，详情页拿它当首屏，
            // 不用等 /topics/record 回来才画，换笔记就不会闪一下白。
            // 选题正文很小（几百字），200 篇也就几百 KB，只在 topics 这一种集合上带。
            ...(kind === 'topics' ? { body: parsed.body } : {}),
            // 我的选题要按脚本进度显示；版本那边已经读过了，选题这里顺手算掉，
            // 前端就不用再逐篇拉 record。其它集合不背这个字段。
            ...(kind === 'topics' ? { script: scriptProgressWith(variantsByMaster.get(id) ?? [], parsed.body) } : {}),
            preview: parsed.body
              .split('\n')
              .filter((line) => line.trim() !== '' && !line.startsWith('#'))
              .join(' ')
              .slice(0, 140),
          })
        }
        return fm.sortRecords(fm.filterRecords(records, filters), sortField, desc).slice(0, limit)
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
        return { ...note, front: parsed.front, body: parsed.body, ...(kind === 'topics' ? { id: topicIdOf(parsed.front, path) } : {}) }
      },
      async update(path, { front: frontInput, body, expectedSha1 }) {
        const note = await vault.readNote(path)
        const parsed = fm.splitNote(note.text)
        // 只改正文时前端可能传 {}（例如「回流台账」这种没有 frontmatter 的自由笔记）。
        // 空对象不能当成“清空全部字段”去做 schema 校验，否则必填项会误报。
        const frontTouched = frontInput !== undefined
          && !(frontInput !== null && typeof frontInput === 'object' && Object.keys(frontInput).length === 0)
        const nextFront = frontTouched
          ? fm.normalizeFront(schema, { ...parsed.front, ...frontInput })
          : parsed.front
        if (autoId && String(nextFront.id ?? '').trim() === '') nextFront.id = newTopicId()
        const nextBody = body === undefined ? parsed.body : String(body)
        return vault.writeNote(path, fm.buildNote(nextFront, nextBody, note.text), { expectedSha1 })
      },
    }
  }

  function build() {
    if (vaultRoot() === '') {
      vault = null
      return
    }
    vault = createVaultStore({
      vaultRoot: vaultRoot(),
      sopDir: sopDirValue(),
      backupDir: join(vaultRoot(), cfg('workbenchDir'), '.backups'),
    })

    tables.glossary = createTable({
      header: ['中文', '英文', '领域', '标签', '备注'],
      keys: ['zh', 'en', 'domain', 'tags', 'note'],
      idKeys: ['zh', 'en'],
      heading: '# 指标与黑话',
      intro: '> 运营 / 电商 / 营销常用指标与黑话，一张表。',
      label: '术语',
    })
    tables.ideas = createTable({
      header: ['日期', '来源', '来源URL', '内容', '状态', '去向'],
      keys: ['date', 'source', 'sourceUrl', 'content', 'status', 'outcome'],
      // 老表有两种：4 列（没有「去向」）和 5 列（没有「来源URL」）。补列发生在算 id 之前，
      // 所以老行的 id 不会变，不会出现「升级一次全变新行」。
      legacy: [
        { cells: 5, at: [{ index: 2 }] },
        { cells: 4, at: [{ index: 2 }, { index: 4 }] },
      ],
      idKeys: ['date', 'content'],
      heading: '# 灵感箱',
      intro: '> 想到就丢一行，定期清进选题库。状态：新 / 已用 / 已废弃；已用的填「去向」，写上它变成了哪篇选题。来源URL 可直接在面板里预览。',
      label: '灵感',
    })
    // 老反馈表有两种：8 列（还没有「来源」）和 6 列（还没有处理意见/处理结果）。
    // 读到老行时按列数把缺的列补成空，idKeys 仍是日期+内容，老行 id 不变。
    tables.feedback = createTable({
      header: ['日期', '渠道', '来源', '情感', '内容', '标签', '处理意见', '处理结果', '状态'],
      keys: ['date', 'channel', 'source', 'sentiment', 'content', 'tags', 'advice', 'resolution', 'status'],
      idKeys: ['date', 'content'],
      legacy: [{ cells: 8, at: [{ index: 2 }] }, { cells: 6, at: [{ index: 2 }, { index: 5 }, { index: 5 }] }],
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
        : '## 选题卡\n\n- 目标人群：' + String(front?.audience ?? '') + '\n- 内容目标：' + String(front?.goal ?? '') + '\n- 一句话角度：' + String(front?.angle ?? '') + '\n',
    })

    domain = createDomainStore({
      vault,
      workbenchDir: String(cfg('workbenchDir')).replace(/\\/g, '/'),
      topics: collections.topics,
      dataDir: dirOf('dataDir'),
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
        { key: 'name', label: '账号名', required: true, max: 100 },
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
      // sopDir 为空 = vault 根目录本身，搜索前缀要保留空串。
      if (key === 'sopDir' && value.trim() === '') {
        seen.add('')
        continue
      }
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
    const records = await collections.topics.list({ limit: 5000 })
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
    if (domain === null) return { variants: [], gaps: [], total: 0 }
    const masters = (await collections.topics.list({ limit: 1000 }))
      .filter((record) => !String(record.path ?? '').startsWith('Topics/测试/'))
    const masterIdOf = (master) => String(master.id ?? master.front?.id ?? '')
    const masterById = new Map(masters.map((master) => [masterIdOf(master), master]))
    const allVariants = await domain.listVariants()
    const published = allVariants.filter((variant) => ['已发', '待回填'].includes(String(variant.status))
      && masterById.has(String(variant.front?.masterId ?? '')))
    // 覆盖判断按「选题 + 平台」这一对，而且要看全部版本（含已归档）：
    // 一个已经归档的版本说明这条内容早有归宿，不该再被当成「还没有平台版本」催一遍。
    const covered = new Set()
    for (const variant of allVariants) {
      // 只有「真的发出去过」的版本才算覆盖：已发 / 数据回流，或归档前发过的。
      // 以前草稿、待审也一并算上 —— 日历标了已发、版本还躺在草稿里，缺口被静默吞掉，
      // 待回填数据上半段只收已发/数据回流，于是两边都不显示，这条内容凭空消失。
      const status = String(variant.status ?? '')
      const countsAsPublished = ['已发', '待回填'].includes(status)
        || (status === '已归档' && String(variant.front?.publishedAt ?? '').trim() !== '')
      if (!countsAsPublished) continue
      const master = masterById.get(String(variant.front?.masterId ?? ''))
      if (master === undefined) continue
      covered.add(String(master.path ?? '') + '|' + normalizePlatform(String(variant.front?.platform ?? '')))
    }
    const gaps = []
    let total = 0
    for (const month of await calendarMonths()) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      for (const entry of state.entries) {
        if (String(entry.status) !== '已发') continue
        total += 1
        const topicPath = String(entry.topicPath ?? '').trim()
        // 纯商品行（挂了商品档案、没挂选题）本来就不需要平台版本，不算缺口。
        if (String(entry.productPath ?? '').trim() !== '' && topicPath === '') continue
        if (covered.has(topicPath + '|' + normalizePlatform(String(entry.platform ?? '')))) continue
        gaps.push({ ...entry, month, normalizedPlatform: normalizePlatform(entry.platform) })
      }
    }
    gaps.sort((left, right) => String(right.date).localeCompare(String(left.date)))
    return { variants: published, gaps, total }
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
  // 推不动（比如风险等级「禁发」）不阻断日历，只把原因带回去让前端说一句。
  async function advanceVariantForCalendar(entry) {
    if (domain === null) return { ok: false, reason: '还没连接 vault' }
    const topicPath = String(entry.topicPath ?? '').trim()
    if (topicPath === '') return { ok: false, reason: '这条没挂选题笔记' }
    const masters = await collections.topics.list({ limit: 1000 })
    const master = masters.find((record) => String(record.path ?? '') === topicPath)
    if (master === undefined) return { ok: false, reason: '找不到选题笔记：' + topicPath }
    const platform = normalizePlatform(String(entry.platform ?? ''))
    const variants = await domain.listVariants(master.id)
    // 日历这一行如果挂了版本ID，就是它 —— 同平台多个版本时不再需要猜。
    const wantedVariantId = String(entry.variantId ?? '').trim()
    let variant = null
    if (wantedVariantId !== '') {
      variant = variants.find((item) => String(item.id) === wantedVariantId) ?? null
      if (variant === null) return { ok: false, reason: '日历挂的平台版本不存在了：' + wantedVariantId }
      if (normalizePlatform(String(variant.front?.platform ?? '')) !== platform) {
        return { ok: false, reason: '日历的平台「' + platform + '」与这一版不一致，可能刚被改过' }
      }
    } else {
      const samePlatform = variants.filter((item) => normalizePlatform(String(item.front?.platform ?? '')) === platform)
      if (samePlatform.length === 0) return { ok: false, reason: '这条选题在「' + platform + '」还没有平台版本' }
      // 老行没有版本ID。同一个平台挂着好几个版本（主号 / 测试号 / 矩阵号）时分不清该推哪一个：
      // 以前这里取第一个，结果「把测试号推成已发、真正排期的那版没动」还报成功 ——
      // 宁可如实说推不了，让人自己在日历行上选一个版本。
      if (samePlatform.length > 1) {
        return {
          ok: false,
          ambiguous: true,
          reason: '这条选题在「' + platform + '」有 ' + samePlatform.length + ' 个版本，日历这行还没指定版本，请选一个再标已发',
        }
      }
      variant = samePlatform[0]
    }
    const steps = transitionPathOf(variant.status, '已发')
    if (steps === null) return { ok: false, reason: '「' + variant.status + '」走不到「已发」' }
    if (steps.length === 0) return { ok: true, status: variant.status, steps: [] }
    let current = variant
    try {
      for (const step of steps) current = await domain.transitionVariant(current.path, step, { actor: 'calendar' })
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error), steps }
    }
    return { ok: true, status: current.status, steps }
  }

  // 概览卡片上那个数字：跨月还在等回流的条数。
  // 和「待回填数据」卡完全同一个口径：已发布（已发/数据回流）的平台版本 + 日历里的缺口。
  // 以前这里只数日历「已发」，而卡片上还有 v2 那一段，首页数字永远偏小 ——
  // 同一个概念两套算法，就是「重复」最典型的形态。
  async function pendingCountOf() {
    const { variants, gaps } = await pendingGapsOf()
    return variants.length + gaps.length
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
      const bucket = byProduct.get(key) ?? { key, productPath: String(row.productPath ?? ''), items: [], gmv: 0, views: 0 }
      const note = String(row.note ?? '')
      const pick = (label) => {
        const hit = new RegExp('(?:' + label + ')' + '\\s*[:：=]?\\s*([0-9.]+)\\s*(万|w)?', 'i').exec(note)
        if (hit === null) return 0
        const scale = hit[2] === undefined ? 1 : 10000
        return toNumber(hit[1]) * scale
      }
      const gmv = pick('GMV')
      const views = pick('播放|vues|views|观看')
      bucket.items.push({ month: row.month, id: row.id, date: row.date, platform: row.platform, topic: row.topic, status: row.status, topicPath: row.topicPath, note: row.note, gmv, views })
      bucket.gmv += gmv
      bucket.views += views
      byProduct.set(key, bucket)
    }
    const products = [...byProduct.values()].sort((a, b) => b.gmv - a.gmv)
    return { products, linkedCount: live.length, months: months.length }
  }

  // 每个主选题的最新一条回流数据（masterId → metric）。
  // 播放/赞/评/转只有台账这一个来源：旧接口把同样的数字再写进选题 frontmatter，
  // 两处一旦不一致就永远对不上（榜单读台账、选题卡读 frontmatter），接口已删。
  async function latestMetricByMaster() {
    if (domain === null) return new Map()
    const metrics = await domain.listMetrics()
    const latest = new Map()
    for (const metric of metrics) {
      const masterId = String(metric.masterId ?? '')
      if (masterId !== '' && !latest.has(masterId)) latest.set(masterId, metric)
    }
    return latest
  }

  // 选题榜：内容线按播放排，带货线按 ROI。播放/赞/评/转全部来自回流台账。
  async function topicBoards() {
    requireVault()
    const topics = await collections.topics.list({ limit: 500 })
    // 平台版本台账里有更细的互动数据：按主选题取最新一条，补足评论/转发维度。
    const latestMetric = await latestMetricByMaster()
    const scored = topics.map((record) => {
      const front = record.front ?? {}
      const metric = latestMetric.get(String(record.id ?? front.id ?? '')) ?? {}
      const views = toNumber(front.views) || toNumber(metric.views)
      const likes = toNumber(front.likes) || toNumber(metric.likes)
      const comments = toNumber(metric.comments)
      const shares = toNumber(metric.shares)
      return {
        path: record.path,
        title: String(record.title ?? ''),
        platform: normalizePlatform(front.platform),
        status: String(front.status ?? ''),
        views,
        likes,
        comments,
        shares,
        // 没回流数据的拆解不能留在榜单里赛跑，单独列出来提醒去回填。
        measured: views > 0 || likes > 0 || comments > 0 || shares > 0,
      }
    })
    const content = scored.filter((item) => item.measured).sort((a, b) => b.views - a.views || b.likes - a.likes)
    const unmeasured = scored.filter((item) => !item.measured)
    const data = await collections.data.list({ limit: 500 })
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
      table: createTable({
        header: ['日期', '平台', '主题', '状态', '备注', '链接', '选题笔记', '商品档案', '选题ID', '版本ID', '账号'],
        keys: ['date', 'platform', 'topic', 'status', 'note', 'link', 'topicPath', 'productPath', 'topicId', 'variantId', 'account'],
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
        intro: '> 状态：在写 / 待发 / 已发 / 待回填 / 已归档。选题笔记 / 商品档案 填 vault 内的相对路径（如 Topics/xxx.md）。最后三列（选题ID / 版本ID / 账号）由系统按排期自动填，别手改。',
        label: '日历',
      }),
    }
  }

  // 日历读出来一份「归一过的」视图：平台名收敛成规范名，供展示和筛选用。
  // 只改内存，绝不写盘 —— 用户哪天想起自己写的是「bilibili」也该还是 bilibili。
  function normalizeCalendarEntries(entries) {
    return (entries ?? []).map((entry) => ({ ...entry, platform: normalizePlatform(entry.platform) }))
  }

  // 日历行第一次保存时把选题的稳定 id 写进去。缺这个值时表格按老主键
  // date+platform+topic 算 id，改一次「主题」就会换一行；补上之后 id 就稳定了。
  async function calendarRowWithTopicId(row) {
    const next = { ...(row ?? {}) }
    if (String(next.topicId ?? '').trim() !== '') return next
    const raw = String(next.topicPath ?? '').trim()
    if (raw === '') return next
    try {
      const target = await resolveTopicPath(raw)
      if (target.ok === true) {
        const topic = await collections.topics.read(target.path)
        next.topicId = topic.id
      }
    } catch {
      // 关联不到选题就保持空值，不阻塞日历本身的保存。
    }
    return next
  }

  // 选题排期反查：扫一遍所有日历表，给每篇选题找到最早排上去的那一条。
  // 选题列表/详情用它把「排期」按钮直接带到已经排好的那天，而不是永远落在今天。
  // 以文件名（尾段）为键：日历里存的路径偶尔和实际笔记路径有出入，尾段一致就算命中。
  async function topicsScheduleIndex() {
    const map = new Map()
    const months = await calendarMonths()
    for (const month of months) {
      const cal = calendarTableFor(month)
      const state = await cal.table.read(cal.file)
      for (const entry of state.entries ?? []) {
        const key = String(entry.topicPath ?? '').trim().replace(/\\/g, '/').split('/').pop() ?? ''
        if (key === '' || !key.toLowerCase().endsWith('.md')) continue
        if (!map.has(key)) map.set(key, { month, date: String(entry.date ?? '').slice(0, 10), status: String(entry.status ?? '') })
      }
    }
    return map
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
    const dirKeys = ['workbenchDir', 'copyRulesDir', 'topicsDir', 'campaignsDir', 'dataDir', 'feedbackDir', 'productsDir', 'accountsDir', 'calendarDir']
    for (const key of dirKeys) {
      const dir = cfg(key).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
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
    const [calendar, topics, campaigns, products, dataRecords] = await Promise.all([
      cal.table.read(cal.file),
      collections.topics.list({ limit: 500 }),
      collections.campaigns.list({ limit: 500 }),
      collections.products.list({ limit: 500 }),
      collections.data.list({ limit: 500 }),
    ])
    // 回流台账也躺在 Data/ 下，但它记的是「按平台版本按天」的明细，不是周期复盘。
    // 不过滤的话首页「电商数据复盘」的条数会被台账文件撑大（3 个周期会显示成 5 条）。
    const dataPeriods = dataRecords.filter((record) => !String(record.path ?? '').includes('/回流台账/'))
    // 我的选题的摘要数字和卡片分区用同一口径：笔记 frontmatter 或日历排期任一说
    // 「创作中」就算创作中；任一说已发/数据回流就算已发（回流写回是终态）。
    const studioSchedule = await topicsScheduleIndex()
    const stageOf = (record) => {
      const key = String(record?.path ?? '').split('/').pop() ?? ''
      return topicStageOf(record?.front?.status, studioSchedule.get(key)?.status)
    }
    let ruleCounts = { hard: 0, soft: 0, watch: 0 }
    try {
      const state = await readRulesState()
      ruleCounts = rules.countsOf(rules.parseRules(state.text).items)
    } catch {
      ruleCounts = { hard: 0, soft: 0, watch: 0 }
    }
    // sopDir 为空时「SOP」= 整个 vault，否则是整个库一篇都数不到。
    const sopPrefix = sopDirValue().replace(/^\/+|\/+$/g, '')
    const inSop = (path) => sopPrefix === '' || path === sopPrefix || path.startsWith(sopPrefix + '/')
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
      dataLatest: dataPeriods[0]?.front?.period ?? '',
      dataCount: dataPeriods.length,
      ideasNew: ideas.entries.filter((entry) => entry.status !== '已用' && entry.status !== '丢弃' && entry.status !== '已废弃').length,
      ideasTotal: ideas.entries.length,
      glossary: glossary.entries.length,
      feedbackNegativeOpen: feedback.entries.filter((entry) => String(entry.sentiment).includes('负') && !['已处理', '闭环'].includes(String(entry.status))).length,
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
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJsonBody(req) : {}

    if (route === '' || route === 'ping') return { ping: true, version: PKG_VERSION }

    // 浏览器半边的诊断落点。面板跑在别人的页面里，控制台不是随时都能看，
    // 所以让它把自己的探测结果写进本机文件：重启一次就能看清是哪一层没接上。
    if (route === 'client-log' && method === 'POST') {
      try {
        appendFileSync(join(traceDir, 'client.log'), `${new Date().toISOString()} ${JSON.stringify(body)}\n`)
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
      const config = { vaultRoot: vaultRoot() }
      for (const key of Object.keys(DEFAULT_DIRS)) config[key] = cfg(key)
      return { config, dataDir: dataDir(), configured: vaultRoot() !== '', cards }
    }

    if (route === 'config' && method === 'PUT') {
      const root = await assertVaultRoot(body?.vaultRoot)
      // pluginDataDir 单独处理：它决定 config.json 存在哪里，要等旧位置写完之后再生效。
      const nextDataDir = String(body?.pluginDataDir ?? '').trim()
      delete userConfig.pluginDataDir
      if (root !== '') userConfig.vaultRoot = root
      for (const key of Object.keys(DEFAULT_DIRS)) {
        if (key === 'pluginDataDir') continue
        if (typeof body?.[key] !== 'string') continue
        const value = String(body[key]).trim()
        if (value !== '') userConfig[key] = value
        // sopDir 允许清空：清空后自动跟随 vault（优先用 vault 里的 SOP/）。
        else if (key === 'sopDir') delete userConfig.sopDir
      }
      await saveUserConfig()
      if (nextDataDir !== '') {
        userConfig.pluginDataDir = nextDataDir
        await saveUserConfig()
      }
      build()
      vault?.invalidate()
      await ensureSeeds()
      return { saved: true, configured: vaultRoot() !== '', dataDir: dataDir(), cards }
    }

    if (route === 'cards' && method === 'PUT') {
      if (Array.isArray(body?.cards)) {
        const byId = new Map(cards.map((card) => [card.id, card]))
        for (const entry of body.cards) {
          const existing = byId.get(String(entry?.id ?? ''))
          if (existing !== undefined) existing.enabled = entry.enabled !== false
        }
        await saveCards()
      }
      return { cards }
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
      const records = await collections.topics.list({ limit: 1000 })
      const hit = records.find((record) => String(record.id ?? record.front?.id ?? '') === wanted)
      if (hit === undefined) throw new VaultError('主选题不存在：' + wanted, 'not_found')
      return hit
    }

    if (v2[0] === 'state' && v2.length === 1 && method === 'GET') {
      const masters = realMasterRecords(await collections.topics.list({ limit: 1000 }))
      return {
        version: 2,
        statuses: VARIANT_STATUSES,
        transitions: VARIANT_TRANSITIONS,
        masters,
      }
    }
    if (v2[0] === 'migration' && v2.length === 2 && v2[1] === 'preview' && method === 'GET') {
      return { migration: await migrator.preview() }
    }
    if (v2[0] === 'migration' && v2.length === 2 && v2[1] === 'apply' && method === 'POST') {
      return { migration: await migrator.apply({ dryRun: body?.dryRun === true }) }
    }
    if (v2[0] === 'masters' && v2.length === 1 && method === 'GET') {
      const masters = realMasterRecords(await collections.topics.list({ limit: 1000 }))
      for (const master of masters) master.variants = await domain.variantSummary(master.id)
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
      const expected = String(body?.expectedSha1 ?? '').trim()
      if (expected !== '' && expected !== latest.sha1) {
        throw new VaultError('这个平台版本在别处被改过（Obsidian 里？），刷新后再删', 'conflict')
      }
      await vault.deleteNote(variant.path, { expectedSha1: latest.sha1 })
      vault.invalidate()
      return { deleted: variant.path }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'transition' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.transitionVariant(variant.path, body?.to ?? body?.status, { actor: body?.actor, at: body?.at }) }
    }
    // 从「已归档」拿回来。归档不是删除，所以必须有这条反向路 —— 没有它，
    // 「归档」就是个单向门，用户不敢点。
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'restore' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { variant: await domain.restoreVariant(variant.path) }
    }
    if (v2[0] === 'variants' && v2.length === 3 && v2[2] === 'metrics' && method === 'POST') {
      const variant = await domain.getVariant(v2[1])
      return { metric: await domain.appendMetric({ ...body, variantId: variant.id, masterId: variant.front?.masterId, platform: variant.front?.platform, account: variant.front?.account, dataDir: dirOf('dataDir') }) }
    }
    if (v2[0] === 'matrix' && v2.length === 1 && method === 'GET') {
      const month = q('month') || thisMonth()
      const masters = realMasterRecords(await collections.topics.list({ limit: 1000 }))
      // 日期只有一个真源：内容日历。没排期的版本不进月视图 ——
      // 没有排期的版本不进月视图：以前空日期每个月都放进来，同一个版本被数了十二遍。
      const schedule = await variantScheduleIndex()
      const rows = []
      for (const master of masters) {
        const all = await domain.listVariants(master.id)
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
      const masters = realMasterRecords(await collections.topics.list({ limit: 1000 }))
      const schedule = await variantScheduleIndex()
      const items = []
      for (const master of masters) {
        const variants = await domain.listVariants(master.id)
        for (const variant of variants) {
          // 全量发布队列：只要这个月排了期，不管它现在是「选题 / 创作中 / 待审 /
          // 已排期 / 已发 / 数据回流」，都要出现在日历的发布队列里。
          // 只排除已归档——归档是收起来，不该再占发布档期。
          if (variant.status === '已归档') continue
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
      const masters = realMasterRecords(await collections.topics.list({ limit: 1000 }))
      const masterById = new Map(masters.map((master) => [String(master.id ?? master.front?.id ?? ''), master]))
      const items = []
      // 「已排/未排发布」以内容日历为准：把同选题+同平台的排期挂上，和我的选题列表同一口径。
      const schedule = await variantScheduleIndex()
      const allVariants = await domain.listVariants()

      for (const variant of allVariants) {
        if (!['已发', '待回填'].includes(variant.status)) continue
        const master = masterById.get(String(variant.front?.masterId ?? ''))
        // 主选题被删或落在测试目录的版本不往这里列：没有标题的行点了也没处去。
        if (master === undefined) continue
        variant.schedule = scheduleForVariant(variant, schedule, allVariants.filter((item) => String(item.front?.masterId ?? '') === String(variant.front?.masterId ?? '') && normalizePlatform(item.front?.platform) === normalizePlatform(variant.front?.platform)).length)
        items.push({
          master: { id: master.id, title: master.title, path: master.path },
          variant,
        })
      }
      items.sort((left, right) => String(left.variant.schedule?.date ?? '').localeCompare(String(right.variant.schedule?.date ?? ''))
        || String(left.master.title).localeCompare(String(right.master.title), 'zh'))
      return { items }
    }
    if (v2[0] === 'ledger' && v2.length === 1 && method === 'GET') {
      const month = q('month').trim()
      const masters = await collections.topics.list({ limit: 1000 })
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

    // sopDir 为空 = 树就是整个 vault 根，不再套一层目录；
    // 配了 sopDir 才把树的路径补成 vault 根的相对路径，让读、写、删同一个基准。
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
    // SOP 搜索 = 全局搜索：搜整个 vault，不只搜树上那份。
    // scopeTree=false 时额外给出一条 treeHit，告诉前端「这条在树里 / 不在树里」，
    // 树里就正常展开；树外也能点，走 readNote 直接预览，不依赖树节点。
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
        matches.push({ ...hit, inTree: visible.has(hit.path) })
        if (matches.length >= 60) break
      }
      return { matches, total: matches.length, root: payload.root, global: true }
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
      const known = new Set(Object.values(DEFAULT_DIRS).filter((name) => name !== ''))
      const top = rel.split('/')[0]
      if (known.has(top) || !rel.includes('/')) return rel
      return prefix + '/' + rel
    }
    if (route === 'annotations' && method === 'GET') {
      const target = await resolveNotePath(q('path'))
      if (target === '' || !(await vault.exists(target))) return { annotations: [], path: target }
      const note = await vault.readNote(target)
      return { annotations: annotationsOf(note.text, target), path: target, sha1: note.sha1 }
    }
    if (route === 'sop/note' && method === 'GET') {
      // 搜索是全局的，命中的笔记可能不在 SOP 树里（vault 根之外的 SOP/ 之外）。
      // notePathOf 会给相对路径补 SOP/ 前缀，树外的笔记因此打不开 ——
      // 所以先按 vault 根的相对路径试一次，存在就用它。
      const raw = String(q('note') ?? '').trim().replace(/\\\\/g, '/')
      const direct = raw.startsWith('/') ? raw.slice(1) : raw
      const target = direct !== '' && await vault.exists(direct) ? direct : notePathOf(q('note'))
      const note = await vault.readNote(target)
      return { note: { ...note, sections: sectionsOf(note.text) } }
    }
    if (route === 'sop/note' && method === 'DELETE') {
      const raw = String(q('note') ?? '').trim().replace(/\\\\/g, '/')
      const direct = raw.startsWith('/') ? raw.slice(1) : raw
      const target = direct !== '' && await vault.exists(direct) ? direct : notePathOf(q('note'))
      return { deleted: await vault.deleteNote(target, { expectedSha1: q('sha1') }) }
    }
    if (route === 'sop/note' && method === 'PUT') {
      if (typeof body?.text !== 'string') throw new VaultError('text 必填', 'bad_request')
      // 同 GET：树外笔记按 vault 根相对路径直接写，别再套 SOP/ 前缀。
      const raw = String(q('note') ?? '').trim().replace(/\\\\/g, '/')
      const direct = raw.startsWith('/') ? raw.slice(1) : raw
      const target = direct !== '' && await vault.exists(direct) ? direct : notePathOf(q('note'))
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
    if (route in simpleTables) {
      const spec = simpleTables[route]
      // 「在 Obsidian 中打开」需要一个能交给 uriFor 的相对路径。
      const specPath = relToVault(spec.file())
      if (method === 'GET') {
        const state = await spec.table().read(spec.file())
        return { entries: state.entries, exists: state.exists, warning: state.warning, path: specPath }
      }
      if (method === 'POST') return requireTable(await spec.table().add(spec.file(), { ...spec.defaults(), ...body }))
      if (method === 'PUT') return requireTable(await spec.table().update(spec.file(), String(body?.id ?? ''), body))
      if (method === 'DELETE') return requireTable(await spec.table().remove(spec.file(), q('id')))
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
        sha1: state.sha1,
        path: calPath,
        platforms: platformOptions(known),
      }
    }
    if (route === 'calendar' && method === 'POST') {
      const cal = calendarTableFor(body?.month)
      return { month: cal.month, ...(await requireTable(await cal.table.add(cal.file, await calendarRowWithTopicId(body)))) }
    }
    if (route === 'calendar' && method === 'PUT') {
      const cal = calendarTableFor(body?.month)
      const before = await cal.table.read(cal.file)
      const current = (before.entries ?? []).find((entry) => entry.id === String(body?.id ?? ''))
      if (current === undefined) throw new VaultError('日历里找不到这条：' + String(body?.id ?? ''), 'not_found')
      const next = await calendarRowWithTopicId({ ...current, ...body })
      const result = { month: cal.month, ...(await requireTable(await cal.table.update(cal.file, current.id, next, { expectedSha1: body?.expectedSha1 }))) }
      // 从别的状态改成「已发」= 这条真的发出去了：顺手把同选题同平台的平台版本
      // 沿状态机推到「已发」，让日历和版本记同一本账。
      if (String(next.status) === '已发' && String(current.status) !== '已发') {
        result.advanced = await advanceVariantForCalendar(next)
      }
      return result
    }
    // 待回填数据：只给「缺口」—— 日历里标了「已发」但同选题同平台还没有平台版本的行。
    // 有版本的行在上半段按平台版本录，这里再列一遍就是同一件事两个入口。
    if (route === 'pending' && method === 'GET') {
      const months = await calendarMonths()
      const { gaps, total } = await pendingGapsOf()
      return { rows: gaps, months, total }
    }
    // 旧接口 POST /pending/writeback（把播放/赞写回选题 frontmatter）已删除。
    // 同一份数据有两个落点 —— 选题 frontmatter 和回流台账 —— 是「重复」的根源：
    // 榜单读台账、选题卡读 frontmatter，两边永远对不上。现在唯一写入口是
    // POST /v2/variants/:id/metrics，只写回流台账。
    if (route === 'calendar' && method === 'DELETE') {
      const cal = calendarTableFor(q('month'))
      return { month: cal.month, ...(await requireTable(await cal.table.remove(cal.file, q('id')))) }
    }

    for (const kind of ['topics', 'campaigns', 'products', 'accounts', 'data']) {
      const collection = collections[kind]
      if (route === kind + '/list' && method === 'GET') {
        const filters = {}
        for (const [key, value] of url.searchParams) {
          if (['sort', 'desc', 'limit'].includes(key)) continue
          filters[key] = value
        }
        const records = await collection.list({
          filters,
          sortField: q('sort') || collection.sort,
          desc: q('desc') !== 'false',
          limit: Math.min(Number(q('limit') || 300), 1000),
        })
        // 选题列表附带排期信息：前端「排期」按钮好直接跳到已排的那一天。
        if (kind === 'topics') {
          const scheduleIndex = await topicsScheduleIndex()
          // 播放/赞/评/转只有台账一个源，挂在 record.metrics 上给前端读。
          // front.views 现在永远为空（旧回写接口已删），前端不要再读它。
          const latestMetric = await latestMetricByMaster()
          for (const record of records) {
            const key = String(record?.path ?? '').split('/').pop() ?? ''
            const hit = scheduleIndex.get(key)
            if (hit !== undefined) record.schedule = hit
            record.stage = topicStageOf(record.front?.status, hit?.status)
            const metric = latestMetric.get(String(record.id ?? record.front?.id ?? ''))
            if (metric !== undefined) record.metrics = metric
          }
        }
        return { records, schema: collection.schema }
      }
      if (route === kind + '/create' && method === 'POST') return { created: await collection.create(body) }
      if (route === kind + '/record' && method === 'GET') {
        const record = await collection.read(q('path'))
        if (kind === 'topics' && record?.path) {
          const scheduleIndex = await topicsScheduleIndex()
          const hit = scheduleIndex.get(String(record.path).split('/').pop() ?? '')
          if (hit !== undefined) record.schedule = hit
          record.stage = topicStageOf(record.front?.status, hit?.status)
          const metric = (await latestMetricByMaster()).get(String(record.id ?? record.front?.id ?? ''))
          if (metric !== undefined) record.metrics = metric
        }
        return { record }
      }
      if (route === kind + '/record' && method === 'PUT') return { written: await collection.update(q('path'), body) }
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
      const fields = collections.data.schema.map((item) => item.key)
      const mapping = body?.mapping !== undefined && Object.keys(body.mapping).length > 0
        ? body.mapping
        : csv.guessMapping(header, fields)
      const records = csv.applyMapping(rows, mapping, { numericFields: ['gmv', 'traffic', 'conv', 'roi', 'mom'] })
      const archiveDir = join(dirOf('dataDir'), 'csv')
      const archive = join(archiveDir, 'import-' + today() + '-' + safeFileName(body?.name ?? 'data', 'data').replace(/\s+/g, '_') + '.csv')
      await mkdir(archiveDir, { recursive: true })
      const flattened = rows.slice(1).map((row) => {
        const record = {}
        header.forEach((name, index) => { record[name] = row[index] ?? '' })
        return record
      })
      await writeFile(archive, '\uFEFF' + csv.toCsv(header, flattened), 'utf8')
      return { mapping, header, records, count: records.length, archive }
    }

    if (route === 'rules' && method === 'GET') {
      const state = await readRulesState()
      const parsed = rules.parseRules(state.text)
      // uriFor 只吃相对 vault 根的路径，这里换算过去，前端就能直接拿去打开。
      return { text: state.text, sha1: state.sha1, items: parsed.items, counts: rules.countsOf(parsed.items), nextId: rules.nextRuleId(parsed.items), nextIds: nextIdsOf(parsed.items), path: relToVault(rulesPath) }
    }

    if (route === 'rules' && method === 'PUT') {
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
      try {
        await writeFile(rulesPath + '.bak', current.text, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new VaultError('备份失败，未写入：' + describe(error), 'backup_failed')
      }
      await atomicWrite(rulesPath, nextText)
      const parsedNext = rules.parseRules(nextText)
      return {
        sha1: rules.sha1Of(nextText),
        items: parsedNext.items,
        counts: rules.countsOf(parsedNext.items),
        nextId: rules.nextRuleId(parsedNext.items),
        nextIds: nextIdsOf(parsedNext.items),
      }
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
      const expected = String(body?.expectedSha1 ?? '').trim()
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
    // ── 门槛：只有带着 token 的页面请求才放行 ──
    // sec-fetch-site 是浏览器自己加的、网页改不了：cross-site 一律拒。
    // 同一页面里的 fetch 会带 same-origin，它可以到 /token 领票；
    // 没有这个头的调用方（curl、测试脚本、本机命令行）不是被网页驱动的，照旧放行。
    const site = String(req.headers?.['sec-fetch-site'] ?? '')
    if (site === 'cross-site') {
      res.statusCode = 403
      res.end(JSON.stringify({ ok: false, code: 'forbidden', message: '不接受跨站请求' }))
      return
    }
    if (route === 'token' && String(req.method ?? 'GET').toUpperCase() === 'GET') {
      if (site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false, code: 'unauthorized', message: 'token 只能从工作台页面领取' }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, token: AUTH_TOKEN }))
      return
    }
    // EventSource 加不了自定义头，所以长连接这一条额外允许 ?token= 带票（仍然只对本机 loopback 开放）。
    const queryToken = route === 'v2/events' ? String(url.searchParams.get('token') ?? '') : ''
    if (site !== '' && String(req.headers?.['x-dsh-growth-token'] ?? '') !== AUTH_TOKEN && queryToken !== AUTH_TOKEN) {
      res.statusCode = 401
      res.end(JSON.stringify({ ok: false, code: 'unauthorized', message: '缺少访问凭证，刷新一下工作台页面' }))
      return
    }
    // 事件流不是 JSON，也不走 handle()：单独在协议层吐 text/event-stream。
    if (route === 'v2/events') {
      await serveEvents(req, res, url)
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

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))

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
          count = (await collections[id].list({ limit: 1000 })).length
        } catch {
          count = 0
        }
        out.push({ id, folder: cfg(dirKey), noteCount: count, fields: collections[id].schema.map((item) => item.key) })
      }
      out.push({ id: 'sop', folder: sopDirValue() === '' ? '(vault 根)' : sopDirValue(), noteCount: null, fields: [] })
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
        const head = sopDirValue() === '' ? '' : sopDirValue() + '/'
        const rel = head + (sub === '' ? '' : sub + '/') + safeFileName(title) + '.md'
        const text = typeof options.markdown === 'string' && options.markdown.trim() !== ''
          ? options.markdown
          : '# ' + title + '\n\n'
        const created = await vault.createNote(rel, text)
        vault.invalidate()
        return { path: rel, sha1: created.sha1 ?? '' }
      }
      const roots = await vault.tree()
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
      const nextFront = patch.front === undefined ? parsed.front : { ...parsed.front, ...patch.front }
      const nextBody = patch.body === undefined ? parsed.body : String(patch.body)
      const text = patch.text === undefined ? fm.buildNote(nextFront, nextBody) : String(patch.text)
      const written = await vault.writeNote(resolved, text, { expectedSha1: patch.expectedSha1 })
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
