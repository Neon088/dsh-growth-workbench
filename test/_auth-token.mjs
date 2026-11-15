// 测试进程的本机 API 凭证。
// index.js 在 apply() 的 effect 里把进程级 token 落到 <dataDir>/session-token（0600），
// 之后除 /token 和带票的 /v2/events 之外，每个请求都要带 x-dsh-growth-token 头。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function tokenOf(dataDir) {
  return readFileSync(join(dataDir, 'session-token'), 'utf8').trim()
}

export function authHeaders(dataDir) {
  return { 'x-dsh-growth-token': tokenOf(dataDir) }
}