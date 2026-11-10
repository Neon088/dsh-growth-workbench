/**
 * 安装/卸载共用的保守文件操作。只使用 Node 内置模块；默认预览，显式 --apply 才落盘。
 * 备份与临时副本均留在选定 profile 里，不跟随插件 junction 去删源码或笔记。
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'

export const PLUGIN_NAME = 'dsh-growth-workbench'
const ownBundle = (value) => typeof value === 'string'
  && /^(?:npm:)?dsh-growth-workbench(?:@[^/\\\s]+)?$/.test(value)
const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const entryExists = (path) => { try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const conflict = (path) => Object.assign(new Error(`文件已在预览后改变，请重新预览：${path}`), { code: 'profile_conflict' })
function pluginSnapshot(path) {
  if (!entryExists(path)) return null
  const stat = lstatSync(path)
  if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) throw new Error(`拒绝读取特殊插件 entry：${path}`)
  let target = null
  if (stat.isSymbolicLink()) { try { target = realpathSync(path) } catch { target = readlinkSync(path) } }
  const result = { kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file', dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, target }
  if (result.kind === 'file') result.sha1 = sha1(readFileSync(path))
  if (result.kind === 'directory') {
    // 只枚举本 entry 的普通文件；不跟随其内部链接。原地新增/改写也必须重新确认。
    result.entries = readdirSync(path).sort().map((name) => ({ name, snapshot: pluginSnapshot(join(path, name)) }))
  }
  return result
}
function assertPluginSnapshot(plan) {
  if (JSON.stringify(pluginSnapshot(plan.pluginDir)) !== JSON.stringify(plan.pluginSnapshot)) throw conflict(plan.pluginDir)
}
function assertPlainParent(path) {
  if (entryExists(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`拒绝跟随 staging/备份父目录链接：${path}`)
}

export function parseMaintenanceArgs(argv) {
  const options = { profileDir: join(homedir(), '.dsh', 'profiles', 'desktop'), apply: false, confirm: false, expectedPlan: null, json: false, help: false }
  let explicitDryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--confirm') options.confirm = true
    else if (arg === '--dry-run') explicitDryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--profile' || arg === '--expected-plan') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} 后需要${arg === '--profile' ? '目录路径' : '预览指纹'}`)
      const value = argv[++i]
      if (arg === '--profile') options.profileDir = resolve(value)
      else {
        if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('--expected-plan 必须是预览输出的 64 位 SHA256 指纹')
        options.expectedPlan = value.toLowerCase()
      }
    } else throw new Error(`未知参数：${arg}`)
  }
  if (options.apply && options.confirm) throw new Error('--apply 与 --confirm 不能同时使用')
  if (explicitDryRun && (options.apply || options.confirm)) throw new Error('--dry-run 不能与 --apply 或 --confirm 同时使用')
  if (options.json && options.confirm) throw new Error('--json 不能与交互式 --confirm 同时使用')
  if (!options.help && options.apply && options.expectedPlan === null) throw new Error('--apply 需要 --expected-plan <预览指纹>；也可用 --confirm 在同一次运行内预览并确认')
  if (options.expectedPlan !== null && !options.apply) throw new Error('--expected-plan 必须与 --apply 一起使用')
  options.profileDir = resolve(options.profileDir)
  return options
}

function profilePaths(profileDir) {
  const profile = resolve(profileDir)
  if (!isAbsolute(profile) || dirname(profile) === profile) throw new Error('profile 不能是磁盘根目录')
  const packageFile = join(profile, 'package.json')
  const pluginDir = join(profile, 'node_modules', PLUGIN_NAME)
  if (!existsSync(packageFile)) throw new Error(`找不到 profile 的 package.json：${packageFile}`)
  if (!lstatSync(profile).isDirectory()) throw new Error(`profile 必须是普通目录：${profile}`)
  return { profileDir: profile, packageFile, pluginDir }
}

function readPlainConfig(path) {
  if (!entryExists(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`profile 配置必须是普通文件，拒绝跟随链接：${path}`)
  return readFileSync(path, 'utf8')
}
function configSnapshot(path, before = readPlainConfig(path)) {
  return { path, beforeSha1: before === null ? null : sha1(before) }
}

function readPackage(path) {
  const before = readPlainConfig(path)
  if (before === null) throw new Error(`找不到 profile 的 package.json：${path}`)
  const pkg = JSON.parse(before)
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('profile package.json 必须是对象')
  if (pkg.dsh !== undefined && (pkg.dsh === null || typeof pkg.dsh !== 'object' || Array.isArray(pkg.dsh))) throw new Error('dsh 配置格式不对，拒绝覆盖')
  if (pkg.dsh?.profile !== undefined && (pkg.dsh.profile === null || typeof pkg.dsh.profile !== 'object' || Array.isArray(pkg.dsh.profile))) throw new Error('dsh.profile 配置格式不对，拒绝覆盖')
  if (pkg.dsh?.profile?.bundles !== undefined && !Array.isArray(pkg.dsh.profile.bundles)) throw new Error('dsh.profile.bundles 必须是数组')
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pkg[field] !== undefined && (pkg[field] === null || typeof pkg[field] !== 'object' || Array.isArray(pkg[field]))) throw new Error(`${field} 必须是对象`)
  }
  return { before, pkg }
}

// 只识别 Cordis 实際使用的顶层插件列表和 insert 列表。遇到 flow/anchor 等未知写法拒写，
// 不把“出现过插件名”当作整份 YAML 可以清空的依据。注释、其它插件及换行保持原样。
function withoutComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote === '"' && char === '\\') { i++; continue }
    if (quote === "'" && char === "'" && line[i + 1] === "'") { i++; continue }
    if (quote !== '') { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

function yamlString(value) {
  const text = withoutComment(value).trim()
  if (/^'([^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'")
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) { try { const result = JSON.parse(text); return typeof result === 'string' ? result : null } catch { return null } }
  if (/^[a-zA-Z0-9_@./:-]+$/.test(text)) return text
  return null
}

export function removePluginYaml(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '[]') return { text, removed: 0 }
  // JSON 数组也是合法 YAML；不对其它 JSON 根类型作猜测。
  if (trimmed.startsWith('[')) {
    let input
    try { input = JSON.parse(trimmed) } catch { throw new Error('Cordis 配置使用了不支持的 flow YAML，未修改；请先转换为普通列表') }
    let removed = 0
    const clean = input.filter((item) => {
      if (ownBundle(item) || (item && typeof item === 'object' && ownBundle(item.name))) { removed++; return false }
      if (item && typeof item === 'object' && Array.isArray(item.insert)) {
        item.insert = item.insert.filter((child) => { if (child && typeof child === 'object' && ownBundle(child.name)) { removed++; return false }; return true })
      }
      return true
    })
    return { text: removed ? JSON.stringify(clean, null, 2) + '\n' : text, removed }
  }
  const rows = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean)
  const content = rows.map((row) => withoutComment(row.replace(/[\r\n]+$/, '')))
  if (content.some((line) => /^\t/.test(line))) throw new Error('Cordis YAML 使用了 tab 缩进，拒绝猜测修改')
  // 手写定位器不解析 YAML 文档流；不能把删空后的文档边界误写成 null。
  if (content.some((line) => /^(?:\uFEFF)?(?:---|\.\.\.)(?:\s|$)/.test(line))) throw new Error('Cordis YAML 使用了文档边界，未修改；请先转换为单个普通列表')
  const nodes = []
  for (let i = 0; i < content.length; i++) {
    const match = content[i].match(/^( *)-\s+(.*)$/)
    if (!match) continue
    const indent = match[1].length
    let end = i + 1
    while (end < content.length) {
      if (content[end].trim() !== '') {
        const nextIndent = content[end].length - content[end].trimStart().length
        if (nextIndent <= indent) break
      }
      end++
    }
    const node = { start: i, end, indent, first: match[2], fields: new Map() }
    const firstField = match[2].match(/^([\w-]+):\s*(.*)$/)
    if (firstField) node.fields.set(firstField[1], yamlString(firstField[2]))
    for (let j = i + 1; j < end; j++) {
      const field = content[j].match(/^( *)([\w-]+):\s*(.*)$/)
      if (field && field[1].length === indent + 2) node.fields.set(field[2], yamlString(field[3]))
    }
    nodes.push(node)
  }
  const rootItems = nodes.filter((node) => node.indent === 0)
  const supported = (node) => node.indent === 0 || rootItems.some((root) => {
    if (!(root.start < node.start && root.end >= node.end) || !/^insert:\s*$/.test(root.first)) return false
    const childIndents = nodes.filter((child) => child.start > root.start && child.end <= root.end).map((child) => child.indent)
    return childIndents.length > 0 && node.indent === Math.min(...childIndents)
  })
  const targets = nodes.filter((node) => supported(node) && ownBundle(node.fields.get('name')))
  // 顶层裸插件名列表也可精准移除；绝不按 substring 匹配相似插件名。
  for (const node of rootItems) if (ownBundle(yamlString(node.first))) targets.push(node)
  // 不解引用锚点，也不移除可能被其它插件复用的锚点定义；复杂配置整次拒写。
  for (const node of targets) {
    if (content.slice(node.start, node.end).some((line) => /(?:^|[\s:[,{])[&*][a-zA-Z0-9_-]+/.test(line))) {
      throw new Error('目标增长工作台 YAML 项使用了锚点或别名，未修改；请先展开为普通配置')
    }
  }
  const removedLines = new Set()
  for (const node of targets) for (let i = node.start; i < node.end; i++) if (content[i].trim() !== '') removedLines.add(i)
  // 名称字段明确含目标，但不是受支持列表，宁可整次拒写，不留下半卸载的假成功。
  for (let i = 0; i < content.length; i++) {
    const value = content[i].match(/(?:^|[ {,])(?:name|id|"(?:name|id)"|'(?:name|id)')\s*:\s*([^}]*dsh-growth-workbench[^}]*)/)
    if (!value || removedLines.has(i)) continue
    const scalar = yamlString(value[1])
    if ((scalar !== null && ownBundle(scalar)) || (scalar === null && /(?:^|[ {,])(?:name|id|"(?:name|id)"|'(?:name|id)')\s*:\s*(?:&[a-zA-Z0-9_-]+\s+)?['"]?dsh-growth-workbench(?:['"\s,}]|$)/.test(content[i]))) {
      throw new Error('发现不能安全定位的增长工作台 YAML 项，未修改；请先转换为顶层或 insert 普通列表')
    }
  }
  if (targets.length === 0) return { text, removed: 0 }
  // insert 仅剩空列表时保留动作，显式 []，而不是写成无值/null。
  const replacements = new Map()
  for (const root of rootItems) {
    if (!/^insert:\s*$/.test(root.first) || removedLines.has(root.start)) continue
    const remaining = content.slice(root.start + 1, root.end).some((line, at) => line.trim() !== '' && !removedLines.has(root.start + 1 + at))
    if (!remaining) replacements.set(root.start, rows[root.start].replace(/insert:(\s*)(?=(?:#|\r|\n|$))/, 'insert: []$1'))
  }
  let result = rows.map((row, i) => removedLines.has(i) ? '' : replacements.get(i) ?? row).join('')
  if (result.split(/\r?\n/).every((line) => withoutComment(line).trim() === '')) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    result = (result === '' || result.endsWith('\n') || result.endsWith('\r') ? result : result + eol) + '[]' + eol
  }
  return { text: result, removed: targets.length }
}

function change(path, before, after) { return { path, before, after, beforeSha1: sha1(before) } }

function sourceFiles(sourceDir) {
  const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'install.mjs', 'rollback.mjs', 'run-rollback.bat'].filter((file) => existsSync(join(sourceDir, file)))
  for (const required of ['index.js', 'client.js', 'package.json']) if (!files.includes(required)) throw new Error(`源目录缺少 ${required}`)
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`源 lib 中含链接，拒绝跟随：${join(dir, entry.name)}`)
      if (entry.isDirectory()) walk(join(dir, entry.name), join(prefix, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(join(prefix, entry.name))
    }
  }
  walk(join(sourceDir, 'lib'), 'lib')
  return files.sort()
}

export function makeInstallPlan({ sourceDir, profileDir }) {
  const paths = profilePaths(profileDir)
  const source = realpathSync(resolve(sourceDir))
  const { before, pkg } = readPackage(paths.packageFile)
  const sourcePackage = readFileSync(join(source, 'package.json'))
  const self = JSON.parse(sourcePackage.toString('utf8'))
  if (self.name !== PLUGIN_NAME || !self.version || !self.exports?.['./client'] || !self.exports?.['./package.json']) throw new Error('源包名、版本或 client/package 导出不完整')
  const files = sourceFiles(source)
  const exists = entryExists(paths.pluginDir)
  const snapshot = pluginSnapshot(paths.pluginDir)
  const preserveLink = exists && snapshot.kind === 'link' && snapshot.target === source
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles = pkg.dsh.profile.bundles ?? []
  const own = bundles.filter(ownBundle)
  if (own.length !== 1 || own[0] !== PLUGIN_NAME) pkg.dsh.profile.bundles = [PLUGIN_NAME, ...bundles.filter((item) => !ownBundle(item))]
  else pkg.dsh.profile.bundles = bundles
  pkg.dependencies ??= {}
  pkg.dependencies[PLUGIN_NAME] = self.version
  const after = JSON.stringify(pkg, null, 2) + '\n'
  const changes = JSON.stringify(JSON.parse(before)) === JSON.stringify(pkg) ? [] : [change(paths.packageFile, before, after)]
  const sourceHashes = Object.fromEntries(files.map((file) => [file, sha1(readFileSync(join(source, file)))]))
  if (sourceHashes['package.json'] !== sha1(sourcePackage)) throw conflict(join(source, 'package.json'))
  const profileSnapshots = [configSnapshot(paths.packageFile, before), ...['cordis.yml', 'cordis.patch.yml'].map((file) => configSnapshot(join(paths.profileDir, file)))]
  return { operation: 'install', ...paths, sourceDir: source, version: self.version, files, sourceHashes, profileSnapshots, changes, pluginSnapshot: snapshot, pluginAction: preserveLink ? 'preserve-link' : exists ? 'replace-directory' : 'create-directory' }
}

export function makeRollbackPlan({ profileDir }) {
  const paths = profilePaths(profileDir)
  const { before, pkg } = readPackage(paths.packageFile)
  if (Array.isArray(pkg.dsh?.profile?.bundles)) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((value) => !ownBundle(value))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (pkg[field]) delete pkg[field][PLUGIN_NAME]
  const changes = JSON.stringify(JSON.parse(before)) === JSON.stringify(pkg) ? [] : [change(paths.packageFile, before, JSON.stringify(pkg, null, 2) + '\n')]
  let yamlRemoved = 0
  const profileSnapshots = [configSnapshot(paths.packageFile, before)]
  for (const file of ['cordis.yml', 'cordis.patch.yml']) {
    const path = join(paths.profileDir, file)
    const text = readPlainConfig(path)
    profileSnapshots.push(configSnapshot(path, text))
    if (text === null) continue
    const cleaned = removePluginYaml(text)
    yamlRemoved += cleaned.removed
    if (cleaned.text !== text) changes.push(change(path, text, cleaned.text))
  }
  const snapshot = pluginSnapshot(paths.pluginDir)
  return { operation: 'rollback', ...paths, changes, profileSnapshots, yamlRemoved, files: [], pluginSnapshot: snapshot, pluginAction: snapshot !== null ? 'quarantine-directory' : 'none' }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  return value
}

export function maintenancePlanFingerprint(plan) {
  const inputs = {
    schemaVersion: 1, operation: plan.operation, profileDir: plan.profileDir,
    packageFile: plan.packageFile, pluginDir: plan.pluginDir, pluginAction: plan.pluginAction,
    pluginSnapshot: plan.pluginSnapshot, profileSnapshots: plan.profileSnapshots,
    sourceDir: plan.sourceDir ?? null, version: plan.version ?? null,
    files: plan.files, sourceHashes: plan.sourceHashes ?? {},
    changes: plan.changes.map((entry) => ({ path: entry.path, beforeSha1: entry.beforeSha1, afterSha1: sha1(entry.after) })),
    yamlRemoved: plan.yamlRemoved ?? 0,
  }
  return createHash('sha256').update(JSON.stringify(stableValue(inputs))).digest('hex')
}

export function publicMaintenancePlan(plan) {
  return {
    schemaVersion: 1, fingerprint: maintenancePlanFingerprint(plan),
    operation: plan.operation, profileDir: plan.profileDir, pluginDir: plan.pluginDir,
    sourceDir: plan.sourceDir, version: plan.version, pluginAction: plan.pluginAction,
    filesToCopy: plan.files.length, configurationChanges: plan.changes.map((entry) => ({ path: entry.path, beforeSha1: entry.beforeSha1 })),
    yamlItemsRemoved: plan.yamlRemoved ?? 0, preservesVaultAndPluginConfig: true,
  }
}

function assertPlanInputs(plan) {
  // 未改动的配置与当时缺失的 YAML 也是计划输入；不能只核对 changes。
  for (const entry of plan.profileSnapshots) {
    let current
    try { current = configSnapshot(entry.path) } catch { throw conflict(entry.path) }
    if (current.beforeSha1 !== entry.beforeSha1) throw conflict(entry.path)
  }
  assertPluginSnapshot(plan)
  if (plan.operation === 'install') {
    try {
      if (JSON.stringify(sourceFiles(plan.sourceDir)) !== JSON.stringify(plan.files)) throw conflict(plan.sourceDir)
      for (const rel of plan.files) if (sha1(readFileSync(join(plan.sourceDir, rel))) !== plan.sourceHashes[rel]) throw conflict(join(plan.sourceDir, rel))
    } catch (error) {
      if (error.code === 'profile_conflict') throw error
      throw conflict(plan.sourceDir)
    }
  }
}

function assertSnapshot(entry) {
  if (!existsSync(entry.path) || sha1(readFileSync(entry.path, 'utf8')) !== entry.beforeSha1) throw conflict(entry.path)
}

function atomicText(path, text, expectedSha1) {
  if (expectedSha1 !== undefined && (!existsSync(path) || sha1(readFileSync(path, 'utf8')) !== expectedSha1)) throw conflict(path)
  const temp = `${path}.growth-tmp-${randomUUID()}`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    if (expectedSha1 !== undefined && sha1(readFileSync(path, 'utf8')) !== expectedSha1) throw conflict(path)
    renameSync(temp, path)
  } finally { if (entryExists(temp)) rmSync(temp) }
}

/** Hooks are for isolated fault-injection tests; CLI does not expose them. */
export function applyMaintenancePlan(plan, { expectedPlan, beforeCommit, beforeConfigWrite } = {}) {
  if (!['install', 'rollback'].includes(plan.operation) || !Array.isArray(plan.profileSnapshots)) throw new Error('不是受支持的维护计划，请重新预览')
  if (expectedPlan !== undefined && expectedPlan !== maintenancePlanFingerprint(plan)) throw Object.assign(new Error('已确认的预览计划指纹不匹配，请重新预览后确认'), { code: 'profile_conflict' })
  const paths = profilePaths(plan.profileDir)
  if (paths.pluginDir !== plan.pluginDir || paths.packageFile !== plan.packageFile) throw new Error('目标与已确认的 profile 布局不一致')
  for (const entry of [...plan.profileSnapshots, ...plan.changes]) {
    if (dirname(entry.path) !== plan.profileDir || !['package.json', 'cordis.yml', 'cordis.patch.yml'].includes(basename(entry.path))) throw new Error('拒绝修改 profile 清单之外的文件')
  }
  for (const entry of plan.changes) assertSnapshot(entry)
  assertPlanInputs(plan)
  const needsPluginChange = !['none', 'preserve-link'].includes(plan.pluginAction)
  if (!needsPluginChange && plan.changes.length === 0) return { changed: false, backupDir: null }
  const tag = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const backupDir = join(plan.profileDir, '.dsh-growth-backups', tag)
  const modulesDir = join(plan.profileDir, 'node_modules')
  const stage = join(modulesDir, `.growth-stage-${tag}`)
  // 确认绝对路径与固定叶子名后才移动/清理；不会把 junction 的 realpath 当删除目标。
  if (relative(plan.profileDir, backupDir).startsWith('..') || dirname(stage) !== modulesDir) throw new Error('备份或 staging 路径越界')
  assertPlainParent(modulesDir)
  assertPlainParent(join(plan.profileDir, '.dsh-growth-backups'))
  mkdirSync(backupDir, { recursive: true })
  for (const entry of plan.changes) copyFileSync(entry.path, join(backupDir, basename(entry.path) + '.bak'))
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(publicMaintenancePlan(plan), null, 2) + '\n', { flag: 'wx' })
  const committed = []
  let movedOldPlugin = false
  let installedNewPlugin = false
  let installedSnapshot = null
  try {
    if (plan.operation === 'install' && needsPluginChange) {
      mkdirSync(stage, { recursive: true })
      for (const rel of plan.files) {
        const target = join(stage, rel)
        if (relative(stage, target).startsWith('..')) throw new Error('源文件路径越界')
        mkdirSync(dirname(target), { recursive: true })
        if (sha1(readFileSync(join(plan.sourceDir, rel))) !== plan.sourceHashes[rel]) throw conflict(join(plan.sourceDir, rel))
        copyFileSync(join(plan.sourceDir, rel), target)
        if (sha1(readFileSync(target)) !== plan.sourceHashes[rel]) throw conflict(join(plan.sourceDir, rel))
      }
    }
    if (typeof beforeCommit === 'function') beforeCommit()
    for (const entry of plan.changes) assertSnapshot(entry)
    assertPlanInputs(plan)
    if (needsPluginChange) {
      // 已打印计划中的原始 entry 是唯一移动目标；rename 不跟随 junction。
      if (entryExists(plan.pluginDir)) { renameSync(plan.pluginDir, join(backupDir, 'plugin')); movedOldPlugin = true }
      if (plan.operation === 'install') { renameSync(stage, plan.pluginDir); installedNewPlugin = true; installedSnapshot = pluginSnapshot(plan.pluginDir) }
    }
    for (const [index, entry] of plan.changes.entries()) {
      if (typeof beforeConfigWrite === 'function') beforeConfigWrite(entry, index)
      atomicText(entry.path, entry.after, entry.beforeSha1)
      committed.push(entry)
    }
    return { changed: true, backupDir }
  } catch (error) {
    const recoveryErrors = []
    for (const entry of committed.reverse()) {
      try { atomicText(entry.path, entry.before, sha1(entry.after)) } catch (recovery) { recoveryErrors.push(recovery.message) }
    }
    try {
      // 只撤回本次仍拥有的 entry；不能把别人的新目录/链接移开再恢复旧插件。
      if (installedNewPlugin) {
        if (JSON.stringify(pluginSnapshot(plan.pluginDir)) !== JSON.stringify(installedSnapshot)) throw conflict(plan.pluginDir)
        renameSync(plan.pluginDir, join(backupDir, 'failed-install'))
      }
      if (movedOldPlugin) {
        if (entryExists(plan.pluginDir)) throw conflict(plan.pluginDir)
        renameSync(join(backupDir, 'plugin'), plan.pluginDir)
      }
    } catch (recovery) { recoveryErrors.push(recovery.message) }
    if (recoveryErrors.length) error.message += `；自动恢复未完成，请用备份 ${backupDir}：${recoveryErrors.join('；')}`
    throw error
  } finally {
    if (entryExists(stage)) {
      if (dirname(stage) !== modulesDir || !basename(stage).startsWith('.growth-stage-')) throw new Error('拒绝清理未经确认的 staging 路径')
      rmSync(stage, { recursive: true, force: true })
    }
  }
}

async function confirmMaintenancePlan() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const closed = () => controller.abort()
  terminal.once('close', closed)
  try {
    const answer = await terminal.question('应用上面这份计划？输入 Y 确认，直接回车取消：', { signal: controller.signal })
    return /^(?:y|yes)$/i.test(answer.trim())
  } catch (error) {
    if (error.name === 'AbortError') return false
    throw error
  } finally { terminal.removeListener('close', closed); terminal.close() }
}

/** 可注入确认和输出以做内存/临时目录测试；真实 CLI 只使用 readline。 */
export async function runMaintenanceCli(operation, argv, { sourceDir, confirmPlan = confirmMaintenancePlan, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseMaintenanceArgs(argv)
    if (options.help) {
      log(`node ${operation === 'install' ? 'install' : 'rollback'}.mjs [--profile <目录>] [--dry-run [--json] | --confirm | --apply --expected-plan <SHA256>]\n默认纯预览、不写文件。--confirm 在同一次运行里显示并确认原计划；跨次执行必须使用预览指纹。笔记与 ~/.dsh-growth/config.json 始终保留。`)
      return { status: 'help' }
    }
    // 恰好规划一次；确认后绝不再 makePlan，以免把用户看到的 A 换成 B。
    const plan = operation === 'install' ? makeInstallPlan({ sourceDir, profileDir: options.profileDir }) : makeRollbackPlan(options)
    const visible = publicMaintenancePlan(plan)
    if (!options.json) {
      log(`操作：${operation === 'install' ? '安装' : '卸载救急'}；profile：${visible.profileDir}`)
      log(`插件 entry：${visible.pluginDir}；动作：${visible.pluginAction}`)
      for (const entry of visible.configurationChanges) log(`只修改：${entry.path}`)
      log(`复制 ${visible.filesToCopy} 个文件；精准移除 ${visible.yamlItemsRemoved} 个 YAML 项；笔记与插件配置保留。`)
      log(`计划指纹 SHA256：${visible.fingerprint}`)
    }
    if (!options.apply && !options.confirm) {
      if (options.json) log(JSON.stringify({ ...visible, dryRun: true }, null, 2))
      else log('这是预览，没有写文件。用 --confirm 同次确认，或 --apply --expected-plan <上面的指纹> 执行；参数与 profile 必须相同。')
      return { status: 'preview', plan: visible }
    }
    if (options.confirm && await confirmPlan(visible) !== true) {
      log('已取消，没有写文件。')
      return { status: 'cancelled', plan: visible }
    }
    const result = applyMaintenancePlan(plan, { expectedPlan: options.confirm ? visible.fingerprint : options.expectedPlan })
    if (options.json) log(JSON.stringify({ ...visible, dryRun: false, ...result }, null, 2))
    else {
      log(result.changed ? `已完成，备份：${result.backupDir}` : '无需修改。')
      log('没有自动重启或刷新 DSH。需要时请自行重启/刷新并检查。')
    }
    return { status: 'applied', plan: visible, result }
  } catch (error) { errorLog(error.message); process.exitCode = 1; return { status: 'error', error } }
}
