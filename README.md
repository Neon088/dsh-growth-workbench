# dsh-growth-workbench

给新媒体 / 电商运营 / 市场营销用的 DSH 工作台插件。数据全部落在你自己的 Obsidian vault 里，
工作台和 Obsidian 读写的是**同一批 md 文件**，没有同步进程、没有第二份副本。

装完即用、初始为空：插件只建目录骨架和几张空模板，你的数据由你自己从头填。

```
会话头部「📊 工作台」按钮 → 右侧栏面板（右侧栏不可用时自动退回浮层）
  顶栏：品牌 · 全局搜索（⌘K）· 设置 · 刷新 · 关闭
  页签：📊 运营 / 🛒 电商 / 📣 营销 / 🧰 通用
  每个页签首页 = 该区各卡的一行摘要，点一行进卡；Esc 退回摘要
  卡片可单独开关（cards.json 记忆），关掉的不占位
```

## 四个工作区与十四张卡

| 工作区 | 卡片 | 落在 vault 的哪里 |
| --- | --- | --- |
| 📊 运营 | 账号档案 | `Accounts/`（frontmatter 档案：平台 / 账号名 / 定位 / 目标人群，选题和平台版本按 id 引用） |
| | 灵感箱 | `Workbench/灵感箱.md`（一行一条，状态：新 / 已用 / 已废弃；已用的填「去向」） |
| | 内容 · 爆款拆解 | `Topics/`（一篇一个 md，frontmatter 存平台、日期、播放、点赞；type=拆解 的只进这张卡） |
| | 创作台 | 选题详情内联面板（自己的选题走这里：脚本进度 / 平台版本 / 风险自检 / 回流数据） |
| | 内容日历 | `Calendar/YYYY-MM.md`（一张月表，状态：在写 / 待发 / 已发 / 待回填 / 已归档） |
| | 待回流 | 已发布的平台版本逐条录数据（按天追加）；日历标了「已发」但没建版本的旧排期按选题回填。都写进 `Data/回流台账/YYYY-MM.md` |
| | 内容数据复盘 | `Data/回流台账/YYYY-MM.md`（按平台版本看播放 / 赞藏 / 评论 / 转发） |
| 🛒 电商 | 商品 / 竞品库 | `Products/`（frontmatter 档案，勾 2–4 个并排对比） |
| | 电商数据复盘 | `Data/*.md`（GMV / 流量 / 转化率 / ROI / 环比，frontmatter 存摘要） |
| | 客户反馈库 | `Feedback/客户反馈.md`（渠道 / 情感 / 标签 / 状态，负面未处理会亮红条） |
| 📣 营销 | 营销方案库 | `Campaigns/`（平台 / 状态 / 起止 / 预算 / 目标，模板含目标 / 预算与节奏 / 渠道 / 素材 / 复盘） |
| 🧰 通用 | SOP 树 | `SOP/`（目录树，点开读写；vault 根下没有 SOP/ 时以整个 vault 为根） |
| | 术语表 | `Workbench/指标与黑话.md`（中英名 / 领域 / 标签 / 备注） |
| | 文案规则 / 语调库 | `CopyRules/rules.md`（硬规则 / 软规则 / 待观察，计数表自动重算） |

另外：`Data/csv/` 存导入的原始 CSV，每次写回前在 `Workbench/.backups/` 留一份 `.bak`。

所有目录名都可用 `~/.dsh-growth/config.json`（或首次引导页）覆盖；目录不存在会自动创建。

## v2：主选题 × 平台版本

同一篇主选题可以拆成多个平台版本，每个版本有独立的状态机
（在写 → 待发 → 已发 → 待回填 → 已归档）、风险等级和发布前 7 项自检。
高风险版本必须 7/7 才能发布，风险等级「禁发」的版本不允许发布。

- 主选题：`Topics/<标题>.md`（frontmatter 有稳定 `id`、`sourceUrl`、`sourceTitle`）
- 平台版本：`Workbench/平台版本/<masterId>/<平台>-<账号>.md`
- 指标台账：`Data/回流台账/YYYY-MM.md`（同一天同一版本重复填写会覆盖，不新增行）
- 设置页有「v2 数据迁移」：预检 → 执行迁移，给老选题补稳定 ID，并给已有平台的选题建一个平台版本空壳；只增不删，可重复执行。

录数据的入口只有一个：「待回流」。创作台只负责把版本推进到「已发」，数据在待回流按版本逐天追加 ——
同一选题的不同平台版本各存各的，不会互相覆盖。

v2 API 前缀 `/api/dsh-growth/v2/`：`state`、`masters`、`masters/:id`、`masters/:id/variants`、
`variants`、`variants/:id`、`variants/:id/transition`、`variants/:id/metrics`、`matrix`、`queue`、
`pending`、`ledger`、`migration/preview`、`migration/apply`。

## 装

要求：Node.js ^22.19 或 ≥24，DSH ≥ 0.2.0-rc.1。

```powershell
# 方式一：DSH 插件命令（把路径换成你 clone 下来的位置）
dsh plugin --profile desktop add <本仓库路径>
```

```powershell
# 方式二：脚本直装（复制文件 + 登记 bundles/dependencies）
node install.mjs
```

装完重启 DSH 并刷新 Web GUI，会话头部会出现「📊 工作台」。第一次点开会引导填 vault 根目录
（存到 `~/.dsh-growth/config.json`，目录不存在会自动建，各板块目录骨架随即自动创建）。

## 卸载 / 回滚

DSH 桌面外壳把「加载失败的插件条目」当致命错误，一个起不来的插件会让整个应用起不来。
所以仓库里带了一条不依赖 DSH 的自救脚本：

```powershell
node rollback.mjs     # 或直接双击 run-rollback.bat
```

它会把 desktop profile 恢复成「没装过这个插件」的干净状态（bundle / dependencies / patch 残留 /
插件目录都清掉），`~/.dsh-growth/config.json` 保留，重装时不用重新填 vault 路径。

## 数据安全纪律

- Host 只注册 `/api/dsh-growth/*` 前缀路由，靠 DSH 的 webServer 服务分发；所有响应
  `{ok:true,…}` / `{ok:false,code,message}`。
- 写回都带 `expectedSha1`：Obsidian 那边改过就报 `conflict`，不会覆盖你手改的内容。
- 删除先备份再删（备份进 `Workbench/.backups/`）。
- 所有路径都在 vault 内解析，拒绝绝对路径和 `..`，只碰 `.md` / `.csv`。
- 事件推送只发 sha1 不发正文，客户端收到后自己按原接口重读。
- 外链白名单：只有 http/https/mailto 会渲染成可点击链接。

## 开发

```powershell
node test/lib.test.js        # table / vault / frontmatter / csv / rules
node test/data-safety.test.js
node test/rules.test.js
node test/security.test.mjs
node test/static.test.mjs
node test/e2e.mjs             # 真实 handler + 临时 vault
node test/p0a.test.mjs        # 稳定 ID / 来源链接 / 状态单源 / 回写回滚
node test/v2.test.mjs         # 平台版本状态机 / 指标台账 / 矩阵 / 队列
node test/migration.test.mjs  # 老选题迁移
node test/push.test.mjs       # pushToAgent 离线验证（不依赖浏览器）
node test/links.test.mjs      # 外链白名单离线验证
node --check index.js
node --check client.js
```

或一把跑齐：`npm test`（逐个文件顺序执行，见 package.json scripts.test）。

注意：本机沙箱里 `node --test test/` 会报 `spawn EPERM`，直接跑单个 `node test/*.mjs`。

## 目录说明

| 文件 / 目录 | 作用 |
| --- | --- |
| `index.js` | Host 半边：注册 `/api/dsh-growth/*` 路由、集合（collections）、配置引导与热重建 |
| `client.js` | 浏览器半边：头部按钮 + 右侧栏标签页 + 兜底浮层，全部卡片 UI |
| `lib/agent-tool.js` | 把「写回」变成 agent 真能调用的对话侧工具 |
| `lib/client-shared.js` | 卡片分包共用的 client.js 作用域 |
| `lib/coreutil-promise.js` | 把还在飞的 Promise 当值读（防止重复请求/竞态） |
| `lib/csv.js` | CSV 导入与存档（解析 / 列映射 / 数值提取） |
| `lib/domain.js` | v2 领域层：主选题 × 平台版本 × 指标台账（结构 + 状态机，不碰 HTTP/UI） |
| `lib/frontmatter.js` | frontmatter 笔记集合引擎（Topics/Campaigns/Data/Products/Accounts 共用） |
| `lib/migrate.js` | 老数据迁移（补稳定 id、建平台版本空壳，只增不删可重跑） |
| `lib/platforms.js` | 平台名归一（别名收敛成规范名，只读不改盘） |
| `lib/rules.js` | 文案规则库 parse/render（hard/soft/watch 三段） |
| `lib/table.js` | 通用 Markdown 表格的解析 / 校验 / 备份 / 原子写 |
| `lib/vault.js` | vault 直连：路径校验、sha1 冲突检测、备份、Obsidian URI 跳转 |
| `install.mjs` | 脚本直装（逐文件复制，处理 junction 开发态，见文件头注释） |
| `rollback.mjs` / `run-rollback.bat` | 一键回滚，不依赖 DSH 能启动 |
| `cordis.patch.yml` | 默认 config（vaultRoot、各板块目录名） |
| `tools/asar.mjs` | 开发辅助：列出 / 提取 app.asar 里的文件 |
| `test/` | 单元 + 端到端 + 静态守卫（见「开发」） |

## License

MIT
