/**
 * vault 直连：Obsidian 的 md 笔记就是工作台的唯一事实源。
 * 移植自 dsh-legal-workbench/lib/vault.js（MIT），改动：
 *   · Spotlight 兜底只在 macOS 保留（win/linux 直接走 fs 枚举）；
 *   · openCommand 由调用方按平台决定。
 * 写入纪律：写前读旧文件算 sha1，调用方带回的 expectedSha1 对不上就拒绝写；
 * 先留 .bak 再临时文件 + rename，任何一步失败原文件不动。
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

// 只协调本进程的写者。外部 Obsidian/同步工具仍靠 sha1 和提交前复核发现冲突；
// 这不是跨进程锁，也不声称普通文件系统能提供绝对 CAS。
const fileWriteQueues = new Map()

export async function withFileWriteLock(file, operation) {
  const absolute = resolve(file)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = fileWriteQueues.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise((done) => { release = done })
  const tail = previous.then(() => gate)
  fileWriteQueues.set(key, tail)
  await previous
  try { return await operation() } finally {
    release()
    if (fileWriteQueues.get(key) === tail) fileWriteQueues.delete(key)
  }
}

/** 唯一、排他创建的临时文件；失败清理。调用者负责其读-改-写的队列与备份。 */
export async function atomicWriteFile(file, text, { beforeCommit } = {}) {
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex')
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    if (beforeCommit !== undefined) await beforeCommit()
    await rename(temp, file)
  } finally {
    try { await unlink(temp) } catch { /* 已提交或尚未创建 */ }
  }
}

export function normalizeVaultSubdir(input, { allowEmpty = true } = {}) {
  const value = String(input ?? '').trim().replace(/\\/g, '/')
  if (value === '' && allowEmpty) return ''
  if (value === '' || isAbsolute(value) || /^[a-z]:/i.test(value) || value.startsWith('//')
    || value.split('/').some((part) => part === '..' || (part !== '.' && /[. ]$/.test(part))) || /[\0:*?"<>|]/.test(value)) {
    throw new VaultError('目录必须是 vault 内的相对路径，不能包含父目录、盘符或非法字符：' + value, 'bad_path')
  }
  return normalize(value).split(sep).join('/').replace(/\/+$/, '')
}

function containedBy(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 词法边界 + 目标/最近存在父目录的 realpath 边界（防外跳链接）。 */
export async function assertPathInsideRoot(root, target, { realRoot } = {}) {
  const absoluteRoot = resolve(root)
  const absolute = resolve(target)
  if (!containedBy(absoluteRoot, absolute)) throw new VaultError('路径越出 vault 根目录：' + absolute, 'bad_path')
  const actualRoot = realRoot ?? await realpath(absoluteRoot)
  let probe = absolute
  while (true) {
    try {
      const actual = await realpath(probe)
      if (!containedBy(actualRoot, actual)) throw new VaultError('路径链接指向 vault 外部：' + absolute, 'bad_path')
      return absolute
    } catch (error) {
      if (error instanceof VaultError) throw error
      if (error?.code !== 'ENOENT' || dirname(probe) === probe) throw error
      probe = dirname(probe)
    }
  }
}

const DISCOVER_TTL_MS = 3000
const SKIP_NAMES = new Set(['.obsidian', '.trash', '.git', 'node_modules'])
const IS_MAC = process.platform === 'darwin'

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMarkdown(name) {
  return /\.md$/i.test(name)
}

export class VaultError extends Error {
  constructor(message, code = 'vault_error', extra = {}) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.extra = extra
  }
}

async function walkMarkdown(dir) {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name) || entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walkMarkdown(full))
    else if (isMarkdown(entry.name)) files.push(full)
  }
  return files
}

function spotlightMarkdown(dir) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/mdfind',
      ['-onlyin', dir, "kMDItemFSName == '*.md'"],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(new VaultError('Spotlight 查询失败：' + describe(error), 'spotlight_failed'))
          return
        }
        resolve(String(stdout).split('\n').map((line) => line.trim()).filter((line) => line !== ''))
      },
    )
  })
}

function titleOf(absPath) {
  return basename(absPath).replace(/\.md$/i, '')
}

export function previewOf(text, limit = 110) {
  let body = String(text ?? '')
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end > 0) body = body.slice(end + 4)
  }
  const flat = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[*\-·>]+\s*/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= limit ? flat : flat.slice(0, limit) + '…'
}

export function sectionsOf(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let current = { title: '（开头）', fromLine: 1, text: [] }
  lines.forEach((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*(.+?)\*\*\s*$/)
    if (match !== null) {
      if (current.text.some((item) => item.trim() !== '')) {
        out.push({ title: current.title, fromLine: current.fromLine, toLine: index, text: current.text.join('\n').trim() })
      }
      current = { title: String(match[1] ?? '').trim(), fromLine: index + 1, text: [line] }
      return
    }
    current.text.push(line)
  })
  if (current.text.some((item) => item.trim() !== '')) {
    out.push({ title: current.title, fromLine: current.fromLine, toLine: lines.length, text: current.text.join('\n').trim() })
  }
  return out.filter((section) => section.text !== '')
}

export function headingsOf(text) {
  return sectionsOf(text).map((section) => ({ line: section.fromLine, text: section.title }))
}

/**
 * 通用目录存储：SOP 只是第一个用途；Topics/Campaigns/Data/Products/Calendar
 * 也用它（base 传各自目录）。所有写入都走同一套 备份→临时文件→rename 纪律。
 */
export function createVaultStore({ vaultRoot, sopDir, backupDir = '' }) {
  const root = resolve(vaultRoot)
  const base = join(root, normalizeVaultSubdir(sopDir))
  const backups = backupDir === '' ? '' : resolve(backupDir)
  let cache = { at: 0, notes: [], source: 'none' }
  let realRootPromise = null
  const noteSnapshots = new Map()
  let snapshotBytes = 0
  const maxSnapshotBytes = 16 * 1024 * 1024

  async function assertInsidePath(abs) {
    realRootPromise ??= realpath(root)
    return assertPathInsideRoot(root, abs, { realRoot: await realRootPromise })
  }

  function invalidate() {
    cache.at = 0
    noteSnapshots.clear()
    snapshotBytes = 0
  }

  function remember(abs, info, note) {
    const old = noteSnapshots.get(abs)
    if (old !== undefined) snapshotBytes -= old.bytes
    noteSnapshots.delete(abs)
    const bytes = note.text.length * 2
    if (bytes > maxSnapshotBytes) return
    noteSnapshots.set(abs, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, bytes, note })
    snapshotBytes += bytes
    while (snapshotBytes > maxSnapshotBytes) {
      const first = noteSnapshots.keys().next().value
      snapshotBytes -= noteSnapshots.get(first).bytes
      noteSnapshots.delete(first)
    }
  }

  function noteOf(abs, text, info) {
    return { path: relOf(abs), title: titleOf(abs), text, chars: text.length, sha1: sha1(text),
      mtimeMs: Math.round(info.mtimeMs), size: info.size, headings: headingsOf(text), sections: sectionsOf(text) }
  }

  function resolveInside(relPath, { mustBeMarkdown = true } = {}) {
    const input = String(relPath ?? '').trim()
    if (input === '') throw new VaultError('路径为空', 'bad_path')
    if (isAbsolute(input) || /^[a-z]:/i.test(input)) throw new VaultError('只接受相对 vault 根的路径', 'bad_path')
    const normalized = normalizeVaultSubdir(input, { allowEmpty: false })
    const abs = join(root, normalized)
    // 前缀对不上有两种可能：路径本身就指向外面，或者 vault 根目录配错了
    // （例如根写成 D:\Notes\ 而笔记在 D:\Notes\专业\ 下）。
    // 两种情况以前抛同一句话，根本没法判断，这里把根目录直接说出来。
    if (abs === root || !containedBy(root, abs)) {
      throw new VaultError('找不到这篇笔记：vault 根目录是 ' + root + '，按它算出来的路径是 ' + abs
        + '。如果笔记在别的目录下，去「设置」改一下 vault 路径。', 'bad_path')
    }
    if (mustBeMarkdown && !isMarkdown(abs)) throw new VaultError('只处理 .md 笔记', 'bad_path')
    return abs
  }

  function relOf(absPath) {
    return relative(root, absPath).split(sep).join('/')
  }

  async function discover({ force = false } = {}) {
    if (!force && Date.now() - cache.at < DISCOVER_TTL_MS) return cache
    // 扫整个 vault，而不是只扫 SOP：Topics/Campaigns/Data/Products 都在别的目录，
    // 各自用一个同款 store 只换目录参数（见 index.js 的 collectionStore）。
    const scanRoot = root
    let found = []
    let source = 'fs'
    try {
      found = await walkMarkdown(scanRoot)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return { notes: [], tree: [], source: 'missing', missingDir: scanRoot }
      if (IS_MAC) {
        try {
          found = await spotlightMarkdown(scanRoot)
          source = 'spotlight'
        } catch (spotlightError) {
          throw new VaultError('列不出目录，Spotlight 也没兜住：' + describe(spotlightError), 'list_failed', { fsError: String(code ?? describe(error)) })
        }
      } else {
        throw new VaultError('列不出目录：' + describe(error), 'list_failed', { fsError: String(code ?? describe(error)) })
      }
    }

    const notes = []
    for (const abs of found) {
      if (!abs.startsWith(scanRoot + sep)) continue
      try {
        await assertInsidePath(abs)
        const info = await stat(abs)
        if (!info.isFile()) continue
        const text = await readFile(abs, 'utf8')
        remember(abs, info, noteOf(abs, text, info))
        const rel = relOf(abs)
        const group = dirname(relative(scanRoot, abs)) === '.' ? '' : dirname(relative(scanRoot, abs)).split(sep).join('/')
        notes.push({
          path: rel,
          title: titleOf(abs),
          group,
          chars: text.length,
          sections: sectionsOf(text).length,
          mtimeMs: Math.round(info.mtimeMs),
          size: info.size,
        })
      } catch {
        // 单篇读不了只丢这一篇。
      }
    }
    notes.sort((left, right) => (left.group === right.group ? left.title.localeCompare(right.title, 'zh') : left.group.localeCompare(right.group, 'zh')))
    cache = { at: Date.now(), notes, source }
    return cache
  }

  /**
   * 只列一个子目录下的 .md 相对路径，不读正文。
   *
   * discover() 会把整个 vault 的每一篇都读进内存算 sha1 和章节，代价随库线性涨；
   * 「有哪些平台版本」这种问题只需要知道 Workbench/平台版本/ 下面有哪些文件，
   * 不需要正文。目录树自己走一遍就够了，文件数少了几个数量级。
   */
  async function listUnder(relDir) {
    const rel = String(relDir ?? '').trim().replace(/\\/g, '/')
    if (rel === '') return []
    const abs = join(root, rel)
    let found = []
    try {
      found = await walkMarkdown(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') return []
      throw new VaultError('列不出目录：' + describe(error), 'list_failed')
    }
    const out = []
    for (const file of found) {
      if (!file.startsWith(root + sep)) continue
      out.push(relOf(file))
    }
    return out
  }

  /**
   * 「在 Obsidian 中打开」之前先确认文件真的在。
   * start 必然成功（它只是把 URI 交给协议处理器），所以路径对不对只能自己查。
   */
  async function exists(relPath) {
    try {
      const abs = resolveInside(relPath)
      await assertInsidePath(abs)
      const info = await stat(abs)
      return info.isFile()
    } catch {
      return false
    }
  }

  /**
   * vault 里可能有多层：用户配的根可能是 D:\Notes，而 Obsidian 真正打开的库是
   * 它下面的 D:\Notes\专业。这时把唯一确定的那层目录名拼进 file 参数，
   * Obsidian 才会按「库/文件」去找；只发文件名它会报「不确定要打开哪篇」。
   * 找到就返回嵌套的库名，找不到返回空串（沿用根目录本身的库名）。
   */
  async function nestedVaultName(relPath) {
    const wanted = String(relPath ?? '').replace(/\\/g, '/')
    if (wanted === '' || !wanted.includes('/')) return ''
    let current = root
    for (const segment of wanted.split('/').slice(0, -1)) {
      current = join(current, segment)
      if (SKIP_NAMES.has(segment) || segment.startsWith('.')) return ''
      try {
        const dot = await stat(join(current, '.obsidian'))
        if (dot.isDirectory()) return basename(current)
      } catch {
        // 这层不是库，继续往下看。
      }
    }
    return ''
  }

  /**
   * 用户配的 vault 根不一定是 Obsidian 库根：常见情况是库在 D:\Notes，
   * 工作台只扫它下面的 D:\Notes\vault。这时 basename(root) 得到的 "vault"
   * 不是任何一个库的名字，Obsidian 打开会报 URL 错误。往上找最近的 .obsidian
   * 目录，那一层才是真正的库根。
   */
  async function nearestVaultRoot(absPath) {
    let current = dirname(absPath)
    for (;;) {
      try {
        const dot = await stat(join(current, '.obsidian'))
        if (dot.isDirectory()) return current
      } catch {
        // 这层不是库，继续往上。
      }
      const parent = dirname(current)
      if (parent === current) return ''
      current = parent
    }
  }

  async function uriFor(relPath, { vaultName = '' } = {}) {
    const abs = resolveInside(relPath)
    const rel = relOf(abs)
    const explicitName = String(vaultName ?? '').trim()
    let name = explicitName
    let fileRel = rel
    if (name === '') {
      const vaultRoot = await nearestVaultRoot(abs)
      if (vaultRoot !== '') {
        name = basename(vaultRoot)
        fileRel = relative(vaultRoot, abs).split(sep).join('/')
      } else {
        name = (await nestedVaultName(rel)) || basename(root)
      }
    }
    const file = fileRel.replace(/\.md$/i, '').split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return 'obsidian://open?vault=' + encodeURIComponent(name) + '&file=' + file
  }

  /**
   * 备份落点只有这一个算法：备份目录 + 原相对路径 + .bak。
   *
   * 以前这里有三套命名：笔记写入用「备份目录/原相对路径.md.bak」、删除用
   * 「备份目录/原相对路径.md」（少了 .bak）、表格写入用「原文件旁边.md.bak」。
   * 三套并存时，恢复一份笔记得先猜它落在哪 —— 而且「原文件旁边」那份会被
   * Obsidian 当成正常笔记索引出来。
   */
  function backupPathFor(abs) {
    const rel = relOf(abs)
    return backups === '' ? abs + '.bak' : join(backups, rel + '.bak')
  }

  async function writeBackup(abs, text) {
    // 保留相对目录，A/B.md 和 A__B.md 不再争用一个恢复点。
    const keep = backupPathFor(abs)
    if (containedBy(root, keep)) await assertInsidePath(keep)
    await atomicWriteFile(keep, text)
  }

  async function readCurrent(abs) {
    try {
      const info = await stat(abs)
      const text = await readFile(abs, 'utf8')
      return { text, sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs) }
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new VaultError('读不到现有内容：' + describe(error), 'read_failed')
    }
  }

  function conflict(current, message) {
    return new VaultError(message, 'conflict', { currentSha1: current?.sha1 ?? '',
      currentMtimeMs: current?.mtimeMs ?? null, currentText: current?.text ?? '' })
  }

  async function recheck(abs, before) {
    await assertInsidePath(abs)
    const current = await readCurrent(abs)
    if (current?.sha1 !== before?.sha1) {
      throw conflict(current, '文件在提交前被别处改过，已拒绝覆盖或删除')
    }
  }

  /**
   * 目录树。scope = 'sop' 只看 SOP 目录，scope = 'vault' 看整个 vault。
   * 工作台的 SOP 入口使用前者；只有明确需要全库结构的调用方才传 vault。
   */
  async function tree({ scope = 'sop' } = {}) {
    const from = scope === 'vault' ? root : base
    async function build(dir, relDir) {
      await assertInsidePath(dir)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        if (code === 'ENOENT') return []
        throw new VaultError('列不出目录：' + describe(error), 'list_failed')
      }
      const nodes = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name) || entry.isSymbolicLink()) continue
        const rel = relDir === '' ? entry.name : relDir + '/' + entry.name
        if (entry.isDirectory()) {
          const children = await build(join(dir, entry.name), rel)
          nodes.push({ type: 'dir', name: entry.name, path: rel, children, count: countNotes(children) })
          continue
        }
        if (!isMarkdown(entry.name)) continue
        const abs = join(dir, entry.name)
        let preview = ''
        try {
          preview = previewOf(await readFile(abs, 'utf8'))
        } catch {
          preview = ''
        }
        nodes.push({ type: 'note', name: entry.name.replace(/\.md$/i, ''), path: relOf(abs), preview })
      }
      nodes.sort((left, right) => {
        if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
        return left.name.localeCompare(right.name, 'zh')
      })
      return nodes
    }
    return build(from, '')
  }

  function countNotes(nodes) {
    let total = 0
    for (const node of nodes) total += node.type === 'note' ? 1 : countNotes(node.children)
    return total
  }

  async function readStoredNote(relPath, useSnapshot) {
    const abs = resolveInside(relPath)
    await assertInsidePath(abs)
    try {
      const info = await stat(abs)
      if (!info.isFile()) throw new VaultError('笔记不存在：' + relPath, 'not_found')
      const cached = noteSnapshots.get(abs)
      if (useSnapshot && cached !== undefined && cached.mtimeMs === info.mtimeMs
        && cached.ctimeMs === info.ctimeMs && cached.size === info.size) return { ...cached.note }
      const text = await readFile(abs, 'utf8')
      const note = noteOf(abs, text, info)
      remember(abs, info, note)
      return note
    } catch (error) {
      if (error instanceof VaultError) throw error
      if (error?.code === 'ENOENT') throw new VaultError('笔记不存在：' + relPath, 'not_found')
      throw new VaultError('读不到笔记：' + describe(error), 'read_failed')
    }
  }

  // 详情/写前读取始终读事实源；列表可复用刚发现的内容，仍逐篇核对完整 stat。
  async function readNote(relPath) { return readStoredNote(relPath, false) }
  async function readCachedNote(relPath) { return readStoredNote(relPath, true) }

  async function writeNote(relPath, text, { expectedSha1 } = {}) {
    const abs = resolveInside(relPath)
    return withFileWriteLock(abs, async () => {
      await assertInsidePath(abs)
      const before = await readCurrent(abs)
      if (typeof expectedSha1 === 'string' && expectedSha1 !== '' && before?.sha1 !== expectedSha1) {
        throw conflict(before, '文件在别处被改过了（多半是 Obsidian 里刚保存），已拒绝写入')
      }
      if (before !== null) {
        try { await writeBackup(abs, before.text) } catch (error) {
          throw new VaultError('备份失败，已放弃写入：' + describe(error), 'backup_failed')
        }
      }
      try {
        await atomicWriteFile(abs, text, { beforeCommit: () => recheck(abs, before) })
      } catch (error) {
        if (error instanceof VaultError) throw error
        throw new VaultError('写入失败，原文件未改动：' + describe(error), 'write_failed')
      }
      invalidate()
      const info = await stat(abs)
      return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
    })
  }

  async function createNote(relPath, text) {
    const abs = resolveInside(relPath)
    return withFileWriteLock(abs, async () => {
      await assertInsidePath(abs)
      await mkdir(dirname(abs), { recursive: true })
      await assertInsidePath(abs)
      try {
        await writeFile(abs, text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code === 'EEXIST') throw new VaultError('同名笔记已存在：' + relPath, 'exists')
        throw new VaultError('新建失败：' + describe(error), 'write_failed')
      }
      invalidate()
      const info = await stat(abs)
      return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
    })
  }

  /**
   * 删除一篇笔记。和写入一样守纪律：先读旧文件算 sha1，
   * 调用方带回的 expectedSha1 对不上就拒绝（说明别处改过，删掉会丢内容）。
   * 真删之前先留一份 .bak 在备份目录里，删错了还能捞回来。
   */
  async function deleteNote(relPath, { expectedSha1 } = {}) {
    const abs = resolveInside(relPath)
    return withFileWriteLock(abs, async () => {
      await assertInsidePath(abs)
      const before = await readCurrent(abs)
      if (before === null) throw new VaultError('笔记不存在：' + relPath, 'not_found')
      if (typeof expectedSha1 === 'string' && expectedSha1 !== '' && expectedSha1 !== before.sha1) {
        throw conflict(before, '这篇在别处被改过（Obsidian 里？），刷新后再删')
      }
      const keep = backupPathFor(abs)
      try {
        if (containedBy(root, keep)) await assertInsidePath(keep)
        await atomicWriteFile(keep, before.text)
      } catch (error) {
        throw new VaultError('备份失败，已放弃删除（原笔记还在）：' + describe(error), 'backup_failed')
      }
      await recheck(abs, before)
      try { await unlink(abs) } catch (error) {
        throw new VaultError('删除失败：' + describe(error), 'delete_failed')
      }
      invalidate()
      return { path: relPath, deleted: true, keep }
    })
  }

  async function search(query, { limit = 60 } = {}) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') return []
    const { notes } = await discover()
    const matches = []
    for (const note of notes) {
      let text
      try {
        text = await readFile(join(root, note.path), 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue
        matches.push({
          path: note.path,
          title: note.title,
          group: note.group,
          line: index + 1,
          snippet: lines[index].trim().slice(0, 220),
        })
        if (matches.length >= limit) return matches
      }
    }
    return matches
  }

  return {
    root,
    base,
    discover,
    readNote,
    readCachedNote,
    listUnder,
    assertInsidePath,
    backupPathFor,
    writeNote,
    createNote,
    deleteNote,
    search,
    exists,
    headingsOf,
    sectionsOf,
    tree,
    uriFor,
    invalidate,
  }
}
