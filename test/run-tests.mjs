// 顺序执行离线回归。每个子进程的 home / temp 都在本次测试目录里；
// 即使旧 Host 测试启动时写日志，也不会碰用户的 ~/.dsh-growth。
// 子进程直接写本次日志文件，不创建受限 Windows 环境中不可用的输出管道。
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, parse, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const suites = [
  'test/lib.test.js',
  'test/checklist.test.mjs',
  'test/data-safety.test.js',
  'test/rules.test.js',
  'test/security.test.mjs',
  'test/static.test.mjs',
  'test/e2e.mjs',
  'test/p0a.test.mjs',
  'test/v2.test.mjs',
  'test/calendar-integrity.test.mjs',
  'test/feedback-promote.test.mjs',
  'test/migration.test.mjs',
  'test/push.test.mjs',
  'test/links.test.mjs',
  'test/backend-regressions.test.mjs',
  'test/backend-pagination.test.mjs',
  'test/client-behavior.test.mjs',
  'test/profile-maintenance.test.mjs',
  'test/operational-settings.test.mjs',
]
for (const suite of suites) {
  if (!existsSync(join(repository, suite))) throw new Error('Missing expected test suite: ' + suite)
}
function collectLibraryFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectLibraryFiles(path) : entry.isFile() && entry.name.endsWith('.js') ? [relative(repository, path)] : []
  })
}
function sourceSnapshot() {
  const files = ['package.json', 'client.js', 'index.js', 'install.mjs', 'rollback.mjs', 'run-rollback.bat', 'README.md', '.gitignore', 'test/run-tests.mjs', 'test/browser-safety.test.mjs', ...collectLibraryFiles(join(repository, 'lib')), ...suites].sort()
  return Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(repository, file))).digest('hex')]))
}
const outputBase = join(repository, 'test', '.artifacts', 'unit')
mkdirSync(outputBase, { recursive: true })
const runDir = mkdtempSync(join(outputBase, 'run-'))
const sourceBefore = sourceSnapshot()
const report = {
  startedAt: new Date().toISOString(),
  scope: 'offline unit / simulated Host suites; no browser or live DSH calls',
  subprocessEnvironment: 'isolated HOME, USERPROFILE, home-drive paths, APPDATA, LOCALAPPDATA, TMP, TEMP and TMPDIR',
  suiteCount: suites.length,
  suites: [],
  sourceBefore,
  skippedCases: 'Read each suite output; individual suites must explicitly report any skipped cases.',
}
const reportFile = join(runDir, 'report.json')
let success = true
try {
  for (const suite of suites) {
    const slug = basename(suite).replace(/[^a-zA-Z0-9.-]/g, '-')
    const home = join(runDir, 'homes', slug)
    const temp = join(runDir, 'temp', slug)
    const appData = join(home, 'AppData', 'Roaming')
    const localAppData = join(home, 'AppData', 'Local')
    for (const directory of [home, temp, appData, localAppData]) mkdirSync(directory, { recursive: true })
    const root = parse(home).root
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, TMP: temp, TEMP: temp, TMPDIR: temp }
    if (process.platform === 'win32') { env.HOMEDRIVE = root.replace(/[\\/]+$/, ''); env.HOMEPATH = home.slice(env.HOMEDRIVE.length) }
    console.log('\n[' + (report.suites.length + 1) + '/' + suites.length + '] ' + suite)
    const started = performance.now()
    const stdoutPath = join(runDir, slug + '.stdout.log'), stderrPath = join(runDir, slug + '.stderr.log')
    let result, stdoutFd, stderrFd
    try {
      stdoutFd = openSync(stdoutPath, 'wx')
      stderrFd = openSync(stderrPath, 'wx')
      result = spawnSync(process.execPath, [join(repository, suite)], { cwd: repository, env, stdio: ['ignore', stdoutFd, stderrFd], timeout: 300000 })
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd)
      if (stderrFd !== undefined) closeSync(stderrFd)
    }
    const stdout = readFileSync(stdoutPath), stderr = readFileSync(stderrPath)
    if (stdout.length) process.stdout.write(stdout)
    if (stderr.length) process.stderr.write(stderr)
    const passed = !result.error && result.status === 0 && !result.signal
    report.suites.push({ file: suite, status: passed ? 'passed' : 'failed', exitCode: result.status, signal: result.signal, durationMs: Math.round(performance.now() - started), error: result.error?.message,
      stdoutLog: relative(runDir, stdoutPath), stderrLog: relative(runDir, stderrPath),
      stdoutSha256: createHash('sha256').update(stdout).digest('hex'), stderrSha256: createHash('sha256').update(stderr).digest('hex') })
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
    if (!passed) { success = false; console.error('Stopped after failed suite: ' + suite); if (result.error) console.error(result.error); break }
  }
} catch (error) {
  success = false
  report.runnerError = String(error?.stack ?? error)
  console.error(error)
} finally {
  try {
    report.sourceAfter = sourceSnapshot()
    report.sourceUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter)
  } catch (error) {
    report.sourceUnchanged = false
    report.snapshotError = String(error?.stack ?? error)
  }
  if (!report.sourceUnchanged) { success = false; console.error('Source changed or could not be verified during this run; rerun the final version before accepting the result.') }
  report.completedAt = new Date().toISOString()
  report.passed = success && report.suites.length === suites.length
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log('\nUnit report: ' + reportFile)
  console.log(report.passed ? 'All ' + suites.length + ' suites passed on unchanged source. See suite output for explicit skips.' : 'Unit run FAILED; read the failed suite and report above.')
  process.exitCode = report.passed ? 0 : 1
}
