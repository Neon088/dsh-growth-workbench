/**
 * vault 直连：Obsidian 的 md 笔记就是工作台的唯一事实源。
 * 移植自 dsh-legal-workbench/lib/vault.js（MIT），改动：
 *   · Spotlight 兜底只在 macOS 保留（win/linux 直接走 fs 枚举）；
 *   · openCommand 由调用方按平台决定。
 * 写入纪律：写前读旧文件算 sha1，调用方带回的 expectedSha1 对不上就拒绝写；
 * 先留 .bak 再临时文件 + rename，任何一步失败原文件不动。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

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
    if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
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
  const root = normalize(vaultRoot)
  const base = join(root, sopDir)
  const backups = backupDir === '' ? '' : normalize(backupDir)
  let cache = { at: 0, notes: [], source: 'none' }

  function resolveInside(relPath, { mustBeMarkdown = true } = {}) {
    const input = String(relPath ?? '').trim()
    if (input === '') throw new VaultError('路径为空', 'bad_path')
    if (isAbsolute(input)) throw new VaultError('只接受相对 vault 根的路径', 'bad_path')
    const normalized = normalize(input)
    if (normalized.startsWith('..') || normalized.includes('..' + sep)) {
      throw new VaultError('路径里不能有 ..：' + input, 'bad_path')
    }
    const abs = join(root, normalized)
    // 前缀对不上有两种可能：路径本身就指向外面，或者 vault 根目录配错了
    // （例如根写成 D:\Notes\ 而笔记在 D:\Notes\专业\ 下）。
    // 两种情况以前抛同一句话，根本没法判断，这里把根目录直接说出来。
    if (!abs.startsWith(root + sep)) {
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
        const info = await stat(abs)
        if (!info.isFile()) continue
        const text = await readFile(abs, 'utf8')
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
   * 「在 Obsidian 中打开」之前先确认文件真的在。
   * start 必然成功（它只是把 URI 交给协议处理器），所以路径对不对只能自己查。
   */
  async function exists(relPath) {
    try {
      const info = await stat(resolveInside(relPath))
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

  async function writeBackup(abs, text) {
    if (backups === '') {
      await copyFile(abs, abs + '.bak')
      return
    }
    await mkdir(backups, { recursive: true })
    const name = relative(root, abs).split(sep).join('__') + '.bak'
    await writeFile(join(backups, name), text, 'utf8')
  }

  /**
   * 目录树。scope = 'sop' 只看 SOP 目录，scope = 'vault' 看整个 vault。
   * 工作台默认用后者：vault 里现成的笔记目录才是用户想翻的东西，
   * 而 SOP/ 往往是还没写东西的空目录。
   */
  async function tree({ scope = 'sop' } = {}) {
    const from = scope === 'vault' ? root : base
    async function build(dir, relDir) {
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
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
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

  async function readNote(relPath) {
    const abs = resolveInside(relPath)
    let info
    try {
      info = await stat(abs)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw new VaultError('笔记不存在：' + relPath, 'not_found')
      throw new VaultError('读不到笔记：' + describe(error), 'read_failed')
    }
    const text = await readFile(abs, 'utf8')
    return {
      path: relOf(abs),
      title: titleOf(abs),
      text,
      chars: text.length,
      sha1: sha1(text),
      mtimeMs: Math.round(info.mtimeMs),
      size: info.size,
      headings: headingsOf(text),
      sections: sectionsOf(text),
    }
  }

  async function writeNote(relPath, text, { expectedSha1 } = {}) {
    const abs = resolveInside(relPath)
    let current = null
    let currentMtime = null
    try {
      const info = await stat(abs)
      currentMtime = Math.round(info.mtimeMs)
      current = await readFile(abs, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw new VaultError('写前读不到现有内容：' + describe(error), 'read_failed')
    }
    if (current !== null && typeof expectedSha1 === 'string' && expectedSha1 !== '' && sha1(current) !== expectedSha1) {
      // 冲突出在这里。要把「对方现在长什么样」一并带出去：前端拿不到最新内容，
      // 就只能给用户一句报错，没法让人在「用我的 / 用他的」之间做选择。
      throw new VaultError('文件在别处被改过了（多半是 Obsidian 里刚保存），已拒绝写入', 'conflict', {
        currentSha1: sha1(current),
        currentMtimeMs: currentMtime,
        currentText: current,
      })
    }
    await mkdir(dirname(abs), { recursive: true })
    if (current !== null) {
      try {
        await writeBackup(abs, current)
      } catch (error) {
        throw new VaultError('备份失败，已放弃写入：' + describe(error), 'backup_failed')
      }
    }
    const temp = abs + '.tmp-' + process.pid
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, abs)
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        // 临时文件可能压根没建出来。
      }
      throw new VaultError('写入失败，原文件未改动：' + describe(error), 'write_failed')
    }
    cache.at = 0
    const info = await stat(abs)
    return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
  }

  async function createNote(relPath, text) {
    const abs = resolveInside(relPath)
    try {
      await stat(abs)
      throw new VaultError('同名笔记已存在：' + relPath, 'exists')
    } catch (error) {
      if (error instanceof VaultError) throw error
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') throw new VaultError('检查同名笔记失败：' + describe(error), 'stat_failed')
    }
    await mkdir(dirname(abs), { recursive: true })
    try {
      await writeFile(abs, text, 'utf8')
    } catch (error) {
      throw new VaultError('新建失败：' + describe(error), 'write_failed')
    }
    cache.at = 0
    const info = await stat(abs)
    return { path: relOf(abs), sha1: sha1(text), mtimeMs: Math.round(info.mtimeMs), size: info.size }
  }

  /**
   * 删除一篇笔记。和写入一样守纪律：先读旧文件算 sha1，
   * 调用方带回的 expectedSha1 对不上就拒绝（说明别处改过，删掉会丢内容）。
   * 真删之前先留一份 .bak 在备份目录里，删错了还能捞回来。
   */
  async function deleteNote(relPath, { expectedSha1 } = {}) {
    const abs = resolveInside(relPath)
    let current
    try {
      current = await readFile(abs, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'ENOENT') throw new VaultError('笔记不存在：' + relPath, 'not_found')
      throw new VaultError('读不到要删的笔记：' + describe(error), 'read_failed')
    }
    const digest = sha1(current)
    if (typeof expectedSha1 === 'string' && expectedSha1 !== '' && expectedSha1 !== digest) {
      throw new VaultError('这篇在别处被改过（Obsidian 里？），刷新后再删', 'conflict')
    }
    if (backups !== '') {
      try {
        const keep = join(backups, relPath)
        await mkdir(dirname(keep), { recursive: true })
        await copyFile(abs, keep)
      } catch (error) {
        // 留不下备份就别删：删完就没得找了。
        throw new VaultError('备份失败，已放弃删除（原笔记还在）：' + describe(error), 'backup_failed')
      }
    }
    try {
      await unlink(abs)
    } catch (error) {
      throw new VaultError('删除失败：' + describe(error), 'delete_failed')
    }
    cache.at = 0
    return { path: relPath, deleted: true, keep: backups === '' ? '' : join(backups, relPath) }
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
    writeNote,
    createNote,
    deleteNote,
    search,
    exists,
    headingsOf,
    sectionsOf,
    tree,
    uriFor,
    invalidate() {
      cache.at = 0
    },
  }
}
