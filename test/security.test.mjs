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
// DSH connection 服务的替身：requestRejection 的返回值由用例控制（403/401/undefined），
// 再模拟「老版本 DSH 没有这个服务」（serveConnection=false）。
let serveConnection = true
let dshRejection
const connection = { requestRejection() { return dshRejection } }
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {}, error() {} },
  get(name) { return serveConnection && name === 'connection' ? connection : undefined },
}, { pluginDataDir: dataDir })
await new Promise((resolve) => setTimeout(resolve, 150))

async function request(method, url, extraHeaders = {}, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json', ...extraHeaders }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = {
    statusCode: 200,
    write(chunk) { payload += chunk },
    setHeader() {},
    on() {},
    end(chunk) { if (chunk) payload += chunk },
  }
  await handler(req, res)
  let json
  try { json = JSON.parse(payload.split('\n')[0]) } catch { json = String(payload).slice(0, 160) }
  return { status: res.statusCode, json, raw: payload }
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

// 4a. /token：桌面端渲染进程的 fetch 不带 sec-fetch-site，必须也能领
// （2026-11-15 现场故障的根因：把它限成 same-origin 后页面永远领不到票）
r = await request('GET', base + '/token', { origin: 'http://127.0.0.1:58377' })
log('/token 无 sec-fetch-site 也能领（桌面端）', r.status === 200 && typeof r.json?.token === 'string', { status: r.status, len: r.json?.token?.length })

// 5. 带 token 的浏览器请求 → 放行
r = await request('GET', base + '/overview', { 'sec-fetch-site': 'same-origin', 'x-dsh-growth-token': token })
log('带 token 放行（不再 401/403）', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 6. 没有 sec-fetch 头的命令行调用：不再整体放行，必须带票（1.0 之前那条后门已删）
r = await request('GET', base + '/overview')
log('无 sec-fetch 头且无票 → 401', r.status === 401 && r.json.code === 'unauthorized', { status: r.status, code: r.json.code })

// 6a. 本机脚本从 session-token 读票 → 放行
const tokenFile = path.join(dataDir, 'session-token')
const scriptToken = fs.readFileSync(tokenFile, 'utf8').trim()
// Windows 没有 POSIX 权限位，mode 断言只在类 Unix 上做。
const modeOk = process.platform === 'win32' || (fs.statSync(tokenFile).mode & 0o777) === 0o600
log('session-token 落盘且与 /token 一致', scriptToken === token && modeOk, { len: scriptToken.length, mode: (fs.statSync(tokenFile).mode & 0o777).toString(8) })
r = await request('GET', base + '/overview', { 'x-dsh-growth-token': scriptToken })
log('带票的命令行调用放行', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 6b. DNS rebinding：Host 不是本机 → 403
r = await request('GET', base + '/token', { host: 'evil.com:1234', 'sec-fetch-site': 'same-origin' })
log('Host 非本机被拒', r.status === 403 && r.json.code === 'forbidden', r)

// 6c. Origin 不是本机 → 403
r = await request('GET', base + '/overview', { origin: 'http://evil.com' })
log('Origin 非本机被拒', r.status === 403 && r.json.code === 'forbidden', r)

// 6d. 实时通道：token 不再接受 query 形式
r = await request('GET', base + '/v2/events?path=Topics/a.md&token=' + encodeURIComponent(token))
log('events 拒绝 ?token=', r.status === 401, { status: r.status })

// 6e. 换票接口本身要票
r = await request('GET', base + '/events-ticket')
log('换票接口无票 → 401', r.status === 401, { status: r.status })

// 6f. 带票换一次性 ticket，ticket 只能连一次
r = await request('GET', base + '/events-ticket', { 'x-dsh-growth-token': scriptToken })
const ticket = r.json?.ticket
log('换票成功', r.status === 200 && typeof ticket === 'string' && ticket.length === 36, { status: r.status, len: ticket?.length })
r = await request('GET', base + '/v2/events?path=Topics/a.md&ticket=' + encodeURIComponent(ticket))
log('ticket 建立事件流', r.status === 200 && /: connected/.test(r.raw), { status: r.status, head: r.raw.slice(0, 24) })
r = await request('GET', base + '/v2/events?path=Topics/a.md&ticket=' + encodeURIComponent(ticket))
log('同一张 ticket 不能复用', r.status === 401, { status: r.status })

// 12. DSH 栅栏 403（跨站/DNS rebinding）：即使带着我们的票也拒
dshRejection = 403
r = await request('GET', base + '/overview', { 'x-dsh-growth-token': scriptToken })
log('DSH 栅栏 403 一律拒（带票也不例外）', r.status === 403 && /其它站点/.test(r.json.message), r)

// 12a. 栅栏 403 时 /token 也拿不到票
r = await request('GET', base + '/token')
log('DSH 栅栏 403 挡住 /token', r.status === 403 && r.json.token === undefined, { status: r.status })

// 13. DSH 栅栏 401（DSH 不认识调用方）：交回插件 token 判定 —— 带票放行
dshRejection = 401
r = await request('GET', base + '/overview', { 'x-dsh-growth-token': scriptToken })
log('栅栏 401 + 插件票 → 放行（桌面端无 cookie 也不停摆）', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 13a. 栅栏 401 + 没有插件票 → 仍是 401
r = await request('GET', base + '/overview')
log('栅栏 401 + 无票 → 401', r.status === 401 && r.json.code === 'unauthorized', { status: r.status, code: r.json.code })

// 14. DSH 认了（undefined）：照常放行（此时还没配 vault，业务层回 400 是正常的）
dshRejection = undefined
r = await request('GET', base + '/overview', { 'x-dsh-growth-token': scriptToken })
log('栅栏放行 → 过门', r.status !== 401 && r.status !== 403, { status: r.status, code: r.json.code })

// 15. 老版本 DSH 没有 connection 服务：插件自己的检查照旧，不崩、/token 能领
serveConnection = false
r = await request('GET', base + '/token')
log('无 connection 服务时降级运行', r.status === 200 && typeof r.json?.token === 'string', { status: r.status })
serveConnection = true

// 15a. 栅栏判定写进了 access-probe.log（诊断桌面端到底带不带 DSH cookie）
const probeLog = path.join(dataDir, 'access-probe.log')
const probeText = fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8') : ''
log('access-probe.log 记录了 403/401/ok/no-service 四种结论',
  ['"dsh":"403"', '"dsh":"401"', '"dsh":"ok"', '"dsh":"no-service"'].every((needle) => probeText.includes(needle)),
  { lines: probeText.split('\n').filter(Boolean).length })

// 7. vaultRoot 填盘符根 → 拒绝
r = await request('PUT', base + '/config', { 'x-dsh-growth-token': scriptToken }, { vaultRoot: 'C:\\' })
log('盘符根被拒', r.status === 400 && /磁盘/.test(r.json.message), { status: r.status, message: r.json.message })

// 8. vaultRoot 填系统目录 → 拒绝
r = await request('PUT', base + '/config', { 'x-dsh-growth-token': scriptToken }, { vaultRoot: 'C:\\Windows' })
log('系统目录被拒', r.status === 400, { status: r.status, message: r.json.message })

// 9. vaultRoot 不存在 → 拒绝
r = await request('PUT', base + '/config', { 'x-dsh-growth-token': scriptToken }, { vaultRoot: 'C:\\no-such-dir-growth-probe' })
log('不存在的目录被拒', r.status === 400 && /不存在/.test(r.json.message), { status: r.status, message: r.json.message })

// 10. vaultRoot 相对路径 → 拒绝
r = await request('PUT', base + '/config', { 'x-dsh-growth-token': scriptToken }, { vaultRoot: 'Obsidian' })
log('相对路径被拒', r.status === 400 && /绝对路径/.test(r.json.message), { status: r.status, message: r.json.message })

// 11. 正常目录 → 通过
r = await request('PUT', base + '/config', { 'x-dsh-growth-token': scriptToken }, { vaultRoot: vault })
log('正常目录通过', r.status === 200 && r.json.saved === true, { status: r.status, saved: r.json.saved })

console.log(out.join('\n'))
fs.rmSync(vault, { recursive: true, force: true })
fs.rmSync(dataDir, { recursive: true, force: true })
