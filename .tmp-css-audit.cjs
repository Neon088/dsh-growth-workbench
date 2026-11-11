// 审计 client.js 的 CSS（138–1119 行 const CSS = `...` 模板串）
const fs = require('fs');
const lines = fs.readFileSync('F:/工作台/dsh-growth-workbench/client.js', 'utf8').split('\n');
const css = lines.slice(137, 1118).join('\n');
console.log('CSS length:', css.length);
const noc = css.replace(/\/\*[\s\S]*?\*\//g, '');
// 顶层选择器
const sels = [];
let d1 = 0, cur = '';
for (const ch of noc) {
  if (ch === '{') { if (d1 === 0) sels.push(cur.trim()); d1++; cur = ''; }
  else if (ch === '}') { d1--; cur = ''; }
  else if (d1 === 0) cur += ch;
}
const nonGw = [...new Set(sels.filter(s => !s.includes('dsh-gw')))];
console.log('=== top-level selectors:', sels.length, '| non-dsh-gw:', nonGw.length);
for (const s of nonGw) console.log('  NON-GW SEL:', JSON.stringify(s));
// 定义了变量的块
let block = '', blockSel = '', inBlock = false, d2 = 0;
const varBlocks = [];
for (const ch of noc) {
  if (!inBlock) {
    if (ch === '{') { inBlock = true; d2 = 1; blockSel = cur.trim(); cur = ''; block = ''; }
    else cur += ch;
  } else {
    if (ch === '{') d2++;
    else if (ch === '}') { d2--; if (d2 === 0) { inBlock = false; const defs = block.match(/--[\w-]+\s*:/g) || []; if (defs.length) varBlocks.push([blockSel, [...new Set(defs)]]); } }
    else block += ch;
  }
}
console.log('=== blocks defining custom properties:', varBlocks.length);
for (const [s, vs] of varBlocks) console.log('  VAR BLOCK:', s, '=>', vs.join(' '));
