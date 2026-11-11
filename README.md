# dsh-growth-workbench

DeepSeek Harness 的新媒体运营工作台插件，给做新媒体、电商、营销的人用。

做运营的日常就是这些事：记选题、拆爆款、排日历、发完录数据、定期翻复盘。这些我原来都记在 Obsidian 里，这个插件把它们搬进了 DSH 的侧边栏——工作台和 Obsidian 读写的是同一批 md 文件，没有第二份副本，也不存在同步这回事。

装完是空的，只建目录骨架和几张空模板，数据自己填。

## 有什么

会话头部有个「工作台」按钮，点开是右侧栏（右侧栏打不开时会退回浮层）。顶栏有全局搜索、设置和刷新。四个页签对应四类工作，每张卡都能在设置里单独关掉：

| 页签 | 卡片 | 存在哪 | 说明 |
| --- | --- | --- | --- |
| 运营 | 账号档案 | `Accounts/` | 平台、账号名、定位、目标人群；选题和平台版本按 id 引用账号 |
| 运营 | 灵感箱 | `Workbench/灵感箱.md` | 一行一条灵感，状态 新/已用/已废弃，用掉的填去向 |
| 运营 | 爆款拆解（别人的） | `Topics/` | 别人的爆款，一篇一个 md，frontmatter 记平台、日期、播放、点赞 |
| 运营 | 我的选题 | 选题详情面板 | 自己的选题：脚本进度、平台版本、风险自检、回流数据 |
| 运营 | 内容日历 | `Calendar/YYYY-MM.md` | 一张月表，状态 在写/待发/已发/待回填/已归档 |
| 运营 | 待回填数据 | — | 发了的版本逐天录数据，数据录入只有这一个入口 |
| 运营 | 数据复盘 | `Data/回流台账/YYYY-MM.md` | 按平台版本看播放、赞藏、评论、转发 |
| 电商 | 商品 / 竞品库 | `Products/` | frontmatter 档案，勾 2–4 个并排对比 |
| 电商 | 电商数据复盘 | `Data/*.md` | GMV、流量、转化率、ROI、环比 |
| 电商 | 客户反馈库 | `Feedback/客户反馈.md` | 渠道、来源（平台 / 文章视频笔记 / 自家或竞品商品）、情感、标签、状态，负面未处理亮红条 |
| 营销 | 营销方案库 | `Campaigns/` | 平台、状态、起止、预算、目标 |
| 通用 | SOP 树 | `SOP/` | 目录树直接读写；vault 根下没有 SOP/ 时以整个 vault 为根 |
| 通用 | 术语表 | `Workbench/指标与黑话.md` | 中英名、领域、标签、备注 |
| 通用 | 文案规则 / 语调库 | `CopyRules/rules.md` | 硬规则 / 软规则 / 待观察，计数表自动重算 |

导入的 CSV 存 `Data/csv/`；每次写回之前在 `Workbench/.backups/` 留一份 `.bak`。所有目录名都能改（首次引导页或 `~/.dsh-growth/config.json`），不存在的目录会自动建。

## 一篇选题拆几个平台发

这是 v2 的主要场景。一篇主选题可以拆出多个平台版本，每个版本自己走 在写 → 待发 → 已发 → 待回填 → 已归档 的流程，有自己的风险等级和发布前 7 项自检——高风险版本 7 项全过才能发，标了「禁发」的不允许发布。

文件这么放：主选题在 `Topics/<标题>.md`（frontmatter 带稳定 id 和来源链接），平台版本在 `Workbench/平台版本/<masterId>/<平台>-<账号>.md`，指标记在 `Data/回流台账/YYYY-MM.md`。同一天同一版本重复录会覆盖旧行，不会越记越多。同一选题的抖音版本和小红书版本各存各的，互不干扰。

老数据不用手工搬：设置页有「v2 数据迁移」，先预检再执行，给老选题补稳定 id、给已有平台的选题建一个平台版本空壳。只增不删，跑几遍结果都一样。

## 装

需要 Node 22+（或 24），DSH 0.2.0-rc.1 以上。

```powershell
# clone 下来后用 DSH 的插件命令装（路径换成你的）
dsh plugin --profile desktop add <仓库路径>

# 没有 dsh 命令时，先看脚本准备改什么
node install.mjs

# 同一次运行中展示计划，输入 Y 后才应用这份计划
node install.mjs --confirm

# 不用 desktop profile 的话，明确指定目录
node install.mjs --profile "D:\DSH\profiles\my-profile" --confirm

# 跨两次调用：预览输出 fingerprint，再绑定该指纹执行
node install.mjs --profile "D:\DSH\profiles\my-profile" --json
node install.mjs --profile "D:\DSH\profiles\my-profile" --apply --expected-plan <预览中的64位指纹>
```

脚本默认纯预览，不会隐式安装依赖或重启应用。`--confirm` 在同一进程中展示计划并等待确认，直接回车取消；跨两次调用必须带预览输出的 `--expected-plan` 指纹，单独 `--apply` 会拒绝。指纹绑定操作、profile、配置输入（含未改动或原不存在的 YAML）、插件入口及安装源码文件集合；任一输入变化都要重新预览。执行时先暂存新版、备份改动的配置和旧目录。开发环境已经连到当前源码的目录链接会保留，但仍会检查 profile 里的注册。

装完重启 DSH、刷新页面，会话头部出现「工作台」按钮。第一次点开会引导填 vault 根目录，填完各板块目录骨架自动建好。改源码不等于已经更新了运行中的宿主：客户端热重载还取决于对应构建 watcher，Host 侧代码要重新加载后才生效。

## 出问题了

插件加载失败可能让 DSH 无法正常打开。用 `node rollback.mjs --confirm` 在同一次运行内预览并确认；双击 `run-rollback.bat` 也只启动这一份计划，取消不会回滚。需要跨两次调用时，先跑 `node rollback.mjs --json`，再用相同 `--profile` 参数执行 `node rollback.mjs --apply --expected-plan <预览中的64位指纹>`。其它 profile 用 `--profile` 指定。

回滚只移除增长工作台的精确注册项，不重置其它插件。改动的配置和旧插件入口留在所选 profile 的 `.dsh-growth-backups/`，开发目录链接只隔离链接本身。vault 笔记和增长工作台的用户配置都保留。复杂 YAML 无法安全定位时会整次拒写，不会先改一半再报成功。安装中途失败会尝试恢复；若插件入口已被第三方替换或改动，会保留该入口和旧备份，并明确报告自动恢复未完成，不强行覆盖。这个脚本不是通用的 DSH 修复器，回滚后是否能启动仍要实际检查。

## 数据这块

- 编辑器保存和版本删除用读取时的 sha1 检查冲突，不自动拿新指纹强行重试
- 只改正文时保留原来的 YAML；策划字段只发字段补丁，不把平台脚本写进主选题
- 同一文件的写入排队；备份失败就停下，创建新笔记不覆盖已有文件
- Markdown 台账只读写对应的主表，副表保留；主表有歧义会拒绝修改
- 删除先备份再删，备份在 `Workbench/.backups/`
- 所有路径限制在 vault 里面，绝对路径和 `..` 一律拒绝，也只碰 `.md` 和 `.csv`
- 事件推送只发文件指纹不发内容，客户端收到后自己重读；未保存草稿不会被旧读取结果覆盖
- 外链只有 http/https/mailto 会渲染成可点击

列表接口会返回筛选后的总数、分页位置和是否还有后续；关联旧记录也可以按完整路径或稳定 ID 读取。刷新时编辑器保持挂载，保存失败会留下草稿和重试入口。

## 开发

```powershell
node --check index.js
node --check client.js
npm test

# 另跑真实 React / Chrome 的隔离页面验证
npm run test:browser
```

默认逐个跑 15 个测试文件。每个子进程的 home 和临时目录都独立放在 `test/.artifacts/unit/`，避免启动日志落到真实用户目录；运行前后还会核对源码指纹。每个文件的 stdout、stderr 都会单独留存，报告附日志指纹和退出码。用例摘要和跳过原因保留原样，不靠退出码猜数量。lib、data-safety、rules、security、static 检查库和静态约束；e2e、p0a 用临时 vault 和模拟 Host 请求，不是浏览器端到端测试。v2、migration 检查平台版本和迁移，push、links 验证离线行为。backend-regressions、backend-pagination 补数据安全和列表边界，client-behavior 检查延迟响应、事件和保存队列，profile-maintenance 用临时 profile 检查安装回滚。跳过的个别用例会明说，不当成已验证。

浏览器测试另跑，因为需要机器上已有的 Playwright、React 和 Chrome。它只使用内存中的模拟 API 和独立浏览器目录，不访问运行中的 DSH、不读写真实 vault，也不自动下载依赖。已有工具不在 desktop profile 时，可用 `GROWTH_TEST_PROFILE` 和 `GROWTH_TEST_CHROME` 指定；证据保存在 `test/.artifacts/browser/`。默认检查入口、保存与异步行为，并以 440、520、600px × 模拟浅深主题检查有内容的首页、创作、日历和回填表。截图和排版、对比度检查只代表隔离组件，不代表实际宿主主题。`--smoke` 只跑入口；`--calendar-warning-only` 是单场景诊断，不能当作全套通过。缺少工具或某个场景失败不能算浏览器通过，最终还要在实际宿主里验收。

Windows 受限环境可能不允许 `node --test` 的进程管道，测试脚本因此顺序执行各文件。客户端仍是单个入口：宿主加载器不能解析客户端相对模块，不要直接把卡片拆成相对 import。

## 目录

| 文件 | 干嘛的 |
| --- | --- |
| `index.js` | Host 侧入口：注册 `/api/dsh-growth/*` 路由、14 张卡、配置引导 |
| `client.js` | 浏览器侧入口：头部按钮、右侧栏页签、各卡片界面 |
| `lib/vault.js` | vault 直连：路径校验、sha1 冲突检测、备份、Obsidian URI 跳转 |
| `lib/table.js` | Markdown 表格的解析、校验、原子写 |
| `lib/frontmatter.js` | frontmatter 笔记集合引擎，Topics/Campaigns/Products/Accounts 共用 |
| `lib/domain.js` | v2 领域层：主选题 × 平台版本 × 指标台账，不碰 HTTP 和界面 |
| `lib/migrate.js` | 老数据迁移，只增不删可重跑 |
| `lib/csv.js` | CSV 导入与存档 |
| `lib/rules.js` | 文案规则库的解析和渲染 |
| `lib/platforms.js` | 平台名归一，别名收敛成规范名 |
| `lib/agent-tool.js` | 把写回暴露成 agent 能调用的对话侧工具 |
| `lib/client-shared.js`、`lib/coreutil-promise.js` | 旧拆包实验的保留文件，当前客户端不调用 |
| `lib/profile-maintenance.js` | 安装回滚计划、精确配置修改、备份和并发检查 |
| `install.mjs`、`rollback.mjs`、`run-rollback.bat` | 先预览再确认的安装与回滚入口 |
| `test/run-tests.mjs` | 隔离 home、临时目录和源码指纹的顺序回归入口 |
| `test/browser-safety.test.mjs` | 真实 React / Chrome 隔离页面验证 |
| `cordis.patch.yml` | 默认配置（vault 根、各板块目录名） |
| `tools/asar.mjs` | 开发辅助：查看和提取 app.asar 里的文件 |

## 协议

MIT
