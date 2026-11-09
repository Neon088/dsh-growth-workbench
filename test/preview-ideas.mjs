// 把 client.js 里的 CSS 抠出来，拼一个最小复现页，用于在真浏览器里量宽度。
// 只做验证用，不参与插件运行。
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const marker = 'const CSS = `'
const start = src.indexOf(marker)
if (start < 0) throw new Error('CSS block not found')
const from = start + marker.length
// CSS 里不会出现裸反引号（模板串本身），遇到第一个反引号就是结尾。
const end = src.indexOf('`', from)
const css = src.slice(from, end)

const row = (linked, dropped) => `
  <tr class="dsh-gw-ideas-row">
    <td>11-06</td>
    <td>小红书</td>
    <td><a class="dsh-gw-idea-outcome" href="#">2026/选题-a.md</a></td>
    <td>用快剪把面料剪开给你看 —— 悬念式开场，前三秒不要露脸</td>
    <td>${linked ? '<a class="dsh-gw-idea-outcome" href="#">topics/a.md</a>' : '—'}</td>
    <td class="dsh-gw-td-act">
      <div class="dsh-gw-idea-acts">
        ${dropped
          ? '<span class="dsh-gw-idea-dropped">已丢弃</span>'
          : `<button class="dsh-gw-btn dsh-gw-btn-quiet dsh-gw-idea-add" ${linked ? 'data-linked="true"' : ''} style="flex:0 1 auto;min-width:0;max-width:100%">${linked ? '改选题' : '加入选题'}</button>`}
        <div class="dsh-gw-acts" style="flex:0 0 auto;display:flex;align-items:center">
          <button class="dsh-gw-ibtn" data-tone="danger" title="删掉这条想法">✕</button>
        </div>
      </div>
    </td>
  </tr>`

const widths = process.argv[2] ? process.argv[2].split(',').map(Number) : [10, 10, 12, 39, 13, 16]
const cols = ['c-date', 'c-src', 'c-url', 'c-body', 'c-out', 'c-act']
  .map((name, i) => `<col class="${name}" style="width:${widths[i]}%">`).join('')

// 和 useNarrow(tableRef, 460) 保持同一个阈值，否则量出来的不是真实分支。
const box = (w) => {
  const narrow = w < 460 ? ' data-narrow="true"' : ''
  return `<div class="box"><b>${w}px${narrow ? ' · narrow' : ''}</b><div class="dsh-gw-pane" style="width:${w}px;height:auto"><div class="dsh-gw-tablebox" style="width:${w}px">
    <table class="dsh-gw-table dsh-gw-ideas"${narrow}><colgroup>${cols}</colgroup>
    <thead><tr><th>日期</th><th>来源</th><th>链接</th><th>内容</th><th>去向</th><th></th></tr></thead>
    <tbody>${row(true, false)}${row(false, false)}${row(false, true)}${row(false, false)}</tbody></table>
  </div></div></div>`
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
<div class="stage">${[360, 500, 559, 560, 700, 900].map(box).join('')}</div>`

const out = new URL('./ideas-preview.html', import.meta.url)
fs.writeFileSync(out, html)
console.log('wrote', out.pathname, 'css', css.length, 'chars')
