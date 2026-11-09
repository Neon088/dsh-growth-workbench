// 把 client.js 里的 CSS 抠出来，拼一个跨板块的最小复现页：
// 内容日历的行、商品档案的行、反馈表（紧凑/宽）、语调库表。
// 只做验证用，不参与插件运行。量「有没有东西越过容器右边界」。
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const marker = 'const CSS = `'
const start = src.indexOf(marker)
if (start < 0) throw new Error('CSS block not found')
const from = start + marker.length
const end = src.indexOf('`', from)
const css = src.slice(from, end)

const WIDTHS = process.argv[2] ? process.argv[2].split(',').map(Number) : [300, 360, 420, 560, 720]

// ── A. 内容日历：选中某天的排期行 ────────────────────────────────
const calRow = (w) => `
<div class="dsh-gw-row dsh-gw-cal-row" style="width:${w}px">
  <span class="dsh-gw-cal-tag" data-status="done">已发</span>
  <span class="dsh-gw-row-main">小红书 · 用快剪把面料剪开给你看
    <div class="dsh-gw-row-meta">选题 2026/选题-a.md</div>
  </span>
  <div class="dsh-gw-cal-ctrls">
    <select style="font-size:12px;border-radius:6px;border:1px solid #333438;background:#1c1d20;color:#e6e6e6">
      <option>已排期</option><option>已发</option>
    </select>
    <button class="dsh-gw-row-act" title="改平台">小红书</button>
    <select style="font-size:11.5px;max-width:150px;border-radius:6px;border:1px solid #333438;background:#1c1d20;color:#e6e6e6">
      <option>用快剪把面料剪开给你看</option>
    </select>
    <button class="dsh-gw-ibtn" data-tone="danger" title="删掉这条排期">✕</button>
  </div>
</div>`

// ── B. 商品档案：列表行 ────────────────────────────────────────
const prodRow = (w) => `
<div class="dsh-gw-row" style="width:${w}px">
  <input type="checkbox">
  <div class="dsh-gw-row-main">
    <div class="dsh-gw-row-title"><span class="dsh-gw-row-name">冰丝阔腿裤 夏季薄款垂感高腰</span></div>
    <div class="dsh-gw-row-meta">价格 89 · 小红书 · 自家</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex:none">
    <span class="dsh-gw-pill" data-tone="warn">竞品</span>
    <button class="dsh-gw-row-act" title="用它排一条带货内容">做内容</button>
  </div>
</div>`

// ── C. 反馈表 ──────────────────────────────────────────────────
const fbTable = (w, compact) => {
  const cols = compact
    ? [['c-body', 38], ['c-fix', 22], ['c-fix', 16], ['c-state', 14], ['c-act', 10]]
    : [['c-date', 8], ['c-channel', 10], ['c-mood', 8], ['c-body', 30], ['c-tags', 11], ['c-fix', 11], ['c-fix', 11], ['c-state', 7], ['c-act', 5]]
  const head = compact
    ? ['原文', '处理意见', '处理结果', '状态', '']
    : ['日期', '渠道', '情感', '原文', '标签', '处理意见', '处理结果', '状态', '']
  const actCell = `<td style="white-space:nowrap"><div class="dsh-gw-acts" style="opacity:1"><button class="dsh-gw-ibtn dsh-gw-row-del" data-tone="danger" title="删除">✕</button></div></td>`
  const body = compact
    ? `<td>快递太慢了，三天还没到，客服也不回消息</td><td>先道歉再补发</td><td>已补发</td><td><select class="dsh-gw-fb-state" data-state="跟进中"><option>跟进中</option></select></td>${actCell}`
    : `<td>11-06</td><td>小红书</td><td><span class="dsh-gw-pill" data-tone="error">负</span></td><td>快递太慢了，三天还没到</td><td><span class="dsh-gw-pill">物流</span></td><td>先道歉再补发</td><td>已补发</td><td><select class="dsh-gw-fb-state" data-state="跟进中"><option>跟进中</option></select></td>${actCell}`
  return `<div class="dsh-gw-tablebox" style="width:${w}px">
    <table class="dsh-gw-table dsh-gw-fb-table${compact ? ' dsh-gw-fb-compact' : ''}">
      <colgroup>${cols.map(([n, p]) => `<col class="${n}" style="width:${p}%">`).join('')}</colgroup>
      <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody><tr>${body}</tr></tbody>
    </table></div>`
}

// ── D. 语调库表 ────────────────────────────────────────────────
const glossTable = (w, widths = [12, 14, 16, 16, 32, 10]) => {
  const cols = ['c-domain', 'c-tags', 'c-zh', 'c-en', 'c-note', 'c-act']
  const cells = ['护肤', '成分, 功效', '早C晚A', 'skin cycling', '只在有依据时使用']
  return `<div class="dsh-gw-tablebox" style="width:${w}px">
    <table class="dsh-gw-table dsh-gw-gloss-table">
      <colgroup>${cols.map((n, i) => `<col class="${n}" style="width:${widths[i]}%">`).join('')}</colgroup>
      <thead><tr>${['领域', '标签', '中文', '英文', '备注'].map((h) => `<th>${h}</th>`).join('')}<th></th></tr></thead>
      <tbody><tr>${cells.map((c) => `<td>${c}</td>`).join('')}<td><div class="dsh-gw-acts" style="opacity:1"><button class="dsh-gw-ibtn dsh-gw-row-del" data-tone="danger" title="删除">✕</button></div></td></tr></tbody>
    </table></div>`
}

const block = (title, w, html) =>
  `<div class="box" data-case="${title}" data-w="${w}"><b>${title} · ${w}px</b>${html}</div>`

const blocks = []
for (const w of WIDTHS) {
  blocks.push(block('cal-row', w, `<div class="dsh-gw-pane">${calRow(w)}</div>`))
  blocks.push(block('prod-row', w, `<div class="dsh-gw-pane">${prodRow(w)}</div>`))
  blocks.push(block('fb-compact', w, `<div class="dsh-gw-pane">${fbTable(w, true)}</div>`))
  blocks.push(block('fb-wide', w, `<div class="dsh-gw-pane">${fbTable(w, false)}</div>`))
  blocks.push(block('gloss', w, `<div class="dsh-gw-pane">${glossTable(w)}</div>`))
}

const html = `<!doctype html><meta charset="utf-8">
<style>
:root{--dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#9aa0a6;--dsw-alias-label-tertiary:#6b7075;
--dsw-alias-bg-base:#17181a;--dsw-alias-bg-layer-1:#1c1d20;--dsw-alias-bg-layer-2:#212226;--dsw-alias-bg-layer-3:#26272b;
--dsw-alias-border-l1:#2a2b2f;--dsw-alias-border-l2:#333438;--dsw-alias-border-l3:#3d3e43;
--dsw-alias-link:#4d6bfe;--dsw-alias-state-warn-primary:#f5a524;--dsw-alias-state-success-primary:#3ecf8e;--dsw-alias-state-error-primary:#e5484d;
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);--dsw-alias-brand-primary:#0f1115}
body{margin:0;padding:12px;background:#111213;font-family:"Microsoft YaHei",system-ui,sans-serif}
.stage{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.box{border:1px dashed #4a4b50;padding:4px}
.box>b{display:block;color:#888;font:11px/1.6 monospace;margin-bottom:4px}
${css}
</style>
<div class="stage">${blocks.join('')}</div>`

const out = new URL('./boards-preview.html', import.meta.url)
fs.writeFileSync(out, html)
console.log('wrote', out.pathname, 'css', css.length, 'chars')
