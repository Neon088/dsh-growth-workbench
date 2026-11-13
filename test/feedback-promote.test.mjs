// 客户反馈 → 选题的真实 HTTP 闭环。
//
// 重点不是「按钮发出请求」，而是两边一起落库：
//   1. 选题笔记确实建成了 type=选题；
//   2. 反馈行确实更新成跟进中，并把新选题路径写进处理意见/结果；
//   3. 同一条反馈重复点不会又建一篇同名选题。
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const plugin = require('../index.js')
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-feedback-vault-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-feedback-data-'))
let handler = null
plugin.apply({
  webServer: { register(route) { handler = route.handler; return () => {} } },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {}, error() {} },
}, { pluginDataDir: dataDir })
await new Promise((resolve) => setTimeout(resolve, 120))

async function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  let payload = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk) payload += chunk } }
  await handler(req, res)
  let json
  try { json = JSON.parse(payload) } catch { json = String(payload).slice(0, 300) }
  return { status: res.statusCode, json }
}

let failures = 0
function check(label, result, predicate) {
  const passed = predicate(result)
  if (!passed) failures += 1
  console.log((passed ? 'PASS ' : 'FAIL ') + label.padEnd(48) + ' ' + JSON.stringify(result.json).slice(0, 280))
}
const ok = (result) => result.status === 200 && result.json?.ok !== false

await request('PUT', '/api/dsh-growth/config', { vaultRoot: vault, pluginDataDir: dataDir })

const before = await request('GET', '/api/dsh-growth/topics/list?limit=200')
const beforeCount = Number(before.json?.total ?? 0)

const feedback = await request('POST', '/api/dsh-growth/feedback', {
  date: '2026-11-12',
  channel: '评论区',
  source: '平台 · 小红书',
  sentiment: '负',
  content: '很多人问这款收纳盒能不能放进 60cm 深的柜子',
  tags: '尺寸 / 咨询',
  advice: '先记录问题',
  resolution: '',
  status: '未处理',
})
const feedbackId = String(feedback.json?.entry?.id ?? '')
check('反馈先正常落库', feedback, (r) => ok(r) && feedbackId !== '')

const promoted = await request('POST', '/api/dsh-growth/feedback/promote', {
  id: feedbackId,
  platform: '小红书',
})
const createdPath = String(promoted.json?.created?.path ?? '')
check('反馈转成自己的选题，而不是拆解', promoted, (r) => ok(r)
  && r.json?.updated === true
  && String(r.json?.created?.front?.type ?? '') === '选题'
  && String(r.json?.created?.front?.platform ?? '') === '小红书'
  && createdPath !== '')
check('反馈行同步标成跟进中', promoted, (r) => String(r.json?.feedback?.status ?? '') === '跟进中')
check('处理意见和处理结果都留下选题路径', promoted, (r) => {
  const advice = String(r.json?.feedback?.advice ?? '')
  const resolution = String(r.json?.feedback?.resolution ?? '')
  return advice.includes(createdPath) && resolution.includes(createdPath)
})

const feedbackList = await request('GET', '/api/dsh-growth/feedback')
const feedbackRow = (feedbackList.json?.entries ?? []).find((entry) => entry.id === feedbackId) ?? {}
check('重新读反馈库仍是已更新状态', feedbackList, () => String(feedbackRow.status ?? '') === '跟进中'
  && String(feedbackRow.advice ?? '').includes(createdPath)
  && String(feedbackRow.resolution ?? '').includes(createdPath))

const topic = await request('GET', '/api/dsh-growth/topics/record?path=' + encodeURIComponent(createdPath))
check('选题带回了反馈原话和真实来源', topic, (r) => {
  const front = r.json?.record?.front ?? {}
  const origin = String(front.origin ?? '')
  return String(front.type ?? '') === '选题'
    && String(front.platform ?? '') === '小红书'
    && origin.includes('60cm 深的柜子')
    && origin.includes('小红书')
    && String(front.sourceTitle ?? '').includes('客户反馈')
})

const promotedAgain = await request('POST', '/api/dsh-growth/feedback/promote', {
  id: feedbackId,
  platform: '小红书',
})
const after = await request('GET', '/api/dsh-growth/topics/list?limit=200')
check('同一条反馈重试会复用已有选题', promotedAgain, (r) => ok(r)
  && r.json?.existing === true
  && String(r.json?.created?.path ?? '') === createdPath)
check('重试不会多建选题', after, (r) => Number(r.json?.total ?? -1) === beforeCount + 1)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exitCode = failures === 0 ? 0 : 1
