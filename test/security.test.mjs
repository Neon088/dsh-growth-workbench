// 安全加固实测：auth / token / vaultRoot 校验。
// 用法：node test/_sec_probe.mjs
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sec-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sec-data-'))

let handler = null
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {}, error() {} },
}, { pluginDataDir: dataDir })
await new Promise((resolve) => setTimeout(resolve, 150))

async function request(method, url, extraHeaders = {}, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json', ...extraHeaders }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
  await handler(req, res)
  let json
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 160) }
  return { status: res.statusCode, json }
}

const base = '/api/dsh-growth'
const out = []
const log = (label, ok, detail) => { out.push((ok ? 'PASS ' : 'FAIL ') + label + ' :: ' + JSON.stringify(detail)); if (!ok) process.exitCode = 1 }

// 1. 跨站请求 → 403
let r = await request('GET', base + '/overview', { 'sec-fetch-site': 'cross-site' })
log('cross-site 被拒', r.status === 403 && r.json.code === 'forbidden', r)

// 2. 同源但不带 token → 401
r = await request('GET', base + '/overview', { 'sec-fetch-site': 'same-origin' })
log('同源缺 token → 401', r.status === 401 && r.json.code === 'unauthorized', r)

// 3. /token：跨站拿不到
r = await request('GET', base + '/token', { 'sec-fetch-site': 'cross-site' })
log('/token 跨站被拒', r.status === 403, r)

// 4. /token：同源可以领
r = await request('GET', base + '/token', { 'sec-fetch-site': 'same-origin' })
const token = r.json?.token
log('/token 同源可领', r.status === 200 && typeof token === 'string' && token.length === 48, { status: r.status, len: token?.length })

// 5. 带 token 的浏览器请求 → 放行
r = await request('GET', base + '/overview', { 'sec-fetch-site': 'same-origin', 'x-dsh-growth-token': token })
log('带 token 放行（不再 401/403）', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 6. 没有 sec-fetch 头的命令行调用 → 照旧放行（不破坏本地脚本）
r = await request('GET', base + '/overview')
log('无 sec-fetch 头放行（不再 401/403）', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 6b. DNS rebinding：Host 不是本机 → 403
r = await request('GET', base + '/token', { host: 'evil.com:1234', 'sec-fetch-site': 'same-origin' })
log('Host 非本机被拒', r.status === 403 && r.json.code === 'forbidden', r)

// 6c. Origin 不是本机 → 403
r = await request('GET', base + '/overview', { origin: 'http://evil.com' })
log('Origin 非本机被拒', r.status === 403 && r.json.code === 'forbidden', r)

// 7. vaultRoot 填盘符根 → 拒绝
r = await request('PUT', base + '/config', {}, { vaultRoot: 'C:\\' })
log('盘符根被拒', r.status === 400 && /磁盘/.test(r.json.message), { status: r.status, message: r.json.message })

// 8. vaultRoot 填系统目录 → 拒绝
r = await request('PUT', base + '/config', {}, { vaultRoot: 'C:\\Windows' })
log('系统目录被拒', r.status === 400, { status: r.status, message: r.json.message })

// 9. vaultRoot 不存在 → 拒绝
r = await request('PUT', base + '/config', {}, { vaultRoot: 'C:\\no-such-dir-growth-probe' })
log('不存在的目录被拒', r.status === 400 && /不存在/.test(r.json.message), { status: r.status, message: r.json.message })

// 10. vaultRoot 相对路径 → 拒绝
r = await request('PUT', base + '/config', {}, { vaultRoot: 'Obsidian' })
log('相对路径被拒', r.status === 400 && /绝对路径/.test(r.json.message), { status: r.status, message: r.json.message })

// 11. 正常目录 → 通过
r = await request('PUT', base + '/config', {}, { vaultRoot: vault })
log('正常目录通过', r.status === 200 && r.json.saved === true, { status: r.status, saved: r.json.saved })

console.log(out.join('\n'))
fs.rmSync(vault, { recursive: true, force: true })
fs.rmSync(dataDir, { recursive: true, force: true })
