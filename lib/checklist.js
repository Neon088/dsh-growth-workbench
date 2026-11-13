/**
 * 发布前自检清单。
 *
 * 唯一真源是 vault 里 SOP 那份《发布前检查清单.md》——用户在 Obsidian 里改
 * 清单，工具这边立刻跟着变。以前清单硬编码在 client.js 的 PUBLISH_CHECKS 里，
 * SOP 和产品各写一份，两份必然对不上（当时 SOP 6 条、产品 7 项，措辞完全不同）。
 *
 * 这里只做「读懂那份 Markdown」这一件事，不碰网络、不碰文件写入。
 * 清单项用「条目文本的哈希」当 id：条目顺序变了、作者在中间插了一条，
 * 之前勾过的项不会莫名其妙跑位；但作者真改了某一条的措辞，那一条的勾会失效，
 * 需要重新过一遍 —— 这是想要的行为（清单变了就该重看）。
 */
import { createHash } from 'node:crypto'

// 标题里带这几个字的文件就算发布前检查清单。找文件而不是写死完整路径：
// 用户把 SOP 挪个目录、换个名字都不该让清单失联。
export const CHECKLIST_TITLE_HINTS = ['发布前检查清单', '发布检查清单', '发布前清单']

const ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const SKIP_PATTERN = /^\s*(?:#|>|```|\||---)/

export function checklistItemId(text) {
  return createHash('sha1').update(String(text ?? '').trim()).digest('hex').slice(0, 8)
}

/**
 * 把一份 Markdown 清单读成条目数组。
 * 标题、引用、表格、代码块都不算条目 —— 「> 发布后 3~7 天数据稳定」是说明，
 * 不是一条要勾的自检项。
 */
export function parseChecklist(markdown) {
  const items = []
  const seen = new Set()
  // 代码块里的列表是示例，不是要勾的自检项。以前只跳过围栏行本身，
  // 围栏里的 `- 示例` 会被当成真条目混进发布门槛。
  let fence = ''
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0]
      if (fence === '') fence = marker
      else if (fence === marker) fence = ''
      continue
    }
    if (fence !== '') continue
    if (SKIP_PATTERN.test(line)) continue
    const match = ITEM_PATTERN.exec(line)
    if (match === null) continue
    // 兼容 Markdown 任务列表：`- [ ] 标题…` / `- [x] 标题…`。
    // 不剥掉方括号的话，界面上会出现一个“条目前面自带空框”的自检项。
    const text = match[1].replace(/^\s*\[[ xX✓✔]\]\s*/, '').replace(/\s*$/, '').trim()
    if (text === '') continue
    const id = checklistItemId(text)
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ id, text })
  }
  return items
}

/** 笔记正文里勾掉的自检项（frontmatter.publishCheckItems，逗号分隔的 id）。 */
export function checkedIdsOf(front) {
  const raw = String(front?.publishCheckItems ?? '')
  const out = []
  for (const part of raw.split(/[,;\s]+/)) {
    const id = part.trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 勾选进度。清单为空（文件没找到）时 total = 0，
 * 调用方要按「清单不可用」处理，不能当成「全勾了」。
 */
export function checklistState(front, items) {
  const list = Array.isArray(items) ? items : []
  const checked = new Set(checkedIdsOf(front))
  const done = list.filter((item) => checked.has(item.id)).length
  const total = list.length
  return {
    items: list,
    total,
    done,
    ratio: total === 0 ? '' : done + '/' + total,
    complete: total > 0 && done === total,
    missing: total === 0,
    checkedIds: list.filter((item) => checked.has(item.id)).map((item) => item.id),
  }
}

/** 把勾选结果写回 frontmatter 补丁。 */
export function checklistPatch(items, checkedIds) {
  const list = Array.isArray(items) ? items : []
  const wanted = new Set((Array.isArray(checkedIds) ? checkedIds : []).map((id) => String(id)))
  const valid = list.filter((item) => wanted.has(item.id)).map((item) => item.id)
  return {
    publishCheckItems: valid.join(','),
    publishCheck: list.length === 0 ? '' : valid.length + '/' + list.length,
  }
}
