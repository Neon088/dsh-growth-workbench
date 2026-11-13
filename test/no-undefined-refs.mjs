/** Reference scan: every identifier must resolve to a declaration, a browser
 * global or a Node global. Catches dead references like an undefined helper
 * called from a never-used branch. No installation attempted: acorn is taken
 * from the repo or an existing DSH profile; when absent the check is skipped
 * with an explicit notice instead of failing the whole verify run.
 * Run: node test/no-undefined-refs.mjs client.js index.js
 * Optional GROWTH_TEST_PROFILE chooses which existing install to resolve deps from.
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.GROWTH_TEST_PROFILE || join(homedir(), '.dsh', 'profiles', 'desktop')
const candidates = [createRequire(join(repo, 'package.json')), createRequire(join(profile, 'package.json'))]
let acorn = null
for (const req of candidates) {
  try { acorn = req('acorn'); break } catch { /* try the next install */ }
}
if (acorn === null) {
  console.log('skip test/no-undefined-refs.mjs: acorn not found in the repo or DSH profiles (GROWTH_TEST_PROFILE can point to an install that has it)')
  process.exit(0)
}

const BROWSER = new Set(['window','document','navigator','localStorage','sessionStorage','location','history','fetch','HTMLElement','Element','Node','MutationObserver','ResizeObserver','IntersectionObserver','requestAnimationFrame','cancelAnimationFrame','getComputedStyle','CSS','Event','CustomEvent','KeyboardEvent','MouseEvent','FileReader','Blob','File','FormData','URL','URLSearchParams','AbortController','EventSource','WebSocket','alert','confirm','prompt','matchMedia','Image','DOMParser','crypto','performance','self','top','parent','CSSStyleSheet','ClipboardItem','NodeFilter','Range','Selection','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','requestIdleCallback','cancelIdleCallback','queueMicrotask','structuredClone','TextEncoder','TextDecoder','React','ReactDOM','arguments','undefined','NaN','Infinity','require','module','exports','__dirname','__filename','process','Buffer'])

function scan(file) {
  const src = readFileSync(file, 'utf8')
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const refs = []
  const mk = (parent, fn) => ({ parent, fn, names: new Set() })
  const fnScope = (s) => { while (!s.fn) s = s.parent; return s }
  function declPattern(p, scope, visit) {
    if (!p) return
    switch (p.type) {
      case 'Identifier': scope.names.add(p.name); break
      case 'ObjectPattern': for (const q of p.properties) { if (q.type === 'RestElement') declPattern(q.argument, scope, visit); else { if (q.computed) visit(q.key); declPattern(q.value, scope, visit) } } break
      case 'ArrayPattern': for (const e of p.elements) declPattern(e, scope, visit); break
      case 'RestElement': declPattern(p.argument, scope, visit); break
      case 'AssignmentPattern': declPattern(p.left, scope, visit); visit(p.right); break
    }
  }
  function walk(n, scope) {
    if (!n || typeof n.type !== 'string') return
    const v = (c, s = scope) => walk(c, s)
    switch (n.type) {
      case 'Identifier': refs.push({ name: n.name, line: n.loc.start.line, scope }); return
      case 'Program': { const s = mk(null, true); n.body.forEach((c) => walk(c, s)); return }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        if (n.type === 'FunctionDeclaration' && n.id) scope.names.add(n.id.name)
        const s = mk(scope, true)
        if (n.type === 'FunctionExpression' && n.id) s.names.add(n.id.name)
        for (const p of n.params) declPattern(p, s, (c) => walk(c, s))
        if (n.body.type === 'BlockStatement') n.body.body.forEach((c) => walk(c, s)); else walk(n.body, s)
        return
      }
      case 'ClassDeclaration': case 'ClassExpression': { if (n.id) scope.names.add(n.id.name); v(n.superClass); v(n.body); return }
      case 'MethodDefinition': case 'PropertyDefinition': { if (n.computed) v(n.key); v(n.value); return }
      case 'VariableDeclaration': { const target = n.kind === 'var' ? fnScope(scope) : scope; for (const d of n.declarations) { declPattern(d.id, target, (c) => walk(c, scope)); v(d.init) } return }
      case 'BlockStatement': { const s = mk(scope, false); n.body.forEach((c) => walk(c, s)); return }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': { const s = mk(scope, false); for (const k of ['init','test','update','left','right','body']) if (n[k]) walk(n[k], s); return }
      case 'SwitchStatement': { v(n.discriminant); const s = mk(scope, false); n.cases.forEach((c) => { walk(c.test, s); c.consequent.forEach((x) => walk(x, s)) }); return }
      case 'CatchClause': { const s = mk(scope, false); declPattern(n.param, s, (c) => walk(c, s)); n.body.body.forEach((c) => walk(c, s)); return }
      case 'MemberExpression': { v(n.object); if (n.computed) v(n.property); return }
      case 'Property': { if (n.computed) v(n.key); v(n.value); return }
      case 'LabeledStatement': v(n.body); return
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return
      case 'ImportDeclaration': n.specifiers.forEach((sp) => scope.names.add(sp.local.name)); return
      case 'ExportNamedDeclaration': { if (n.declaration) v(n.declaration); else if (!n.source) n.specifiers.forEach((sp) => v(sp.local)); return }
      case 'ExportDefaultDeclaration': v(n.declaration); return
      case 'ExportAllDeclaration': return
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((x) => x && typeof x.type === 'string' && walk(x, scope))
      else if (c && typeof c.type === 'string') walk(c, scope)
    }
  }
  walk(ast, null)
  const missing = new Map()
  for (const r of refs) {
    let s = r.scope, found = false
    while (s) { if (s.names.has(r.name)) { found = true; break } s = s.parent }
    if (found || BROWSER.has(r.name) || r.name in globalThis) continue
    if (!missing.has(r.name)) missing.set(r.name, [])
    missing.get(r.name).push(r.line)
  }
  console.log(`== ${file}: refs=${refs.length} unresolved names=${missing.size}`)
  for (const [name, ls] of missing) console.log(`  ${name}  x${ls.length}  lines ${ls.slice(0, 6).join(',')}`)
  return missing.size
}

let failed = 0
const targets = []
for (const arg of process.argv.slice(2)) {
  const stat = statSync(arg)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(arg).sort()) {
      if (entry.endsWith('.js')) targets.push(join(arg, entry))
    }
  } else if (stat.isFile()) targets.push(arg)
}
for (const f of targets) {
  try { failed += scan(f) } catch (e) { console.log(`!! ${f}: ${e.message}`); failed += 1 }
}
if (failed > 0) {
  console.log(`reference scan failed: ${failed} unresolved name(s)`)
  process.exit(1)
}
