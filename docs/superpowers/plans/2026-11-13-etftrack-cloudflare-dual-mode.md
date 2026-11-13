# etftrack Cloudflare 双模式改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目改为单一 TypeScript Worker，在 Wrangler 本地 D1/SQLite 与指定 Cloudflare D1 上运行，并安全迁移历史数据、设置 GitHub 仓库和每日采集。

**Architecture:** 原生前端静态资源保留；Worker 负责 API、行情采集和 scheduled handler；D1 作为唯一 SQL 接口，本地由 Wrangler 提供持久化 SQLite，云端使用绑定的 D1。Python 只用于从现有 SQLite 生成/同步 D1 数据，不再运行网站服务。

**Tech Stack:** TypeScript、Cloudflare Workers、Wrangler、D1、原生 HTML/CSS/JS、Python sqlite3 导入工具、Node `node:test`。

**Spec:** `docs/superpowers/specs/2026-11-13-etftrack-cloudflare-dual-mode-design.md`

## Global Constraints

- 项目根目录为 `/Users/admin/Documents/etftrack`，远端为 `https://github.com/zeng88/etftrack.git`。
- 生产 D1 binding 为 `DB`，database id 为 `d2fdb466-fe14-4053-812e-aa506ba3acd5`。
- 本地开发必须显式使用 Wrangler local D1；不得让日常开发命令写入远端 D1。
- 远端导入/同步只允许幂等 upsert；不得自动清空或覆盖未知表/数据。
- 静态资产路径保持 `static/`；浏览器 20 秒内只请求一个轻量聚合 API，不触发完整 collector 或 D1 写操作。
- 交易所确认的份额与腾讯实时行情份额字段分离；未确认份额不可显示为正式日份额变化。
- 数据采集失败时保留最后成功快照；数据和凭据之外的源代码/文档/迁移配置全部推送到 GitHub。
- D1 Cron 以 UTC 配置；交易所份额未发布时保留旧数据，下一次计划任务回补。

## Review Focus

- 干净 clone 没有 `data/etf_tracker.sqlite3`：本地 D1 初始化后仍能通过 bootstrap 启动并补齐数据。
- D1 数据库已有表或部分历史记录：同步脚本不删除数据，重复运行不造成重复行。
- 份额接口只返回部分 ETF 或未更新当日：不会写入/展示不完整或盘中份额。
- 多个访客同时 20 秒轮询：不触发重复的全量采集或日常写操作。
- Cron 在周末、节假日、UTC/北京时间跨日及交易所延迟发布时：使用正确交易日并保留最近确认值。
- 当前 Cloudflare 免费配额的 50 subrequest/次和 10 ms CPU 限制：采集流程被批量化或拆为安全批次。

---

### Task 1: 初始化 etftrack 仓库和 Wrangler Worker 基础

**Files:**
- Rename project root to `/Users/admin/Documents/etftrack`
- Create: `package.json`, `wrangler.jsonc`, `src/index.ts`
- Modify: `.gitignore`, `start.command`, project docs

**Interfaces:**
- Produces Worker `fetch(request, env, ctx)` entry and D1 binding `env.DB`.
- Serves `/api/*` through the Worker and all other paths through `env.ASSETS` from `static/`.

- [ ] 建立 Node `node:test` 脚本，覆盖静态 asset fallback、未知 API 的 404 和 JSON headers。
- [ ] 添加 Wrangler/TypeScript package scripts、`DB` binding、static assets 和 `.wrangler/state` 持久化目录。
- [ ] 将 `start.command` 改为启动本地 `wrangler dev` 并打开本地地址，开发时不访问 remote D1。
- [ ] 用 Wrangler 本地启动，确认首页、CSS、JS 和 API shell 返回正确状态。

### Task 2: D1 migrations 与 SQLite 种子导入/同步工具

**Files:**
- Create: `migrations/0001_initial_schema.sql`
- Create: `scripts/sqlite_to_d1.py`, `scripts/sync-d1.sh`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- `npm run db:migrate:local` applies the migration to local SQLite-backed D1.
- `npm run db:migrate:remote` explicitly applies the same migration to remote D1.
- `npm run db:sync:remote` imports current local SQLite rows with upsert after remote preflight.
- `npm run db:sync:local` merges a D1 export into local D1 without dropping unrelated tables.

- [ ] 建立 SQLite fixture 测试，验证所有六张业务表的导入 SQL 行数、值、转义与重复导入幂等性。
- [ ] 将 `schema.sql` 迁为 versioned D1 migration，保留所有 dashboard 所需表和索引。
- [ ] 编写 Python exporter，以有界批次输出 INSERT/UPSERT；排除 Wrangler 元表及空值/时间格式错误。
- [ ] 编写 local/remote migration/import/export wrappers，默认 dry-run/显示目标；remote push 要求明确 `--remote`。
- [ ] 将生成的临时 SQL、Wrangler credentials/state、node_modules、数据库文件排除出 Git。
- [ ] 对当前本地 SQLite 生成迁移包并导入 local D1，核对 ETF、份额、活动、收盘和快照行数。

### Task 3: Worker D1 read APIs 与业务计算

**Files:**
- Create: `src/db.ts`, `src/read-model.ts`, `tests/read-model.test.ts`
- Modify: `src/index.ts`, `static/app.js`

**Interfaces:**
- `loadDashboard(db, {code, days})`, `loadFlowDetail(db, date)`, `loadPoolStatistics(db, days)` provide the existing response shapes.
- `/api/dashboard` returns dashboard, pool statistics, and provisional live flow in one response.
- `/api/flow-detail` continues to reject unconfirmed daily share dates.

- [ ] 先为 D1 read-model 写测试，固定份额差、买入/赎回估算、完整覆盖和未确认日期隐藏行为。
- [ ] 使用 D1 prepared statements / batches 实现同口径 dashboard、图表、表格和明细查询。
- [ ] 将 20 秒 polling 合并为一个 GET；移除浏览器每轮调用全量 `/api/update`。
- [ ] 检查 API 使用的 D1 query 数不超过每次 invocation 的免费限制。
- [ ] 在本地 Worker+D1 SQLite 下运行测试并核对与当前 SQLite read model 的关键输出一致。

### Task 4: Worker 行情采集器、live quote 与 Cron

**Files:**
- Create: `src/collector.ts`, `tests/collector.test.ts`
- Modify: `src/index.ts`, `wrangler.jsonc`

**Interfaces:**
- `fetchLiveQuotes(fetcher, etfs)` returns non-persistent current quote estimate.
- `collectConfirmedDaily(db, fetcher, scheduledTime)` writes only validated official daily data.
- Worker `scheduled()` executes weekday catch-up at 15:15 UTC (23:15 Asia/Shanghai).

- [ ] 为 provider parser tests 覆盖字段缺失、格式错误、来源日期落后、ETF 覆盖不完整。
- [ ] 以 Worker `fetch()` 重写腾讯批量 quote 与交易所/Sina 数据请求，移除 `subprocess/curl` 和 Python thread pool。
- [ ] 盘中 live flow 只返回，不写 D1；官方份额未覆盖全部 20 只时保持最后完整确认日。
- [ ] Cron 汇总采集与 gap backfill；批量请求不超过 Workers Free subrequest 限额，需拆分时使用可重试的阶段状态。
- [ ] 配置工作日 scheduled trigger，测试本地 ad-hoc Cron、非交易日和未发布数据时保持旧值。

### Task 5: 前端接口接入、文档和本地启动

**Files:**
- Modify: `static/app.js`, `static/index.html`, `README.md`, `etf-turnover-site-implementation-plan.md`, `etf-turnover-tracker-design.md`
- Delete after cutover: `app.py`, `collector.py`, `storage.py`, `update_data.py`, `schema.sql`

**Interfaces:**
- Local default URL is Wrangler's `http://127.0.0.1:8787`.
- `npm run dev`, `start.command`, and documented local/remote database scripts work from project root.

- [ ] 更新前端到组合 dashboard response，保留现有图表、统计区间、详情交互和 20 秒 live-refresh。
- [ ] 更新 README 说明本地 SQLite D1、remote D1 binding、migration、同步、cron 时间和免费配额注意事项。
- [ ] 删除已不再执行的 Python web server/collector/read-model，保留仅用于 SQLite 导入的工具。
- [ ] 确认不带本机 SQLite 的 Git clone 可以 migrate + bootstrap 后启动本地网站。

### Task 6: 现有数据远端迁移、账号验证与 GitHub 推送

**Files:**
- Modify: `wrangler.jsonc`, migration/import scripts, `.gitignore`
- Push: all project source, migrations, docs, tests, and bootstrap data

**Interfaces:**
- Remote D1 target ID exactly `d2fdb466-fe14-4053-812e-aa506ba3acd5`.
- Remote migration/import commands are idempotent and leave unrelated remote data intact.

- [ ] 先用 Wrangler 检查登录态、账户及指定 D1 的名称/表/记录；冲突时停下并保留数据。
- [ ] 若目标库为空或只有兼容迁移表，应用 schema migration，再以 upsert 导入 SQLite 当前数据。
- [ ] 回读远端 ETF 数、历史份额、日活动、收盘记录和最新确认日期，与 SQLite 做计数比对。
- [ ] 在本地完整运行 `node --test`、Wrangler local D1 migration、启动、API 和页面资源检查。
- [ ] 初始化 Git main，设置用户指定的 origin；审阅 staged files，确保无 SQLite、密钥和 Wrangler state 后提交并推送所有代码。
