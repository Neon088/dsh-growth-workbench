// 跨进程写锁的测试执行体：抢到锁 → 记 enter → 停一会 → 记 exit → 放锁。
// 两个以上这样的进程同时跑，日志里 enter/exit 必须严格交替，就证明它们没有同时写。
import { appendFile } from 'node:fs/promises'
import { withFileWriteLock } from '../lib/vault.js'

const [target, logFile, holdArg] = process.argv.slice(2)
const holdMs = Number(holdArg ?? 120)
const note = async (line) => { await appendFile(logFile, line + '\n', 'utf8') }

try {
  await withFileWriteLock(target, async () => {
    await note('enter ' + process.pid)
    await new Promise((done) => { setTimeout(done, holdMs) })
    await note('exit ' + process.pid)
  })
  process.exitCode = 0
} catch (error) {
  await note('error ' + process.pid + ' ' + String(error?.code ?? '') + ' ' + String(error?.message ?? error))
  process.exitCode = 1
}