// 把 lib/platforms.js 内联进 client.js。
//
// 为什么需要生成：client.js 是浏览器侧的单模块，host loader 不解析相对 import，
// 所以客户端拿不到服务端的 ESM。平台表因此只能「一份源 + 一份生成物」：
//   lib/platforms.js      —— 唯一事实源，服务端 import 它
//   client.js 标记块      —— 由本脚本生成，客户端用
// 改表只改 lib，然后：
//   npm run build:client   # 生成
//   npm run check:client   # CI 里比对（漂移就 exit 1）
//
// 标记块里除了表，还带着 normalizePlatform / splitPlatforms / joinPlatforms 这一套，
// 保证两边对「B站 / bilibili」的判断和「 / 」拼接结果完全一致。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = join(ROOT, 'client.js')
const SOURCE = join(ROOT, 'lib', 'platforms.js')

const START = '    /* @generated lib/platforms.js start — 由 npm run build:client 生成，别手改 */'
const END = '    /* @generated lib/platforms.js end */'
// 文件头那段说明是给维护者看的，客户端里已经有对应注释，不再重复内联。
const BODY_FROM = '/** 规范平台名'

function sharedBlock() {
  const source = readFileSync(SOURCE, 'utf8')
  const from = source.indexOf(BODY_FROM)
  if (from < 0) throw new Error('lib/platforms.js 找不到「' + BODY_FROM + '」开头的表，生成中止')
  const body = source.slice(from).replace(/\n?export \{[\s\S]*?\}\s*$/, '\n')
  if (/^\s*export\s/m.test(body)) throw new Error('lib/platforms.js 里还有 export 关键字，没法原样内联；把导出集中到文件末尾那一个 export {} 里')
  const lines = body
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : '    ' + line))
  return [START, ...lines, END].join('\n')
}

const current = readFileSync(CLIENT, 'utf8')
const startAt = current.indexOf(START)
const endAt = current.indexOf(END)
if (startAt < 0 || endAt < 0 || endAt < startAt) {
  throw new Error('client.js 里找不到 @generated 标记块，先手工补上 start/end 两行标记')
}
const block = sharedBlock()
const next = current.slice(0, startAt) + block + current.slice(endAt + END.length)

if (process.argv.includes('--check')) {
  if (next === current) {
    console.log('client.js 的平台表与 lib/platforms.js 一致')
    process.exit(0)
  }
  // 只报第一处差异，够定位了；整段打印太长。
  let at = 0
  while (at < next.length && next[at] === current[at]) at += 1
  const line = current.slice(0, at).split('\n').length
  const near = current.slice(at, at + 80).split('\n')[0]
  console.error('client.js 的平台表和 lib/platforms.js 不一致（客户端第 ' + line + ' 行附近：' + JSON.stringify(near) + '）')
  console.error('改的是 lib/platforms.js 的话，跑一次 npm run build:client 重新生成。')
  process.exit(1)
}

writeFileSync(CLIENT, next, 'utf8')
console.log('client.js 的平台表已从 lib/platforms.js 重新生成')