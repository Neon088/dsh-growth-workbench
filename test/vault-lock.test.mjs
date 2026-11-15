// 跨进程写锁实测：两个以上 dsh 进程写同一篇笔记时，进入/退出必须严格交替。
// 附带验证：陈旧锁（持有者被杀）会被接管，不会把文件永久锁死。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const worker = join(here, '_vault-lock-worker.mjs')
const workdir = mkdtempSync(join(tmpdir(), 'gw-lock-test-'))
const target = join(workdir, 'note.md')
const logFile = join(workdir, 'log.txt')
writeFileSync(target, '# note\n', 'utf8')

const lockDir = join(tmpdir(), 'dsh-growth-locks')
function lockPathFor(file) {
  const absolute = file.toLowerCase()
  return join(lockDir, createHash('sha1').update(absolute).digest('hex') + '.lock')
}

function runWorker() {
  return new Promise((done) => {
    const child = spawn(process.execPath, [worker, target, logFile, '120'], { stdio: 'ignore' })
    child.on('exit', (code) => done(code))
  })
}

const started = Date.now()
const codes = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()])
const elapsed = Date.now() - started

assert.deepEqual(codes, [0, 0, 0, 0], '每个 worker 都应成功拿到锁')
const lines = readFileSync(logFile, 'utf8').trim().split('\n')
assert.equal(lines.length, 8, '4 个进程各写 enter / exit 一行：' + lines.join(' | '))
const expected = []
for (const line of lines) {
  const [kind, pid] = line.split(' ')
  if (kind === 'enter') {
    assert.equal(expected.length, 0, '上一把锁还没放就又有人进来了：' + lines.join(' | '))
    expected.push(pid)
  } else {
    assert.equal(kind, 'exit', '意外日志：' + line)
    assert.equal(expected.pop(), pid, '退出的人和上次进入的人不一致：' + lines.join(' | '))
  }
}
assert.equal(expected.length, 0, '有进程进去了却没出来')
// 4 × 120ms 的临界区不可能并行完成；串行下限 480ms，放宽到 380ms 容忍计时误差。
assert.ok(elapsed >= 380, '临界区被并行执行了？总耗时只有 ' + elapsed + 'ms')
assert.equal(existsSync(lockPathFor(target)), false, '跑完之后锁文件应当被释放')

// 陈旧锁：模拟持有者被杀（锁文件很旧），新进程要能接管而不是等到超时。
mkdirSync(lockDir, { recursive: true })
const stalePath = lockPathFor(target)
writeFileSync(stalePath, '999999 1\n', 'utf8')
const old = new Date(Date.now() - 120_000)
utimesSync(stalePath, old, old)
const staleStart = Date.now()
const staleCode = await runWorker()
assert.equal(staleCode, 0, '陈旧锁应当被接管')
assert.ok(Date.now() - staleStart < 5000, '接管陈旧锁不该等满超时')

rmSync(workdir, { recursive: true, force: true })
console.log('cross-process write lock: 4 workers serialized, stale lock reclaimed (' + elapsed + 'ms)')