#!/usr/bin/env node
/**
 * 把 dsh-growth-workbench 装进 desktop profile。
 *
 * 关键教训（踩过 4 次）：
 * 1. fs.cpSync 复制到 profile 路径会静默失败（exit 127 无输出）→ 必须逐文件 copyFileSync。
 * 2. 这份 DSH 用 package.json 的 dsh.profile.bundles 数组加载插件，cordis.patch.yml 不是插件清单。
 * 3. 插件的 exports 必须包含 "./package.json"，否则加载器读子包清单时报
 *    ERR_PACKAGE_PATH_NOT_EXPORTED —— 而桌面外壳把启动失败的条目当作致命错误，整个 DSH 起不来。
 * 4. 不要导出 Config：schema 校验抛错同样会让启动条目被拒。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, lstatSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const DEST = join(PROFILE, 'node_modules', 'dsh-growth-workbench')
const PKG = join(PROFILE, 'package.json')
const NAME = 'dsh-growth-workbench'

// 要复制的文件（相对路径）
const FILES = []
for (const f of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
  if (existsSync(join(SRC, f))) FILES.push(f)
}
for (const f of readdirSync(join(SRC, 'lib'))) {
  if (f.endsWith('.js')) FILES.push(join('lib', f))
}

console.log(`源目录: ${SRC}`)
console.log(`目标:   ${DEST}`)
console.log(`文件数: ${FILES.length}`)

// 1) 清掉旧目录，重建 —— 但先看一眼它是不是**指回源目录的链接**。
// 开发期这份插件是用 junction 挂进去的：删掉链接再复制一份静态副本，
// 就等于把热重载静默掐断 —— 之后改源码全都不生效，而且一句报错都没有。
if (existsSync(DEST)) {
  const stat = lstatSync(DEST)
  if (stat.isSymbolicLink()) {
    const linked = realpathSync(DEST)
    const source = realpathSync(SRC)
    if (linked === source) {
      console.log('\n目标是指回源目录的链接（开发期安装）：源码改动本来就即时生效。')
      console.log('不做任何复制，以免把链接换成静态副本、静默掐断热重载。')
      process.exit(0)
    }
    console.log(`\n目标是链接，但指向 ${linked}（不是源目录），按普通安装继续。`)
  }
  rmSync(DEST, { recursive: true, force: true })
}
mkdirSync(join(DEST, 'lib'), { recursive: true })

// 2) 逐文件复制
for (const rel of FILES) {
  const to = join(DEST, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(SRC, rel), to)
  console.log(`  ✓ ${rel}`)
}

// 3) 改 profile/package.json：
//    - bundles 放裸名（决定加载哪些插件）
//    - dependencies 登记版本号（决定插件管理面板能否认出它）
//      只进 bundles 不进 dependencies，DSH 自带的插件管理面板里就看不到这个插件。
const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
copyFileSync(PKG, `${PKG}.before-growth-install`)

pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
const bundles = pkg.dsh.profile.bundles
if (!bundles.includes(NAME)) bundles.unshift(NAME)

const selfVersion = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).version
pkg.dependencies ??= {}
pkg.dependencies[NAME] = selfVersion
const sortedDeps = {}
for (const key of Object.keys(pkg.dependencies).sort()) sortedDeps[key] = pkg.dependencies[key]
pkg.dependencies = sortedDeps

writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", 'utf8')
console.log("\n" + `bundles: ${bundles.length} 项，第一项 = ${bundles[0]}`)
console.log(`dependencies: 已登记 ${NAME}@${selfVersion}（插件管理面板据此识别）`)
console.log("\n" + '装好了。重启 DSH 试试。')
