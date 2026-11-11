import assert from 'node:assert/strict'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
      if (entry.isDirectory()) { result[key] = 'DIR'; walk(next, key) }
      else if (entry.isSymbolicLink()) result[key] = 'LINK:' + realpathSync(next)
      else result[key] = readFileSync(next, 'utf8')
    }
  }
  walk(dir, '')
  return result
}

async function invokeCli(operation, f, args = [], extra = {}) {
  const previousExitCode = process.exitCode, logs = [], errors = []
  try {
    const result = await runMaintenanceCli(operation, ['--profile', f.profileDir, ...args], {
      sourceDir: f.sourceDir, log: (text) => logs.push(text), errorLog: (text) => errors.push(text), ...extra,
    })
    return { result, logs, errors, exitCode: process.exitCode ?? 0 }
  } finally { process.exitCode = previousExitCode }
}
let childInvocation = 0
function withRealWrappers(f) {
  for (const file of ['install.mjs', 'rollback.mjs', join('lib', 'profile-maintenance.js')]) copyFileSync(join(here, '..', file), join(f.sourceDir, file))
  return f
}
function childCli(operation, f, args, stdinText) {
  const base = join(dirname(f.profileDir), 'cli-' + (++childInvocation))
  const stdoutPath = base + '.out', stderrPath = base + '.err', descriptors = []
  try {
    let input = 'ignore'
    if (stdinText !== undefined) { writeFileSync(base + '.in', stdinText, { flag: 'wx' }); input = openSync(base + '.in', 'r'); descriptors.push(input) }
    const stdout = openSync(stdoutPath, 'wx'); descriptors.push(stdout)
    const stderr = openSync(stderrPath, 'wx'); descriptors.push(stderr)
    // 文件描述符而不是 stdio:'pipe'，不在受限 Windows 沙箱创建命名管道。
    const result = spawnSync(process.execPath, [join(f.sourceDir, operation + '.mjs'), '--profile', f.profileDir, ...args], {
      cwd: f.sourceDir, env: { ...process.env }, stdio: [input, stdout, stderr], timeout: 10000,
    })
    if (result.error) throw result.error
    return { status: result.status, signal: result.signal, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') }
  } finally { for (const descriptor of descriptors) closeSync(descriptor) }
}
function clearOwnRegistration(f) {
  writeFileSync(f.packageFile, JSON.stringify({ name: 'isolated-profile', dsh: { profile: { bundles: ['other-plugin'] } }, dependencies: { 'other-plugin': '1' } }, null, 2) + '\n')
}
function backupDirs(f) {
  const path = join(f.profileDir, '.dsh-growth-backups')
  return existsSync(path) ? readdirSync(path).map((name) => join(path, name)) : []
}
function assertNoStaging(f) {
  assert.equal(readdirSync(join(f.profileDir, 'node_modules')).filter((name) => name.startsWith('.growth-stage-')).length, 0)
}

// String.raw 保留 YAML 源码里的字面反斜线，不能把漏洞样本误写成已解码的 name。
const escapedNameKey = String.raw`"na\u006de"`
const escapedOwnValue = String.raw`"dsh\u002dgrowth-workbench"`
const quotedIdentityYaml = [
  `- ${escapedNameKey}: "dsh-growth-workbench"\n`,
  `- {${escapedNameKey}: "dsh-growth-workbench"}\n`,
  `- "name": ${escapedOwnValue}\n`,
  `- "id": ${escapedOwnValue}\n`,
  `- {${escapedNameKey}: ${escapedOwnValue}}\n`,
  String.raw`- "n\x61me": "dsh-growth-workbench"` + '\n',
  String.raw`- {"\U0000006eame": "dsh-growth-workbench"}` + '\n',
  String.raw`- "i\u0064": "dsh-growth-workbench"` + '\n',
]
const nonScalarIdentityYaml = [
  '- name: [other-plugin, dsh-growth-workbench]\n',
  '- name: {value: dsh-growth-workbench}\n',
  '- id: [other-plugin, dsh-growth-workbench]\n',
  '- id: {value: dsh-growth-workbench}\n',
  `- name: [other-plugin, ${escapedOwnValue}]\n`,
  '- name:\n    - other-plugin\n    - dsh-growth-workbench\n',
  '- name:\n    value: dsh-growth-workbench\n',
  '- name: >-\n    dsh-growth-workbench\n',
  '- name: !!str dsh-growth-workbench\n',
  '- name: other-plugin\n  config:\n    ref: &growth dsh-growth-workbench\n- name: *growth\n',
  '- name: other-plugin\n  config:\n    ref: &growth dsh-growth-workbench\n- id: *growth\n  name: another-plugin\n',
  '- name: null\n', '- id: 42\n', '- name: true\n',
]
const unsupportedInsertYaml = [
  `- {insert: [{${escapedNameKey}: ${escapedOwnValue}}]}\n`,
  '- {insert: [{name: other-plugin}, {name: [other-plugin, dsh-growth-workbench]}]}\n',
  '- insert:\n    - insert:\n        - name: dsh-growth-workbench\n',
  '- id: action\n  insert:\n    - name: dsh-growth-workbench\n',
]
const unsupportedBareScalarYaml = [
  '- >-\n  dsh-growth-workbench\n',
  '- |\n  dsh-growth-workbench\n',
  '- insert:\n    - >+\n      dsh-growth-workbench\n',
  '- insert:\n    - |2-\n      dsh-growth-workbench\n',
]
const nonStringJsonItems = [
  { name: ['other-plugin', 'dsh-growth-workbench'] },
  { name: { value: 'dsh-growth-workbench' } },
  { id: ['other-plugin', 'dsh-growth-workbench'] },
  { id: { value: 'dsh-growth-workbench' } },
  { name: null }, { name: true }, { name: 42 }, { id: null },
]

try {
  await test('默认是预览，目标可显式选择，冲突参数拒绝', () => {
    assert.equal(parseMaintenanceArgs([]).apply, false)
    const fingerprint = 'a'.repeat(64)
    assert.equal(parseMaintenanceArgs(['--profile', root, '--apply', '--expected-plan', fingerprint]).profileDir, resolve(root))
    assert.equal(parseMaintenanceArgs(['--apply', '--expected-plan', fingerprint]).apply, true)
    assert.equal(parseMaintenanceArgs(['--confirm']).confirm, true)
    assert.throws(() => parseMaintenanceArgs(['--apply']), /expected-plan/)
    assert.throws(() => parseMaintenanceArgs(['--apply', '--expected-plan', 'bad']), /SHA256/)
    assert.throws(() => parseMaintenanceArgs(['--expected-plan', fingerprint]), /apply/)
    assert.throws(() => parseMaintenanceArgs(['--confirm', '--dry-run']))
    assert.throws(() => parseMaintenanceArgs(['--confirm', '--json']))
    assert.throws(() => parseMaintenanceArgs(['--apply', '--confirm', '--expected-plan', fingerprint]))
    assert.throws(() => parseMaintenanceArgs(['--apply', '--dry-run']))
    assert.throws(() => parseMaintenanceArgs(['--profile']))
    assert.throws(() => parseMaintenanceArgs(['--guess']))
  })
  await test('YAML 只移除精确插件项，相似名/提及/注释和 CRLF 保留', () => {
    const text = '# before\r\n- name: other-plugin\r\n  config:\r\n    note: dsh-growth-workbench\r\n- name: "dsh-growth-workbench"\r\n  config:\r\n    vaultRoot: D:/Notes\r\n# keep next comment\r\n- name: dsh-growth-workbench-extra\r\n  config: {}\r\n'
    const result = removePluginYaml(text)
    assert.equal(result.removed, 1)
    assert.equal(result.text, '# before\r\n- name: other-plugin\r\n  config:\r\n    note: dsh-growth-workbench\r\n# keep next comment\r\n- name: dsh-growth-workbench-extra\r\n  config: {}\r\n')
  })
  await test('insert 嵌套块可精确移除，其它插件配置保留', () => {
    const text = '- insert:\n    - id: unrelated\n      name: other-plugin\n      config: {}\n    - id: dsh-growth-workbench\n      name: \'dsh-growth-workbench\'\n      config:\n        key: value\n- insert:\n  - name: dsh-growth-workbench-extra\n    config: {}\n'
    const result = removePluginYaml(text)
    assert.equal(result.removed, 1)
    assert.ok(result.text.includes('name: other-plugin'))
    assert.ok(result.text.includes('name: dsh-growth-workbench-extra'))
    assert.ok(!result.text.includes('key: value'))
  })
  await test('空 insert 显式 []，根空列表保留注释；重复运行无修改', () => {
    assert.equal(removePluginYaml('- insert:\n    - name: dsh-growth-workbench\n').text, '- insert: []\n')
    const cleaned = removePluginYaml('# keep\n- name: dsh-growth-workbench\n').text
    assert.equal(cleaned, '# keep\n[]\n')
    assert.deepEqual(removePluginYaml(cleaned), { text: cleaned, removed: 0 })
    assert.equal(removePluginYaml('- insert:\n  - name: dsh-growth-workbench\n').text, '- insert: []\n')
  })
  await test('未知 flow/嵌套名称拒绝猜测，而普通提及不会触发删除', () => {
    assert.throws(() => removePluginYaml('- { name: dsh-growth-workbench, config: {} }\n'), /不能安全定位/)
    assert.throws(() => removePluginYaml('plugins:\n  - name: dsh-growth-workbench\n'), /不能安全定位/)
    const text = '- name: other-plugin\n  config:\n    message: dsh-growth-workbench\n'
    assert.equal(removePluginYaml(text).text, text)
  })
  await test('YAML 锚点或别名拒绝猜测，不产生其它插件的悬空引用', () => {
    assert.throws(() => removePluginYaml('- name: &plugin dsh-growth-workbench\n  config: {}\n'), /不能安全定位/)
    assert.throws(() => removePluginYaml('- name: dsh-growth-workbench\n  config: &shared\n    enabled: true\n- name: other-plugin\n  config: *shared\n'), /锚点或别名/)
    assert.throws(() => removePluginYaml('- name: dsh-growth-workbench\n  config: *shared\n'), /锚点或别名/)
  })
  await test('JSON Cordis 列表精准保留其它插件', () => {
    const result = removePluginYaml(JSON.stringify([{ name: 'other-plugin' }, { name: 'dsh-growth-workbench' }, { insert: [{ name: 'dsh-growth-workbench-extra' }, { name: 'dsh-growth-workbench' }] }]))
    assert.equal(result.removed, 2)
    assert.deepEqual(JSON.parse(result.text), [{ name: 'other-plugin' }, { insert: [{ name: 'dsh-growth-workbench-extra' }] }])
  })
  await test('安装预览无写入；提交保留完整旧目录和 package 备份', () => {
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
  await test('卸载备份每个受影响配置，隔离目录且不删插件配置/笔记', () => {
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
  await test('未知 YAML 使整个计划失败，不先改 package 或 plugin', () => {
    const f = fixture()
    writeFileSync(join(f.profileDir, 'cordis.yml'), '- { name: dsh-growth-workbench, config: {} }\n')
    const before = snapshot(f.profileDir)
    assert.throws(() => makeRollbackPlan(f), /不能安全定位/)
    assert.deepEqual(snapshot(f.profileDir), before)
  })
  await test('预览后用户改 package 会拒写，保持用户的新值和旧插件', () => {
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
  await test('staging 后出现的并发修改也拒写，不切换旧插件', () => {
    const f = fixture()
    mkdirSync(f.pluginDir)
    writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
    const plan = makeInstallPlan(f)
    assert.throws(() => applyMaintenancePlan(plan, { beforeCommit() { writeFileSync(f.packageFile, '{"newUserValue":1}') } }), (error) => error.code === 'profile_conflict')
    assert.equal(readFileSync(f.packageFile, 'utf8'), '{"newUserValue":1}')
    assert.ok(existsSync(join(f.pluginDir, 'old.txt')))
    assert.equal(readdirSync(join(f.profileDir, 'node_modules')).filter((name) => name.startsWith('.growth-stage-')).length, 0)
  })
  await test('源码或插件 entry 在预览后改变会拒写', () => {
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
  await test('部分配置已提交后失败，会恢复配置与旧插件', () => {
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
  await test('开发 junction 保留并补注册；卸载只隔离链接，不删除源目录', () => {
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
  await test('文档边界标记使内存解析及整份临时回滚计划拒写', () => {
    for (const text of ['---\n- name: dsh-growth-workbench\n', '- name: dsh-growth-workbench\n...\n', '\uFEFF---\r\n- name: dsh-growth-workbench\r\n---\r\n- name: other-plugin\r\n']) {
      const f = fixture(); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
      writeFileSync(join(f.profileDir, 'cordis.yml'), text)
      const before = snapshot(f.profileDir)
      assert.throws(() => removePluginYaml(text), /文档边界/)
      assert.throws(() => makeRollbackPlan(f), /文档边界/)
      assert.deepEqual(snapshot(f.profileDir), before)
      assert.equal(backupDirs(f).length, 0)
    }
  })
  await test('quoted key 与 targeted flow 拒绝整次修改，相似名称保持不动', () => {
    for (const text of ['- "name": dsh-growth-workbench\n', "- 'name': dsh-growth-workbench\n", '- { name: dsh-growth-workbench, config: {} }\n', '[{name: dsh-growth-workbench}]\n', '- name: [dsh-growth-workbench]\n', '- name: [npm:dsh-growth-workbench@0.2.0]\n', '- { "name": "npm:dsh-growth-workbench@0.2.0", config: {} }\n']) {
      const f = fixture(); writeFileSync(join(f.profileDir, 'cordis.patch.yml'), text)
      const before = snapshot(f.profileDir)
      assert.throws(() => removePluginYaml(text), /不能安全定位|不支持的 flow YAML/)
      assert.throws(() => makeRollbackPlan(f), /不能安全定位|不支持的 flow YAML/)
      assert.deepEqual(snapshot(f.profileDir), before)
      assert.equal(backupDirs(f).length, 0)
    }
    const other = '- "name": dsh-growth-workbench-extra\n  config: {}\n'
    assert.deepEqual(removePluginYaml(other), { text: other, removed: 0 })
    const mention = '- { name: other-plugin, config: { note: dsh-growth-workbench } }\n'
    assert.deepEqual(removePluginYaml(mention), { text: mention, removed: 0 })
  })
  await test('合法转义 quoted name/id 键按解码身份拒写，不依赖原文字面插件名', () => {
    assert.equal(JSON.parse(escapedNameKey), 'name')
    assert.notEqual(escapedNameKey, '"name"')
    assert.deepEqual(JSON.parse(`{${escapedNameKey}: "dsh-growth-workbench"}`), { name: 'dsh-growth-workbench' })
    for (const text of quotedIdentityYaml) assert.throws(() => removePluginYaml(text), /不能安全定位/, text)
  })
  await test('quoted name/id 的 Unicode 转义值不能绕过整次拒写', () => {
    assert.equal(JSON.parse(escapedOwnValue), 'dsh-growth-workbench')
    assert.ok(escapedOwnValue.includes(String.raw`\u002d`))
    for (const key of ['"name"', '"id"', escapedNameKey]) {
      for (const value of [escapedOwnValue, String.raw`"\x64sh-growth-workbench"`, String.raw`"dsh\U0000002dgrowth-workbench"`]) {
        assert.throws(() => removePluginYaml(`- ${key}: ${value}\n`), /不能安全定位/)
        assert.throws(() => removePluginYaml(`- {${key}: ${value}}\n`), /不能安全定位/)
      }
    }
  })
  await test('真实 YAML 插件项的非string name/id 拒写，容器目标不必是首项或直接值', () => {
    for (const text of nonScalarIdentityYaml) assert.throws(() => removePluginYaml(text), /不能安全定位|name\/id/, text)
    assert.throws(() => removePluginYaml('- name: dsh-growth-workbench\n  id: {value: other-plugin}\n'), /name\/id/)
    assert.throws(() => removePluginYaml('- {name: other-plugin, id: [unrelated, another-plugin]}\n'), /name\/id/)
  })
  await test('JSON root/insert 插件项均先验证 string name/id，不产生局部清理结果', () => {
    for (const item of nonStringJsonItems) {
      for (const input of [[{ name: 'dsh-growth-workbench' }, item], [{ insert: [{ name: 'dsh-growth-workbench' }, item] }]]) {
        assert.throws(() => removePluginYaml(JSON.stringify(input)), /name\/id/)
      }
    }
    assert.throws(() => removePluginYaml(JSON.stringify([{ id: 'dsh-growth-workbench', name: 'other-plugin' }])), /不能安全定位/)
  })
  await test('合法 JSON 的转义 string 身份精准移除，非身份配置提及保持不动', () => {
    const other = { name: 'other-plugin', id: 'other-id', config: { name: ['other-plugin', 'dsh-growth-workbench'], id: { value: 'dsh-growth-workbench' } } }
    const text = `[{${escapedNameKey}: ${escapedOwnValue}}, ${JSON.stringify(other)}, {"insert":[{${escapedNameKey}: ${escapedOwnValue}},{"name":"dsh-growth-workbench-extra"}]}]`
    const result = removePluginYaml(text)
    assert.equal(result.removed, 2)
    assert.deepEqual(JSON.parse(result.text), [other, { insert: [{ name: 'dsh-growth-workbench-extra' }] }])
    const unchanged = JSON.stringify([other, { name: 'dsh-growth-workbench-extra' }])
    assert.deepEqual(removePluginYaml(unchanged), { text: unchanged, removed: 0 })
  })
  await test('unowned quoted/flow/嵌套配置里的 name/id、普通提及及相似名称逐字保留', () => {
    const cases = [
      `- ${escapedNameKey}: "dsh-growth-workbench-extra"\n`,
      `- "name": "dsh\\u002dgrowth-workbench-extra"\n`,
      String.raw`- 'na\u006de': dsh-growth-workbench` + '\n',
      `- {${escapedNameKey}: "other-plugin", config: {name: dsh-growth-workbench, id: [other-plugin, dsh-growth-workbench]}}\n`,
      '- {name: dsh-growth-workbench-extra, config: {note: "dsh-growth-workbench", list: [other-plugin, dsh-growth-workbench]}}\n',
      '- name: other-plugin\n  config:\n    name: dsh-growth-workbench\n    id: {value: dsh-growth-workbench}\n    list:\n      - name: dsh-growth-workbench\n        id: [dsh-growth-workbench]\n',
      '- {insert: [{name: other-plugin, config: {name: dsh-growth-workbench}}, {name: dsh-growth-workbench-extra}]}\n',
      '- name: other-plugin\n  config:\n    message: "name: dsh-growth-workbench"\n',
      '- name: other-plugin\n  config:\n    name: !!str dsh-growth-workbench\n    id: >-\n      dsh-growth-workbench\n',
      '- name: other-plugin\n  config:\n    ref: &growth dsh-growth-workbench\n    name: *growth\n',
    ]
    for (const text of cases) {
      assert.deepEqual(removePluginYaml(text), { text, removed: 0 }, text)
      const cleaned = removePluginYaml(text + '- name: dsh-growth-workbench\n')
      assert.equal(cleaned.removed, 1)
      assert.equal(cleaned.text, text)
    }
  })
  await test('安全普通列表和裸 string 插件名可解码 Unicode/YAML 转义后精准移除', () => {
    for (const value of [escapedOwnValue, String.raw`"\x64sh-growth-workbench"`, String.raw`"dsh\U0000002dgrowth-workbench"`]) {
      assert.deepEqual(removePluginYaml(`- name: ${value}\n`), { text: '[]\n', removed: 1 })
      assert.deepEqual(removePluginYaml(`- ${value}\n`), { text: '[]\n', removed: 1 })
    }
  })
  await test('不支持的 flow/深层 insert 识别真实身份后整次拒写，不扫描 config 提及', () => {
    for (const text of unsupportedInsertYaml) assert.throws(() => removePluginYaml(text), /不能安全定位|name\/id/, text)
  })
  await test('裸 block scalar 插件项在根列表与 insert 中都整次拒写', () => {
    for (const text of unsupportedBareScalarYaml) assert.throws(() => removePluginYaml(text), /不能安全定位/, text)
  })
  await test('所有新漏检样本使整个临时 makeRollbackPlan 拒写，两个配置及已安装 entry 均不动', () => {
    const texts = [...quotedIdentityYaml, ...nonScalarIdentityYaml, ...unsupportedInsertYaml, ...unsupportedBareScalarYaml, ...nonStringJsonItems.map((item) => JSON.stringify([{ name: 'dsh-growth-workbench' }, { insert: [item] }]))]
    for (const text of texts) {
      for (const unsafeFile of ['cordis.yml', 'cordis.patch.yml']) {
        const f = fixture()
        mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old installation must remain')
        mkdirSync(join(f.pluginDir, 'nested')); writeFileSync(join(f.pluginDir, 'nested', 'state.json'), '{"keep":true}\n')
        writeFileSync(join(f.profileDir, 'vault-note.md'), 'must remain')
        writeFileSync(join(f.profileDir, 'growth-config.json'), '{"personal":true}\n')
        for (const file of ['cordis.yml', 'cordis.patch.yml']) writeFileSync(join(f.profileDir, file), file === unsafeFile ? text : '- name: dsh-growth-workbench\n- name: other-plugin\n')
        const before = snapshot(f.profileDir), identity = lstatSync(f.pluginDir)
        assert.throws(() => removePluginYaml(text), /不能安全定位|name\/id/)
        assert.throws(() => makeRollbackPlan(f), /不能安全定位|name\/id/, text)
        assert.deepEqual(snapshot(f.profileDir), before)
        const after = lstatSync(f.pluginDir)
        assert.deepEqual([after.dev, after.ino, after.birthtimeMs], [identity.dev, identity.ino, identity.birthtimeMs])
        assert.equal(backupDirs(f).length, 0); assertNoStaging(f)
      }
    }
  })
  await test('真实 CLI 默认及 JSON dry-run 都不写，公开稳定指纹', async () => {
    const f = fixture(), before = snapshot(f.profileDir)
    const first = await invokeCli('install', f), second = await invokeCli('install', f, ['--dry-run', '--json'])
    assert.equal(first.result.status, 'preview'); assert.equal(first.exitCode, 0)
    assert.equal(second.result.status, 'preview'); assert.equal(second.exitCode, 0)
    const visible = JSON.parse(second.logs[0])
    assert.match(visible.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(visible.fingerprint, first.result.plan.fingerprint)
    assert.equal(visible.dryRun, true)
    assert.deepEqual(snapshot(f.profileDir), before)
  })
  await test('install/rollback --confirm 取消都无写，确认前只有一次展示', async () => {
    for (const operation of ['install', 'rollback']) {
      const f = fixture(), before = snapshot(f.profileDir)
      let confirmations = 0
      const outcome = await invokeCli(operation, f, ['--confirm'], { confirmPlan(visible) { confirmations++; assert.match(visible.fingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(snapshot(f.profileDir), before); return false } })
      assert.equal(outcome.result.status, 'cancelled'); assert.equal(outcome.exitCode, 0)
      assert.equal(confirmations, 1)
      assert.equal(outcome.logs.filter((line) => line.startsWith('计划指纹 SHA256：')).length, 1)
      assert.deepEqual(snapshot(f.profileDir), before)
    }
  })
  await test('同进程确认应用展示的同一指纹，备份 manifest 绑定原计划', async () => {
    for (const operation of ['install', 'rollback']) {
      const f = fixture(), before = snapshot(f.profileDir)
      const expected = maintenancePlanFingerprint(operation === 'install' ? makeInstallPlan(f) : makeRollbackPlan(f))
      let seen, confirmations = 0
      const outcome = await invokeCli(operation, f, ['--confirm'], { confirmPlan(visible) { confirmations++; seen = visible.fingerprint; assert.deepEqual(snapshot(f.profileDir), before); return true } })
      assert.equal(outcome.result.status, 'applied'); assert.equal(outcome.exitCode, 0)
      assert.equal(confirmations, 1); assert.equal(seen, expected)
      assert.equal(outcome.result.plan.fingerprint, expected)
      assert.equal(JSON.parse(readFileSync(join(outcome.result.result.backupDir, 'manifest.json'), 'utf8')).fingerprint, expected)
    }
  })
  await test('确认期间修改 profile 或源码拒绝原计划，不重新规划后偷偷应用', async () => {
    for (const target of ['profile', 'source']) {
      const f = fixture(); let afterEdit
      const outcome = await invokeCli('install', f, ['--confirm'], { confirmPlan() {
        if (target === 'profile') writeFileSync(f.packageFile, readFileSync(f.packageFile, 'utf8') + '\n')
        else writeFileSync(join(f.sourceDir, 'client.js'), '// changed after prompt\n')
        afterEdit = snapshot(f.profileDir); return true
      } })
      assert.equal(outcome.result.status, 'error'); assert.equal(outcome.exitCode, 1)
      assert.equal(outcome.result.error.code, 'profile_conflict')
      assert.deepEqual(snapshot(f.profileDir), afterEdit)
      assert.equal(backupDirs(f).length, 0); assertNoStaging(f)
    }
  })
  await test('跨两次 CLI 绑定预览指纹，未变化时可执行且只输出一份 JSON', async () => {
    for (const operation of ['install', 'rollback']) {
      const f = fixture(), preview = await invokeCli(operation, f, ['--json'])
      const fingerprint = JSON.parse(preview.logs[0]).fingerprint
      const outcome = await invokeCli(operation, f, ['--apply', '--expected-plan', fingerprint, '--json'])
      assert.equal(outcome.result.status, 'applied'); assert.equal(outcome.exitCode, 0)
      assert.equal(outcome.logs.length, 1)
      const output = JSON.parse(outcome.logs[0]); assert.equal(output.fingerprint, fingerprint); assert.equal(output.dryRun, false)
      assert.equal(JSON.parse(readFileSync(join(output.backupDir, 'manifest.json'), 'utf8')).fingerprint, fingerprint)
    }
  })
  await test('跨次预览后 profile 变化拒写，裸 --apply 也不碰 profile', async () => {
    const f = fixture(), preview = await invokeCli('rollback', f, ['--json'])
    writeFileSync(f.packageFile, readFileSync(f.packageFile, 'utf8') + '\n')
    const before = snapshot(f.profileDir)
    const stale = await invokeCli('rollback', f, ['--apply', '--expected-plan', preview.result.plan.fingerprint])
    const bare = await invokeCli('rollback', f, ['--apply'])
    assert.equal(stale.result.status, 'error'); assert.equal(stale.result.error.code, 'profile_conflict')
    assert.equal(bare.result.status, 'error'); assert.match(bare.errors[0], /expected-plan/)
    assert.deepEqual(snapshot(f.profileDir), before); assert.equal(backupDirs(f).length, 0)
  })
  await test('指纹绑定操作和绝对 profile，不能将 A 的确认借给 B', async () => {
    const a = fixture(), b = fixture(), preview = await invokeCli('install', a, ['--json'])
    const beforeA = snapshot(a.profileDir), beforeB = snapshot(b.profileDir)
    const wrongProfile = await invokeCli('install', b, ['--apply', '--expected-plan', preview.result.plan.fingerprint])
    const wrongOperation = await invokeCli('rollback', a, ['--apply', '--expected-plan', preview.result.plan.fingerprint])
    assert.equal(wrongProfile.result.error.code, 'profile_conflict')
    assert.equal(wrongOperation.result.error.code, 'profile_conflict')
    assert.deepEqual(snapshot(a.profileDir), beforeA); assert.deepEqual(snapshot(b.profileDir), beforeB)
  })
  await test('安装源码内容及新增/删除文件集合变化均拒绝跨次确认', async () => {
    for (const mutation of ['content', 'added-lib', 'added-optional', 'removed-lib']) {
      const f = fixture(), preview = await invokeCli('install', f, ['--json']), before = snapshot(f.profileDir)
      if (mutation === 'content') writeFileSync(join(f.sourceDir, 'client.js'), '// changed source\n')
      else if (mutation === 'added-lib') writeFileSync(join(f.sourceDir, 'lib', 'new.js'), 'export const added = true\n')
      else if (mutation === 'added-optional') writeFileSync(join(f.sourceDir, 'README.md'), 'new optional source\n')
      else {
        const path = resolve(f.sourceDir, 'lib', 'fixture.js')
        assert.equal(dirname(path), resolve(f.sourceDir, 'lib')); assert.equal(basename(path), 'fixture.js')
        rmSync(path)
      }
      const outcome = await invokeCli('install', f, ['--apply', '--expected-plan', preview.result.plan.fingerprint])
      assert.equal(outcome.result.status, 'error'); assert.equal(outcome.result.error.code, 'profile_conflict')
      assert.deepEqual(snapshot(f.profileDir), before); assert.equal(backupDirs(f).length, 0)
    }
  })
  await test('无变化或原不存在 YAML 也是输入，即便计划无动作也拒绝陈旧确认', async () => {
    for (const target of ['unchanged-yaml', 'missing-yaml', 'unchanged-package']) {
      const f = fixture(); clearOwnRegistration(f)
      if (target === 'unchanged-yaml') writeFileSync(join(f.profileDir, 'cordis.yml'), '- name: other-plugin\n')
      const plan = makeRollbackPlan(f), fingerprint = publicMaintenancePlan(plan).fingerprint
      assert.equal(plan.changes.length, 0); assert.equal(plan.pluginAction, 'none')
      if (target === 'unchanged-yaml') writeFileSync(join(f.profileDir, 'cordis.yml'), '- name: other-plugin\n# user changed\n')
      else if (target === 'missing-yaml') writeFileSync(join(f.profileDir, 'cordis.patch.yml'), '- name: other-plugin\n')
      else writeFileSync(f.packageFile, readFileSync(f.packageFile, 'utf8') + '\n')
      const before = snapshot(f.profileDir)
      assert.throws(() => applyMaintenancePlan(plan), (error) => error.code === 'profile_conflict')
      const stale = await invokeCli('rollback', f, ['--apply', '--expected-plan', fingerprint])
      assert.equal(stale.result.error.code, 'profile_conflict')
      assert.deepEqual(snapshot(f.profileDir), before); assert.equal(backupDirs(f).length, 0)
    }
  })
  await test('原 plugin entry 的原地内容变化及外来替换都必须重新确认', async () => {
    for (const mutation of ['in-place', 'replacement']) {
      const f = fixture(); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
      const plan = makeInstallPlan(f)
      if (mutation === 'in-place') writeFileSync(join(f.pluginDir, 'old.txt'), 'user edited old entry')
      else {
        const parked = resolve(f.profileDir, 'node_modules', 'parked-old')
        assert.equal(dirname(parked), resolve(f.profileDir, 'node_modules')); assert.equal(basename(f.pluginDir), 'dsh-growth-workbench')
        renameSync(f.pluginDir, parked); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'foreign.txt'), 'user replacement')
      }
      const before = snapshot(f.profileDir)
      assert.throws(() => applyMaintenancePlan(plan), (error) => error.code === 'profile_conflict')
      assert.deepEqual(snapshot(f.profileDir), before); assert.equal(backupDirs(f).length, 0)
    }
  })
  await test('staging 后源码集合或无变化 YAML 变化拒绝切换旧插件', () => {
    for (const mutation of ['source-set', 'unchanged-yaml']) {
      const f = fixture(); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old')
      writeFileSync(join(f.profileDir, 'cordis.yml'), '- name: other-plugin\n')
      const plan = makeInstallPlan(f), packageBefore = readFileSync(f.packageFile, 'utf8')
      assert.throws(() => applyMaintenancePlan(plan, { beforeCommit() {
        if (mutation === 'source-set') writeFileSync(join(f.sourceDir, 'lib', 'new.js'), 'export const late = true\n')
        else writeFileSync(join(f.profileDir, 'cordis.yml'), '- name: other-plugin\n# late user edit\n')
      } }), (error) => error.code === 'profile_conflict')
      assert.equal(readFileSync(f.packageFile, 'utf8'), packageBefore)
      assert.equal(readFileSync(join(f.pluginDir, 'old.txt'), 'utf8'), 'old'); assertNoStaging(f)
      assert.equal(backupDirs(f).length, 1)
    }
  })
  await test('安装失败遇到外来 replacement/原地用户变更不移走它，旧备份保留并报恢复失败', () => {
    for (const mutation of ['replacement', 'in-place']) {
      const f = fixture(); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old installation')
      const plan = makeInstallPlan(f), packageBefore = readFileSync(f.packageFile, 'utf8')
      let foreignBefore, foreignIdentity, injected = false
      assert.throws(() => applyMaintenancePlan(plan, { beforeConfigWrite() {
        injected = true
        if (mutation === 'replacement') {
          const parked = resolve(f.profileDir, 'node_modules', 'parked-current-install')
          assert.equal(dirname(parked), resolve(f.profileDir, 'node_modules')); assert.equal(basename(f.pluginDir), 'dsh-growth-workbench')
          renameSync(f.pluginDir, parked); mkdirSync(f.pluginDir)
        }
        writeFileSync(join(f.pluginDir, 'foreign.txt'), 'must not move or overwrite')
        foreignBefore = snapshot(f.pluginDir)
        const stat = lstatSync(f.pluginDir); foreignIdentity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
        throw new Error('injected install config failure')
      } }), (error) => /injected install config failure/.test(error.message) && /自动恢复未完成/.test(error.message) && /备份/.test(error.message))
      assert.equal(injected, true); assert.deepEqual(snapshot(f.pluginDir), foreignBefore)
      const stat = lstatSync(f.pluginDir); assert.deepEqual({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }, foreignIdentity)
      assert.equal(readFileSync(f.packageFile, 'utf8'), packageBefore)
      const backups = backupDirs(f); assert.equal(backups.length, 1)
      assert.equal(readFileSync(join(backups[0], 'plugin', 'old.txt'), 'utf8'), 'old installation')
      assert.equal(readFileSync(join(backups[0], 'package.json.bak'), 'utf8'), packageBefore)
      assert.equal(existsSync(join(backups[0], 'failed-install')), false)
      assert.equal(JSON.parse(readFileSync(join(backups[0], 'manifest.json'), 'utf8')).fingerprint, maintenancePlanFingerprint(plan))
      assertNoStaging(f)
    }
  })
  await test('没有外来替换时安装故障能恢复旧插件，失败新版单独留证', () => {
    const f = fixture(); mkdirSync(f.pluginDir); writeFileSync(join(f.pluginDir, 'old.txt'), 'old installation')
    const before = readFileSync(f.packageFile, 'utf8')
    assert.throws(() => applyMaintenancePlan(makeInstallPlan(f), { beforeConfigWrite() { throw new Error('injected ordinary install failure') } }), (error) => /injected ordinary install failure/.test(error.message) && !/自动恢复未完成/.test(error.message))
    assert.equal(readFileSync(join(f.pluginDir, 'old.txt'), 'utf8'), 'old installation')
    assert.equal(readFileSync(f.packageFile, 'utf8'), before)
    const backups = backupDirs(f); assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(backups[0], 'failed-install', 'client.js'), 'utf8'), '// fixture client\n')
    assert.equal(readFileSync(join(backups[0], 'package.json.bak'), 'utf8'), before)
    assertNoStaging(f)
  })
  await test('真实两个 Node 调用的 CLI 预览指纹可执行，陈旧指纹不能重用', () => {
    for (const operation of ['install', 'rollback']) {
      const f = withRealWrappers(fixture()), before = snapshot(f.profileDir)
      const preview = childCli(operation, f, ['--json'])
      assert.equal(preview.status, 0, preview.stderr); assert.equal(preview.signal, null)
      const visible = JSON.parse(preview.stdout); assert.equal(visible.dryRun, true)
      assert.deepEqual(snapshot(f.profileDir), before)
      const applied = childCli(operation, f, ['--apply', '--expected-plan', visible.fingerprint, '--json'])
      assert.equal(applied.status, 0, applied.stderr); const output = JSON.parse(applied.stdout)
      assert.equal(output.fingerprint, visible.fingerprint); assert.equal(output.dryRun, false)
      const after = snapshot(f.profileDir)
      const stale = childCli(operation, f, ['--apply', '--expected-plan', visible.fingerprint])
      assert.equal(stale.status, 1); assert.match(stale.stderr, /计划指纹不匹配/)
      assert.deepEqual(snapshot(f.profileDir), after)
    }
  })
  await test('真实 readline --confirm 取消无写，Y 确认只执行展示过的指纹', () => {
    for (const answer of ['\n', 'Y\n']) {
      const f = withRealWrappers(fixture()), before = snapshot(f.profileDir)
      const expected = maintenancePlanFingerprint(makeInstallPlan(f))
      const outcome = childCli('install', f, ['--confirm'], answer)
      assert.equal(outcome.status, 0, outcome.stderr)
      assert.equal((outcome.stdout.match(/计划指纹 SHA256：/g) ?? []).length, 1)
      assert.ok(outcome.stdout.includes(expected))
      if (answer === '\n') { assert.match(outcome.stdout, /已取消，没有写文件/); assert.deepEqual(snapshot(f.profileDir), before) }
      else {
        assert.match(outcome.stdout, /已完成，备份/)
        const backups = backupDirs(f); assert.equal(backups.length, 1)
        assert.equal(JSON.parse(readFileSync(join(backups[0], 'manifest.json'), 'utf8')).fingerprint, expected)
        assert.equal(readFileSync(join(f.pluginDir, 'client.js'), 'utf8'), '// fixture client\n')
      }
    }
  })
  await test('CLI/wrappers/bat 只规划一次并等待确认，不存在预览 A 再执行 B', () => {
    const code = readFileSync(join(here, '..', 'lib', 'profile-maintenance.js'), 'utf8')
    const cli = code.slice(code.indexOf('export async function runMaintenanceCli'))
    assert.equal((cli.match(/makeInstallPlan\s*\(/g) ?? []).length, 1)
    assert.equal((cli.match(/makeRollbackPlan\s*\(/g) ?? []).length, 1)
    for (const file of ['install.mjs', 'rollback.mjs']) assert.match(readFileSync(join(here, '..', file), 'utf8'), /await runMaintenanceCli\(/)
    const bat = readFileSync(join(here, '..', 'run-rollback.bat'), 'utf8')
    assert.equal((bat.match(/^\s*node\s+/gm) ?? []).length, 1)
    assert.match(bat, /node "%~dp0rollback\.mjs" --confirm/)
    assert.doesNotMatch(bat, /--apply/)
    const docs = readFileSync(join(here, '..', 'README.md'), 'utf8')
    assert.ok(docs.includes('node install.mjs --confirm'))
    assert.ok(docs.includes('node rollback.mjs --confirm'))
    assert.ok(docs.includes('--apply --expected-plan'))
  })
  await test('默认 CLI 没有隐式 apply，脚本不运行 pnpm 或重启进程', () => {
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
