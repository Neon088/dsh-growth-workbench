/**
 * 对话侧工具：把「写回」变成 agent 真能调用的东西。
 *
 * 之前只有提示词里那句「改完请用工作台写回」，agent 能不能照做全看它有没有读懂 ——
 * 这不是契约。这里注册一个真正的工具，agent 可以直接列板块、读笔记、写回，
 * 走的是和界面完全相同的 vault 路径（sha1 校验、.backups 备份、冲突拒绝全都在）。
 *
 * 拿到 ctx 的方式：插件本身只 inject 了 webServer，所以这里用 ctx.inject(['tools'])
 * 拿一个子 context —— 宿主没装 tools 服务时这个 fiber 不会激活，插件其余部分照常工作。
 */

const BS = String.fromCharCode(92)

import { sectionsOf } from './vault.js'

/** 能按 collection 语义（带 frontmatter schema）读写的板块。其余目录一律走通用路径。 */
const COLLECTION_BOARDS = new Set(['topics', 'campaigns', 'products', 'data'])

/**
 * create 允许落到的板块。必须是白名单，不能是「不是空就不是 sop」：
 * board 是外面传进来的字符串，`constructor` / `toString` 会命中普通对象原型链上的属性，
 * 取到没有 .schema 的东西，目录取空串，最后落到 vault 根目录建笔记。
 */
const KNOWN_BOARDS = new Set(['topics', 'campaigns', 'products', 'data'])

/**
 * 文件夹名 → 板块 id。agent 手上常常只有路径，两头都要能对上。
 *
 * 只有真带 collection 的板块才返回；CopyRules / Feedback / Calendar 这些
 * 由表格或纯文本承载的目录必须返回空串，让调用方走 ensureNote 通用写入。
 * （之前把 CopyRules 也算成板块，于是 collections['copyrules'] 是 undefined，
 *   写 frontmatter 时崩在 undefined.update。）
 */
function boardOfPath(relPath, dirs) {
  const head = String(relPath ?? '').replace(new RegExp(`^[./${BS}${BS}]+`), '').split('/')[0]
  if (head === '') return ''
  for (const [id, dir] of Object.entries(dirs)) {
    if (!COLLECTION_BOARDS.has(id)) continue
    if (dir !== '' && dir === head) return id
  }
  return ''
}

/**
 * 造一份工具定义。不依赖 defineTool：宿主里 dsh-tools 是外部包，
 * 直接给普通对象字面量也能注册（git-graph 就是这么做的），少一个运行时依赖。
 */
/**
 * 只替换某个标题下的内容，保留标题行本身。
 * heading 匹配：精确等于，或（allowPrefix）以它开头 —— agent 不必逐字抄准「## 硬规则（不可破）」这种带后缀的标题。
 * 找不到时按 appendIfMissing 决定是报错还是加在末尾，绝不整篇重写。
 */
export function replaceSectionText(body, heading, markdown, { allowPrefix = true, appendIfMissing = false } = {}) {
  const source = String(body ?? '')
  const lines = source.split(/\r?\n/)
  const want = String(heading ?? '').trim()
  if (want === '') return { ok: false, code: 'bad_request', message: 'replaceSection 需要 heading。' }
  const target = want.replace(/^#+\s*/, '').trim()
  const sections = sectionsOf(source)
  const hit = sections.find((section) => {
    const title = String(section.title ?? '').trim()
    if (title === target) return true
    return allowPrefix && target !== '' && title.startsWith(target)
  })
  if (hit === undefined) {
    if (!appendIfMissing) {
      return {
        ok: false,
        code: 'no_section',
        message: '这篇笔记里没有标题「' + target + '」。现有标题：' + sections.map((section) => section.title).join(' / ') + '。要新建一节就把 appendIfMissing 设成 true，或者用 append。',
      }
    }
    const base = source.replace(/\s+$/, '')
    const next = (base === '' ? '' : base + '\n\n') + '## ' + target + '\n\n' + String(markdown ?? '').replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
    return { ok: true, text: next, heading: target, added: true }
  }
  const from = hit.fromLine - 1
  const to = Math.max(from + 1, (Number.isFinite(hit.toLine) ? hit.toLine : lines.length))
  const inside = String(markdown ?? '').replace(/^\s+/, '').replace(/\s+$/, '')
  // sectionsOf 的 fromLine 指的是标题行本身，替换要从标题下一行开始，标题留着。
  const replacement = inside === '' ? [] : ['', ...inside.split(/\r?\n/), '']
  const next = [...lines.slice(0, from + 1), ...replacement, ...lines.slice(to)]
  return {
    ok: true,
    text: next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n',
    heading: target,
    added: false,
  }
}

export function buildVaultTool(deps) {
  const { boards, dirs, readNote, listRecords, updateRecord, ensureNote, listSop, vaultRoot } = deps

  return {
    name: 'growth_vault',
    description: [
      'Read and write notes in the user\'s Obsidian vault through the growth workbench (增长工作台).',
      'boards lists every board with its folder and note count.',
      'list returns the notes of one board (path, title, frontmatter fields, short preview).',
      'read returns the full markdown and sha1 of one note.',
      'write saves new markdown back to one note. ALWAYS pass expectedSha1 from read: if the file changed since you read it the write is refused with a conflict instead of overwriting the user\'s edit.',
      'append adds a section to the end of the body without touching the frontmatter; setFront merges fields into the frontmatter only.',
      'replaceSection rewrites ONLY the content under one heading and keeps that heading line and every other section untouched — use it for templates with fixed sections (硬规则 / 软规则 / 待观察) instead of write, which replaces the whole body.',
      'create makes a new note on a board; sop appends a new SOP note.',
      'Before writing or revising copy (文案 / 标题 / 口播), read CopyRules/rules.md first: it holds the 文案规则 / 语调库 — banned absolute claims, required evidence, tone — and those rules beat your own instinct.',
      'Prefer append/setFront/replaceSection over write: the user reads these notes in the workbench and will notice a rewritten body.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['boards', 'list', 'read', 'write', 'append', 'replaceSection', 'setFront', 'create', 'sop'],
          description: 'Which operation to perform.',
        },
        board: {
          type: 'string',
          description: 'Board id (topics / campaigns / products / data) for list and create; also accepted as a folder prefix when resolving path.',
        },
        path: {
          type: 'string',
          description: 'Vault-relative path of the note, e.g. "Topics/爆款拆解.md". Required for read, write, append and setFront.',
        },
        markdown: {
          type: 'string',
          description: 'write: the complete new markdown (frontmatter included). append: the section to add. replaceSection: the new content for one heading (the heading line itself is kept; empty string deletes the section body). create/sop: the initial markdown (a template is used when omitted).',
        },
        heading: {
          type: 'string',
          description: 'replaceSection: which heading to rewrite, without the leading #. Exact match wins; otherwise the first heading that starts with this text is used. Use list/read first to see the actual headings.',
        },
        appendIfMissing: {
          type: 'boolean',
          description: 'replaceSection: when the heading does not exist, add it at the end of the body instead of failing. Default false.',
        },
        front: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          description: 'setFront/create: frontmatter fields to merge, e.g. {"views": 12000, "likes": 300}.',
        },
        expectedSha1: {
          type: 'string',
          description: 'The sha1 returned by read. Strongly recommended for write/append/setFront: it turns a race into a clean conflict error.',
        },
        title: {
          type: 'string',
          description: 'create/sop: note title (also used for the file name).',
        },
        directory: {
          type: 'string',
          description: 'create/sop: sub folder inside the board (or inside the SOP folder). Empty means the top level.',
        },
        limit: {
          type: 'number',
          description: 'list: maximum notes to return (default 40, max 200).',
        },
        done: {
          type: 'boolean',
          description: 'append/write/setFront: mark the note as finished (adds status: 待回填 to the frontmatter). Default false.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30_000,
    async execute(args) {
      const input = typeof args === 'object' && args !== null ? args : {}
      const action = String(input.action ?? '')
      const root = vaultRoot()
      if (root === '') {
        return { ok: false, code: 'no-vault', message: '工作台还没配置 vault 根目录，先在右侧面板里填一下。' }
      }
      const mention = (file) => ({ file: 'file:' + String(file).split(BS).join('/') })

      try {
        if (action === 'boards') {
          return { ok: true, vaultRoot: root, boards: await boards() }
        }

        if (action === 'list') {
          const board = String(input.board ?? '').trim()
          const limit = Math.min(Math.max(Number(input.limit ?? 40) || 40, 1), 200)
          if (board === '' || board === 'sop') {
            const notes = await listSop(limit)
            return { ok: true, board: 'sop', records: notes }
          }
          const records = await listRecords(board, limit)
          return { ok: true, board, records }
        }

        if (action === 'read') {
          const note = await readNote(input.path)
          return { ok: true, path: note.path, sha1: note.sha1, title: note.title, front: note.front, markdown: note.text }
        }

        if (action === 'write' || action === 'append' || action === 'replaceSection' || action === 'setFront') {
          if (typeof input.path !== 'string' || input.path.trim() === '') {
            return { ok: false, code: 'bad_path', message: action + ' 需要 path。' }
          }
          const current = await readNote(input.path)
          const expectedSha1 = String(input.expectedSha1 ?? '').trim()
          if (expectedSha1 !== '' && expectedSha1 !== current.sha1) {
            return {
              ok: false,
              code: 'conflict',
              message: '这篇笔记在 read 之后被改过了（可能是用户在 Obsidian 或工作台里改的）。重新 read 一次再改。',
              currentSha1: current.sha1,
              currentMtimeMs: current.mtimeMs,
            }
          }
          const board = boardOfPath(current.path, dirs)
          const useCollection = board !== '' && typeof updateRecord === 'function'
          const patch = {
            ...(board === '' ? {} : { front: input.front }),
            ...(input.done === true ? { front: { ...(input.front ?? {}), status: '待回填' } } : {}),
          }
          if (action === 'write' && input.done === true) {
            // write 是整篇替换：五段拆解和 platform/date/views 全会被 text 冲掉，
            // 只留下一个 status。改状态用 setFront，别用 write + done。
            return {
              ok: false,
              code: 'bad_request',
              message: 'write 是整篇替换，不能和 done 一起用。只想把状态改成「待回填」请用 setFront（front: { status: "待回填" }）。',
            }
          }
          if (action === 'setFront') {
            if (input.front === undefined || input.front === null || Object.keys(input.front).length === 0) {
              return { ok: false, code: 'bad_request', message: 'setFront 需要 front（要合并的字段）。' }
            }
            const written = useCollection
              ? await updateRecord(board, current.path, { front: input.front, expectedSha1: current.sha1 })
              : await ensureNote(current.path, { front: input.front, expectedSha1: current.sha1 })
            return { ok: true, ...written, ...mention(current.path) }
          }
          const body = String(input.markdown ?? '')
          if (action === 'append') {
            if (body.trim() === '') return { ok: false, code: 'bad_request', message: 'append 需要 markdown（要追加的内容）。' }
            const base = current.body.replace(/\s+$/, '')
            const merged = (base === '' ? '' : base + '\n\n') + body.replace(/^\s+/, '')
            const written = await ensureNote(current.path, {
              body: merged,
              ...(patch.front === undefined ? {} : { front: patch.front }),
              expectedSha1: current.sha1,
            })
            return { ok: true, ...written, action: 'append', ...mention(current.path) }
          }
          if (action === 'replaceSection') {
            const sectioned = replaceSectionText(current.body, input.heading, body, {
              appendIfMissing: input.appendIfMissing === true,
            })
            if (sectioned.ok !== true) return sectioned
            const written = await ensureNote(current.path, {
              body: sectioned.text,
              ...(patch.front === undefined ? {} : { front: patch.front }),
              expectedSha1: current.sha1,
            })
            return {
              ok: true,
              ...written,
              action: 'replaceSection',
              heading: sectioned.heading,
              added: sectioned.added,
              ...mention(current.path),
            }
          }
          // write：整篇替换。带 front 时只换正文，避免把 frontmatter 写坏。
          const written = await ensureNote(current.path, {
            text: body,
            ...(patch.front === undefined ? {} : { front: patch.front }),
            expectedSha1: current.sha1,
          })
          return { ok: true, ...written, action: 'write', ...mention(current.path) }
        }

        if (action === 'create') {
          const board = String(input.board ?? '').trim()
          // 白名单：以前只判 board === ''/'sop'，board:'constructor' 会走到
          // collections['constructor']（函数，.schema 为 undefined）→ 目录取到空串 →
          // 直接在 vault 根目录建出一篇游离笔记，污染 discover 和按标题回退。
          if (board !== '' && board !== 'sop' && !KNOWN_BOARDS.has(board)) {
            return { ok: false, code: 'bad_request', message: '不认识的 board：' + board + '。可用：' + [...KNOWN_BOARDS, 'sop'].join(' / ') }
          }
          if (board === '' || board === 'sop') {
            if (typeof input.title !== 'string' || input.title.trim() === '') {
              return { ok: false, code: 'bad_request', message: 'create 需要 title 或 board。' }
            }
            const created = await listSop(-1, { create: true, title: input.title, directory: input.directory, markdown: input.markdown })
            return { ok: true, ...created }
          }
          const created = await listRecords(board, 0, { create: true, title: input.title, directory: input.directory, markdown: input.markdown, front: input.front })
          return { ok: true, ...created }
        }

        return { ok: false, code: 'bad_action', message: '不认识的 action：' + action }
      } catch (error) {
        return {
          ok: false,
          code: String(error?.code ?? 'failed'),
          message: String(error?.message ?? error),
          ...(error?.extra !== null && typeof error?.extra === 'object' ? error.extra : {}),
        }
      }
    },
  }
}

/**
 * 挂上工具。宿主没有 tools 服务时什么都不做 —— 插件不能因为这一块起不来。
 * 返回的 dispose 只是形式上的，真正的生命周期由 ctx.effect / ctx.inject 管。
 */
export function registerVaultTool(ctx, deps, logger) {
  if (ctx === null || typeof ctx !== 'object') return () => {}
  const hasInject = typeof ctx.inject === 'function'
  const bind = (toolCtx) => {
    try {
      const registered = toolCtx.tools.register(buildVaultTool(deps))
      logger.info?.('growth_vault tool registered')
      return registered
    } catch (error) {
      logger.warn?.('growth_vault tool 注册失败：' + String(error?.message ?? error))
      return undefined
    }
  }
  try {
    if (hasInject) {
      const fiber = ctx.inject(['tools'], (toolCtx) => {
        if (typeof toolCtx.effect === 'function') toolCtx.effect(() => bind(toolCtx), 'growth: growth_vault tool')
        else bind(toolCtx)
      })
      return () => { try { fiber?.dispose?.() } catch {} }
    }
    if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') return () => bind(ctx)
  } catch (error) {
    logger.warn?.('growth_vault tool 挂载失败：' + String(error?.message ?? error))
  }
  return () => {}
}
