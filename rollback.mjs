#!/usr/bin/env node
/**
 * 一条命令把 desktop profile 恢复成「没装过 dsh-growth-workbench」的干净状态。
 *
 * 用法：双击 run-rollback.bat，或 node rollback.mjs
 *
 * 为什么需要它：DSH 桌面外壳把「启动失败的插件条目」当作致命错误，
 * 一个加载不了的插件可以让整个应用起不来。这个脚本不依赖 DSH 能启动，
 * 直接用 node 改文件，所以即使界面打不开也能救回来。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const PKG = join(PROFILE, 'package.json')
const PLUGIN_DIR = join(PROFILE, 'node_modules', 'dsh-growth-workbench')
const PLUGIN_NAME = 'dsh-growth-workbench'

if (!existsSync(PKG)) {
  console.error(`找不到 ${PKG} —— 路径不对？`)
  process.exit(1)
}

const raw = readFileSync(PKG, 'utf8')
const pkg = JSON.parse(raw)

// 先备份，再动手
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(PKG + `.rollback-${stamp}.bak`)
copyFileSync(PKG, backup)
console.log(`已备份 profile/package.json → ${backup}`)

let changed = false

// 1) 从 dsh.profile.bundles 里剔掉
const bundles = pkg?.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const before = bundles.length
  pkg.dsh.profile.bundles = bundles.filter((b) => !String(b).includes(PLUGIN_NAME))
  if (pkg.dsh.profile.bundles.length !== before) {
    console.log(`bundles: ${before} → ${pkg.dsh.profile.bundles.length}`)
    changed = true
  } else {
    console.log('bundles: 无需改动')
  }
}

// 2) 从 dependencies 里剔掉
if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, PLUGIN_NAME)) {
  delete pkg.dependencies[PLUGIN_NAME]
  console.log('dependencies: 已移除')
  changed = true
}

// 3) 清掉可能残留的 devDependencies / optionalDependencies
for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], PLUGIN_NAME)) {
    delete pkg[field][PLUGIN_NAME]
    console.log(`${field}: 已移除`)
    changed = true
  }
}

// 4) cordis.yml 若是被写坏的数组，恢复成 []
const cordisYml = join(PROFILE, 'cordis.yml')
if (existsSync(cordisYml)) {
  const text = readFileSync(cordisYml, 'utf8').trim()
  if (text.includes(PLUGIN_NAME)) {
    writeFileSync(cordisYml, '[]\n', 'utf8')
    console.log('cordis.yml: 已重置为 []')
    changed = true
  }
}

// 5) cordis.patch.yml 里若残留 insert 段，整段去掉
const patchYml = join(PROFILE, 'cordis.patch.yml')
if (existsSync(patchYml)) {
  const text = readFileSync(patchYml, 'utf8')
  if (text.includes(PLUGIN_NAME)) {
    // 备份后按块删除：从含插件名的 insert 行往前找到它的缩进块
    const lines = text.split(/\r?\n/)
    const out = []
    let skipIndent = null
    for (const line of lines) {
      const indent = line.length - line.trimStart().length
      if (skipIndent !== null) {
        if (line.trim() === '' || indent > skipIndent) continue
        skipIndent = null
      }
      if (line.includes(PLUGIN_NAME)) {
        // 删掉这一行，以及紧随其后、缩进更深的兄弟行
        skipIndent = indent
        continue
      }
      out.push(line)
    }
    writeFileSync(patchYml, out.join('\n'), 'utf8')
    console.log('cordis.patch.yml: 已移除插件残留段')
    changed = true
  }
}

// 6) 删插件目录
if (existsSync(PLUGIN_DIR)) {
  rmSync(PLUGIN_DIR, { recursive: true, force: true })
  console.log('node_modules/dsh-growth-workbench: 已删除')
  changed = true
}

// 7) 删掉插件自己的配置（可选 —— 保留，因为重装后还要用）
console.log('~/.dsh-growth/config.json: 保留（重装后无需重新填 vault 路径）')

if (changed) {
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('\n完成。现在重新启动 DSH 即可。')
} else {
  console.log('\n没有发现需要清理的东西 —— profile 本来就是干净的。')
}
