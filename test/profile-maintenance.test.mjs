import assert from 'node:assert/strict'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { applyMaintenancePlan, makeInstallPlan, makeRollbackPlan, maintenancePlanFingerprint, parseMaintenanceArgs, publicMaintenancePlan, removePluginYaml, runMaintenanceCli } from '../lib/profile-maintenance.js'

// 测试只创建临时 profile，绝不使用 ~/.dsh 或真实 Obsidian。
const root = mkdtempSync(join(tmpdir(), 'growth-profile-maintenance-'))
assert.ok(basename(root).startsWith('growth-profile-maintenance-'))
const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
let skipped = 0
async function test(name, fn) { if (await fn() === 'skip') { skipped++; console.log('↷ ' + name + '（临时文件系统未生成真实 junction）'); return }; passed++; console.log('✓ ' + name) }
function fixture() {
  const dir = mkdtempSync(join(root, 'case-'))
  const profileDir = join(dir, 'profile')
  const sourceDir = join(dir, 'source')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(sourceDir, 'lib'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'isolated-profile', dsh: { profile: { bundles: ['other-plugin', 'dsh-growth-workbench-extra', 'dsh-growth-workbench@0.1.0'] } }, dependencies: { 'other-plugin': '1', 'dsh-growth-workbench': '0.1.0', 'dsh-growth-workbench-extra': '2' } }, null, 2) + '\n')
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'dsh-growth-workbench', version: '0.2.0', exports: { './client': './client.js', './package.json': './package.json' } }))
  writeFileSync(join(sourceDir, 'index.js'), 'export const name = "isolated"\n')
  writeFileSync(join(sourceDir, 'client.js'), '// fixture client\n')
  writeFileSync(join(sourceDir, 'lib', 'fixture.js'), 'export const value = 1\n')
  return { profileDir, sourceDir, packageFile: join(profileDir, 'package.json'), pluginDir: join(profileDir, 'node_modules', 'dsh-growth-workbench') }
}
const snapshot = (dir) => {
  const result = {}
  const walk = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name), key = join(prefix, entry.name)
      if (entry.isDirectory()) walk(next, key)
      else if (entry.isSymbolicLink()) result[key] = 'LINK:' + realpathSync(next)
      else result[key] = readFileSync(next, 'utf8')
    }
  }
  walk(dir, '')
  return result
}

try {
  test('默认是预览，目标可显式选择，冲突参数拒绝', () => {
    assert.equal(parseMaintenanceArgs([]).apply, false)
    assert.equal(parseMaintenanceArgs(['--profile', root, '--apply']).profileDir, resolve(root))
    assert.equal(parseMaintenanceArgs(['--apply']).apply, true)
    assert.throws(() => parseMaintenanceArgs(['--apply', '--dry-run']))
    assert.throws(() => parseMaintenanceArgs(['--profile']))
    assert.throws(() => parseMaintenanceArgs(['--guess']))
  })
  test('YAML 只移除精确插件项，相似名/提及/注释和 CRLF 保留', () => {
    const text = '# before\r\n- name: other-plugin\r\n  config:\r\n    note: dsh-growth-workbench\r\n- name: "dsh-growth-workbench"\r\n  config:\r\n    vaultRoot: D:/Notes\r\n# keep next comment\r\n- name: dsh-growth-workbench-extra\r\n  config: {}\r\n'
    const result = removePluginYaml(text)
    assert.equal(result.removed, 1)
    assert.equal(result.text, '# before\r\n- name: other-plugin\r\n  config:\r\n    note: dsh-growth-workbench\r\n# keep next comment\r\n- name: dsh-growth-workbench-extra\r\n  config: {}\r\n')
  })
  test('insert 嵌套块可精确移除，其它插件配置保留', () => {
    const text = '- insert:\n    - id: unrelated\n      name: other-plugin\n      config: {}\n    - id: dsh-growth-workbench\n      name: \'dsh-growth-workbench\'\n      config:\n        key: value\n- insert:\n  - name: dsh-growth-workbench-extra\n    config: {}\n'
    const result = removePluginYaml(text)
    assert.equal(result.removed, 1)
    assert.ok(result.text.includes('name: other-plugin'))
    assert.ok(result.text.includes('name: dsh-growth-workbench-extra'))
    assert.ok(!result.text.includes('key: value'))
  })
  test('空 insert 显式 []，根空列表保留注释；重复运行无修改', () => {
    assert.equal(removePluginYaml('- insert:\n    - name: dsh-growth-workbench\n').text, '- insert: []\n')
    const cleaned = removePluginYaml('# keep\n- name: dsh-growth-workbench\n').text
    assert.equal(cleaned, '# keep\n[]\n')
    assert.deepEqual(removePluginYaml(cleaned), { text: cleaned, removed: 0 })
    assert.equal(removePluginYaml('- insert:\n  - name: dsh-growth-workbench\n').text, '- insert: []\n')
  })
  test('未知 flow/嵌套名称拒绝猜测，而普通提及不会触发删除', () => {
    assert.throws(() => removePluginYaml('- { name: dsh-growth-workbench, config: {} }\n'), /不能安全定位/)
    assert.throws(() => removePluginYaml('plugins:\n  - name: dsh-growth-workbench\n'), /不能安全定位/)
    const text = '- name: other-plugin\n  config:\n    message: dsh-growth-workbench\n'
    assert.equal(removePluginYaml(text).text, text)
  })
  test('YAML 锚点或别名拒绝猜测，不产生其它插件的悬空引用', () => {
    assert.throws(() => removePluginYaml('- name: &plugin dsh-growth-workbench\n  config: {}\n'), /不能安全定位/)
    assert.throws(() => removePluginYaml('- name: dsh-growth-workbench\n  config: &shared\n    enabled: true\n- name: other-plugin\n  config: *shared\n'), /锚点或别名/)
    assert.throws(() => removePluginYaml('- name: dsh-growth-workbench\n  config: *shared\n'), /锚点或别名/)
  })
  test('JSON Cordis 列表精准保留其它插件', () => {
    const result = removePluginYaml(JSON.stringify([{ name: 'other-plugin' }, { name: 'dsh-growth-workbench' }, { insert: [{ name: 'dsh-growth-workbench-extra' }, { name: 'dsh-growth-workbench' }] }]))
    assert.equal(result.removed, 2)
    assert.deepEqual(JSON.parse(result.text), [{ name: 'other-plugin' }, { insert: [{ name: 'dsh-growth-workbench-extra' }] }])
  })
  test('安装预览无写入；提交保留完整旧目录和 package 备份', () => {
    const f = fixture()
    mkdirSync(f.pluginDir)
    writeFileSync(join(f.pluginDir, 'old.txt'), 'old installation')
    const before = snapshot(f.profileDir)
    const plan = makeInstallPlan(f)
    assert.deepEqual(snapshot(f.profileDir), before)
    const result = applyMaintenancePlan(plan)
    assert.equal(result.changed, true)
    assert.equal(readFileSync(join(result.backupDir, 'plugin', 'old.txt'), 'utf8'), 'old installation')
    assert.equal(readFileSync(join(result.backupDir, 'package.json.bak'), 'utf8'), before['package.json'])
    assert.equal(readFileSync(join(f.pluginDir, 'client.js'), 'utf8'), '// fixture client\n')
    assert.equal(readFileSync(join(f.pluginDir, 'lib', 'fixture.js'), 'utf8'), 'export const value = 1\n')
    const pkg = JSON.parse(readFileSync(f.packageFile, 'utf8'))
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-growth-workbench', 'other-plugin', 'dsh-growth-workbench-extra'])
    assert.equal(pkg.dependencies['other-plugin'], '1')
    assert.equal(pkg.dependencies['dsh-growth-workbench-extra'], '2')
  })
  test('卸载备份每个受影响配置，隔离目录且不删插件配置/笔记', () => {
    const f = fixture()
    mkdirSync(f.pluginDir)
    writeFileSync(join(f.pluginDir, 'old.txt'), 'keep old')
    const yml = '- name: other-plugin\n  config: {keep: true}\n- name: dsh-growth-workbench\n'
    writeFileSync(join(f.profileDir, 'cordis.yml'), yml)
    writeFileSync(join(f.profileDir, 'cordis.patch.yml'), '- insert:\n    - name: dsh-growth-workbench\n')
    writeFileSync(join(f.profileDir, 'vault-note.md'), 'must remain')
    writeFileSync(join(f.profileDir, 'growth-config.json'), 'must remain too')
    const before = snapshot(f.profileDir), plan = makeRollbackPlan(f)
    assert.deepEqual(snapshot(f.profileDir), before)
    const result = applyMaintenancePlan(plan)
    assert.equal(readFileSync(join(result.backupDir, 'cordis.yml.bak'), 'utf8'), yml)
    assert.ok(existsSync(join(result.backupDir, 'cordis.patch.yml.bak')))
    assert.equal(readFileSync(join(result.backupDir, 'plugin', 'old.txt'), 'utf8'), 'keep old')
    assert.ok(!existsSync(f.pluginDir))
    assert.equal(readFileSync(join(f.profileDir, 'cordis.yml'), 'utf8'), '- name: other-plugin\n  config: {keep: true}\n')
    assert.equal(readFileSync(join(f.profileDir, 'vault-note.md'), 'utf8'), 'must remain')
    assert.equal(readFileSync(join(f.profileDir, 'growth-config.json'), 'utf8'), 'must remain too')
    assert.equal(makeRollbackPlan(f).changes.length, 0)
  })
  test('未知 YAML 使整个计划失败，不先改 package 或 plugin', () => {
    const f = fixture()
    writeFileSync(join(f.profileDir, 'cordis.yml'), '- { name: dsh-growth-workbench, config: {} }\n')
    const before = snapshot(f.profileDir)
    assert.throws(() => makeRollbackPlan(f), /不能安全定位/)
    assert.deepEqual(snapshot(f.profileDir), before)
  })
  test('预览后用户改 package 会拒写，保持用户的新值和旧插件', () => {
    const f = fixture()
    mkdirSync(f.pluginDir)
    writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
    const plan = makeInstallPlan(f)
    const next = JSON.parse(readFileSync(f.packageFile, 'utf8')); next.userEdited = true
    writeFileSync(f.packageFile, JSON.stringify(next))
    assert.throws(() => applyMaintenancePlan(plan), (error) => error.code === 'profile_conflict')
    assert.equal(JSON.parse(readFileSync(f.packageFile, 'utf8')).userEdited, true)
    assert.ok(existsSync(join(f.pluginDir, 'old.txt')))
  })
  test('staging 后出现的并发修改也拒写，不切换旧插件', () => {
    const f = fixture()
    mkdirSync(f.pluginDir)
    writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
    const plan = makeInstallPlan(f)
    assert.throws(() => applyMaintenancePlan(plan, { beforeCommit() { writeFileSync(f.packageFile, '{"newUserValue":1}') } }), (error) => error.code === 'profile_conflict')
    assert.equal(readFileSync(f.packageFile, 'utf8'), '{"newUserValue":1}')
    assert.ok(existsSync(join(f.pluginDir, 'old.txt')))
    assert.equal(readdirSync(join(f.profileDir, 'node_modules')).filter((name) => name.startsWith('.growth-stage-')).length, 0)
  })
  test('源码或插件 entry 在预览后改变会拒写', () => {
    const changedSource = fixture(), sourcePlan = makeInstallPlan(changedSource)
    writeFileSync(join(changedSource.sourceDir, 'client.js'), '// user changed source\n')
    assert.throws(() => applyMaintenancePlan(sourcePlan), (error) => error.code === 'profile_conflict')
    assert.ok(!existsSync(changedSource.pluginDir))
    const changedEntry = fixture(), entryPlan = makeInstallPlan(changedEntry)
    mkdirSync(changedEntry.pluginDir)
    writeFileSync(join(changedEntry.pluginDir, 'user.txt'), 'new user install')
    assert.throws(() => applyMaintenancePlan(entryPlan), (error) => error.code === 'profile_conflict')
    assert.equal(readFileSync(join(changedEntry.pluginDir, 'user.txt'), 'utf8'), 'new user install')
  })
  test('部分配置已提交后失败，会恢复配置与旧插件', () => {
    const f = fixture()
    mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
    const yaml = '- name: other-plugin\n- name: dsh-growth-workbench\n'
    writeFileSync(join(f.profileDir, 'cordis.yml'), yaml)
    const before = readFileSync(f.packageFile, 'utf8')
    const plan = makeRollbackPlan(f)
    assert.throws(() => applyMaintenancePlan(plan, { beforeConfigWrite(_entry, index) { if (index === 1) throw new Error('injected second write failure') } }), /injected second write failure/)
    assert.equal(readFileSync(f.packageFile, 'utf8'), before)
    assert.equal(readFileSync(join(f.profileDir, 'cordis.yml'), 'utf8'), yaml)
    assert.equal(readFileSync(join(f.pluginDir, 'old.txt'), 'utf8'), 'old')
  })
  test('开发 junction 保留并补注册；卸载只隔离链接，不删除源目录', () => {
    const f = fixture()
    symlinkSync(f.sourceDir, f.pluginDir, process.platform === 'win32' ? 'junction' : 'dir')
    if (!lstatSync(f.pluginDir).isSymbolicLink()) return 'skip'
    const plan = makeInstallPlan(f)
    assert.equal(plan.pluginAction, 'preserve-link')
    applyMaintenancePlan(plan)
    assert.ok(lstatSync(f.pluginDir).isSymbolicLink())
    assert.equal(realpathSync(f.pluginDir), realpathSync(f.sourceDir))
    const result = applyMaintenancePlan(makeRollbackPlan(f))
    assert.ok(lstatSync(join(result.backupDir, 'plugin')).isSymbolicLink())
    assert.equal(readFileSync(join(f.sourceDir, 'client.js'), 'utf8'), '// fixture client\n')
  })
  test('默认 CLI 没有隐式 apply，脚本不运行 pnpm 或重启进程', () => {
    const install = readFileSync(join(here, '..', 'install.mjs'), 'utf8')
    const rollback = readFileSync(join(here, '..', 'rollback.mjs'), 'utf8')
    assert.ok(install.includes('runMaintenanceCli'))
    assert.ok(rollback.includes('runMaintenanceCli'))
    assert.ok(!install.includes('execSync') && !rollback.includes('execSync'))
  })
  console.log(`\n${passed} profile-maintenance tests passed, ${skipped} skipped`)
} finally {
  // 绝对目标只可能是本文件 mkdtemp 得到的专用临时根，绝不清理用户目录。
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
  assert.ok(basename(root).startsWith('growth-profile-maintenance-'))
  rmSync(root, { recursive: true, force: true })
}
