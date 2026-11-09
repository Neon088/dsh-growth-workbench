// 外链白名单的离线验证：只有 http/https/mailto 会变成可点的链接。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

const start = src.search(/    function safeLinkTarget\(/)
if (start === -1) throw new Error('没找到 safeLinkTarget')
let depth = 0
let began = false
let end = -1
for (let i = src.indexOf('{', start); i < src.length; i++) {
  const ch = src[i]
  if (ch === '{') { depth++; began = true }
  else if (ch === '}') { depth--; if (began && depth === 0) { end = i + 1; break } }
}
if (end === -1) throw new Error('括号没配平')
const fn = src.slice(start, end)
const safeLinkTarget = new Function(fn + '\nreturn safeLinkTarget')()

const cases = [
  ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
  ['http://127.0.0.1:1/x', 'http://127.0.0.1:1/x'],
  ['mailto:a@b.com', 'mailto:a@b.com'],
  ['HTTPS://EXAMPLE.COM', 'HTTPS://EXAMPLE.COM'],
  ['javascript:alert(1)', ''],
  ['JavaScript:alert(1)', ''],
  ['data:text/html;base64,PHNjcmlwdD4=', ''],
  ['vbscript:msgbox(1)', ''],
  ['file:///C:/Windows/System32/calc.exe', ''],
  ['/relative/path', ''],
  ['', ''],
  [undefined, ''],
]

let failures = 0
for (const [input, expected] of cases) {
  const actual = safeLinkTarget(input)
  const ok = actual === expected
  if (!ok) failures++
  console.log((ok ? '  ok  ' : '  FAIL') + ' ' + JSON.stringify(input) + ' → ' + JSON.stringify(actual))
}
console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
if (failures > 0) process.exitCode = 1
