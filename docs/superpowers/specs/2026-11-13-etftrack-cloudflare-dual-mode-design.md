# etftrack 本地与 Cloudflare 双模式设计

## 意图

把当前只在本机运行的汪汪队 ETF 跟踪器改造成同一套 Worker 应用，既能在本地用 SQLite 数据运行，也能部署到 Cloudflare Workers Free + D1。现有页面、历史数据和估算口径保留；项目目录与产品名统一为 `etftrack`。

## 成功标准

- `npm run dev` 在本地启动网站，页面/API/采集逻辑工作；本地 D1 使用 Wrangler 的 SQLite 持久化。
- `wrangler deploy` 部署同一份 Worker API 和静态页面，并通过绑定的 D1 工作。
- 提供明确的 D1 schema migration、现有 SQLite 数据导入、local/remote 方向性同步命令；同步默认 upsert，不清空目标库。
- Git 仓库关联到 `https://github.com/zeng88/etftrack.git`，项目源码和必要的非敏感种子数据推送到 `main`；运行时 SQLite、Wrangler 状态和密钥不进入 Git。
- 页面保留 20 秒更新体验，但每次轮询只进行轻量读取/行情请求，不触发完整采集或重复 D1 写入。
- 每日正式份额由 scheduled Worker 采集；未取得交易所确认的当日份额不写成已确认历史点，也不显示在份额图和统计表中。

## 非目标

- 不改变已有估算的金融含义，不声称能识别国家队身份。
- 不把 Cloudflare 账户密钥写入项目或 Git。
- 不使用 Workers Paid、其他托管数据库、付费行情源或额外图表框架。
- 不让访客的 20 秒页面轮询触发完整历史回填。

## 约束

- 保留当前原生 HTML/CSS/JS 前端与现有视觉设计。
- 保留 24 只 ETF、20 只重点 ETF、现有估算表及点击明细功能。
- 保留本机历史 SQLite 数据并导入到 Wrangler 本地 D1 和给定 Cloudflare D1：`d2fdb466-fe14-4053-812e-aa506ba3acd5`。
- D1 远端操作前先检查目标库已有表与数据；导入采用幂等 upsert，不删除未知远端数据。
- Cloudflare Cron 使用 UTC；交易所份额延迟时保留最后确认数据，后续重试回补。
- 免费计划要求 Worker 请求与 D1 行读写有预算；静态资源与 API 分离，页面轮询合并为单个 API 请求。

## 方案

1. **推荐：同一 TypeScript Worker + Wrangler D1 local/remote。** Wrangler 本地 D1 底层是 SQLite，生产环境只切换到远端 D1 binding。前端与业务接口只维护一份；Python 仅保留为导入/同步工具。需要把 Python HTTP、SQLite 访问和 collector 改成 Worker API、D1 binding 与 `fetch()`。
2. **本地 Python/SQLite + 另写 Cloudflare Worker/D1。** 本地改动少，但 API、采集逻辑、估算口径需要维护两份，容易产生本地与线上差异，不符合“保证两边都可用”的长期目标。
3. **Cloudflare Python Worker + D1。** Cloudflare 支持 Python Worker/D1，但当前 `http.server`、`sqlite3` 本地连接、`subprocess/curl` 和线程采集器不能原样部署；仍需适配 Worker 运行时，不能省掉平台改造。

选择方案 1：项目目前是单用户研究仪表盘，前端已与 API 分离，Wrangler 的本地 D1 正好提供 SQLite 本地运行与相同 Worker 代码；避免维护两套后端。现有 Python SQLite 文件通过批量转换和 Wrangler 导入迁移，不继续作为运行时数据库。

## 运行方式与数据流

- `npm run dev` 启动 Wrangler 本地 Worker；静态文件从 `static/` 服务，API 访问本地 D1。保留 `start.command` 双击启动并打开本地网页。
- `wrangler.jsonc` 定义 `DB` D1 binding、静态资源、兼容日期和 cron；local 与 production 使用同一 migration 序列。
- 首次迁移从现有 `data/etf_tracker.sqlite3` 导出受支持的表数据，写成分批 SQL/JSON，再由 Wrangler 对 local 或 remote 执行；后续同步有 `pull` 和 `push` 方向，均可重复执行且不做全库删除。
- Worker 路由保持 `/api/dashboard`、`/api/flow-detail`、`/api/pool-stats`、`/api/live-flow` 等前端接口语义。一个聚合接口支撑 20 秒更新，API 返回 `Cache-Control: no-store`，但不将 live quote 作为正式 share history 写入。
- scheduled handler 在北京时间 23:15（UTC 15:15）尝试官方份额回补，并对未到齐的代码保留上次确认记录；实时行情由页面轮询，不写 D1。

## 余项由实现者决定

- 保留原 Python 页面 API 代码为兼容工具还是在迁移后移入 `legacy/`；建议迁移完成后删除重复运行路径，只保留 SQLite 数据导入器。
- 为数据同步实现小批量 upsert，并在首次远端迁移前备份/检查目标 D1；任何远端 schema 冲突或现存数据冲突都先停下报告，不自动覆盖。
- 设计本地 seed 机制，使干净 clone 在无本机 SQLite 文件时也能装载历史数据并启动。
