# DSH Growth Workbench

DeepSeek Harness 的内容运营工作台。选题、排期、发布、数据回填和复盘集中在一个侧边栏中，业务数据直接保存在自己的 Obsidian vault 里。

当前版本为 `0.2.0`，仍在迭代测试。项目主要面向个人创作者和小型内容运营团队，目前只支持 DSH，不是 Codex、Claude Code 等 Agent 的通用插件。

## 能做什么

- 管理平台账号、账号定位和目标人群。
- 收集灵感，拆解案例，建立自己的内容选题。
- 为同一选题创建不同平台、不同账号的独立版本。
- 按月排期，也可以一次为多个平台创建版本和日历记录。
- 记录实际发布时间、观察天数和累计数据快照。
- 保存阶段复盘；结案后仍可补录数据或开启新一轮观察。
- 管理商品、客户反馈、营销方案、SOP、术语和文案规则。

## 内容流程

每个平台版本独立流转：

```text
在写 → 待发 → 已发 → 待回填 → 已结案
```

发布前可以取消版本。已经发布的内容不会退回“在写”，避免把发布事实和编辑状态混在一起。

“已结案”只表示本轮观察结束，不会锁死数据。之后补录的数据会进入待复核状态，也可以另开一轮观察。“收纳”仅将版本移出日常列表，不改变状态，也不删除文件。

## 数据保存在哪里

工作台没有独立数据库，Markdown 文件就是数据源。默认目录如下：

| 内容 | 目录 |
| --- | --- |
| 账号档案 | `Accounts/` |
| 主选题与案例拆解 | `Topics/` |
| 平台版本 | `Workbench/平台版本/<masterId>/` |
| 内容日历 | `Calendar/YYYY-MM.md` |
| 数据台账 | `Data/回流台账/YYYY-MM.md` |
| 阶段复盘 | `Workbench/复盘结案/<variantId>/` |
| 商品与竞品 | `Products/` |
| 客户反馈 | `Feedback/客户反馈.md` |
| 营销方案 | `Campaigns/` |
| SOP | `SOP/` |
| 文案规则 | `CopyRules/rules.md` |

首次打开工作台时需要填写 vault 根目录。各业务目录可以在设置中修改，插件只管理这个 vault 内的文件。

不同日期的累计数据会分别保留。同一天再次保存时只更新当天记录，不会丢失之前日期的快照。排行榜使用每个版本的最新累计快照，不会把多日累计值重复相加。

## 环境要求

- Windows
- Node.js `22.19+` 或 `24+`
- DeepSeek Harness `0.2.0-rc.1+`
- 一个可读写的 Obsidian vault

其他操作系统尚未经过完整验证。

## 安装

克隆仓库并进入项目目录：

```powershell
git clone https://github.com/Neon088/dsh-growth-workbench.git
cd dsh-growth-workbench
```

先查看安装计划。此命令不会修改文件：

```powershell
node install.mjs
```

确认路径和改动无误后执行安装：

```powershell
node install.mjs --confirm
```

如果使用的不是默认 `desktop` profile，请明确指定 profile 目录：

```powershell
node install.mjs --profile "D:\DSH\profiles\my-profile" --confirm
```

在自动化环境中，可以先输出安装计划和指纹，再执行这份已确认的计划：

```powershell
node install.mjs --json
node install.mjs --apply --expected-plan <上一步输出的指纹>
```

两次执行之间如果源码或 DSH 配置发生变化，原指纹会失效，需要重新预览。

安装脚本会注册插件并备份受影响的 DSH 配置，不会安装依赖，也不会自动重启 DSH。完成后重新加载或重启 DSH，在会话头部打开“增长工作台”，再按引导填写 vault 路径。

## 更新与回滚

更新源码后重新运行安装脚本：

```powershell
git pull
node install.mjs --confirm
```

需要撤回插件注册时，先查看回滚计划，再确认执行：

```powershell
node rollback.mjs
node rollback.mjs --confirm
```

回滚不会删除 Obsidian 笔记和工作台用户配置。安装和回滚产生的配置备份保存在所选 profile 的 `.dsh-growth-backups/`。

## 数据保护

- 修改或删除现有文件前，在 `Workbench/.backups/` 留存备份。
- 保存时检查文件是否已被其他程序修改，发生冲突时拒绝覆盖。
- 写入过程中使用临时文件替换，避免留下不完整文件。
- 拒绝绝对路径、父目录跳转和指向 vault 外部的链接路径。

这些保护用于降低误写风险，不能替代 vault 自身的版本控制或定期备份。Markdown 表格也不适合多人同时编辑同一份数据。

## 旧数据迁移

设置页中的“v2 数据迁移”可以为旧选题补充稳定 ID，并按平台建立版本。迁移会先预检，只新增所需结构，不删除原笔记，也可以重复运行。

旧状态无法证明内容已经实际发布时，迁移不会擅自创建发布记录。执行前仍建议备份 vault 或提交一次版本控制快照。

## Agent 工具

在 DSH 提供 `tools` 服务时，插件会注册 `growth_vault`。Agent 可以查看板块和笔记、修改 frontmatter、替换章节或追加内容。

该工具使用与工作台相同的路径限制、冲突检查和备份机制。发布、结案和观察周期仍在工作台界面中完成。

## 开发与测试

运行离线验证：

```powershell
npm run verify
```

该命令执行语法检查、未定义引用扫描和 18 套隔离测试。测试使用临时目录，不会读写真实 vault。

浏览器界面测试需要本机已有 React、Playwright 和 Chrome：

```powershell
npm run test:browser
```

测试脚本不会自动下载依赖，也不会连接正在运行的 DSH。隔离浏览器测试通过后，仍需在实际 DSH 主题和窗口尺寸下做一次人工检查。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| `index.js` | DSH 入口、HTTP API、配置和业务编排 |
| `client.js` | 侧边栏界面与交互 |
| `lib/domain.js` | 平台版本、发布、指标和观察周期规则 |
| `lib/vault.js` | 路径限制、冲突检查、备份和文件写入 |
| `lib/table.js` | Markdown 表格读写 |
| `lib/frontmatter.js` | frontmatter 读写 |
| `lib/migrate.js` | 旧数据迁移 |
| `lib/agent-tool.js` | `growth_vault` Agent 工具 |
| `lib/profile-maintenance.js` | 安装与回滚 |
| `test/` | 离线测试与浏览器界面测试 |

## 已知限制

- 仅针对 DeepSeek Harness 开发。
- 目前主要在 Windows 上测试。
- 项目仍在快速迭代，更新前请查看提交记录并保留备份。
- 浏览器隔离测试不能代替 DSH 内的实际使用验收。

## License

[MIT](LICENSE)
