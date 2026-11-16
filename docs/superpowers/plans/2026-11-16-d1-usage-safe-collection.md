# D1 额度友好采集实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让盘中行情刷新不消耗 D1 写入额度，并确保收盘行情只保存一次、官方份额缺失后持续补采。

**Architecture:** Worker 继续代理公开行情，收盘快照与份额历史分开管理；快照按交易日/代码幂等写入，官方份额按交易日追采至核心池完整。SQLite 本地采集采用相同的只写一次原则。

**Tech Stack:** Cloudflare Workers、D1、TypeScript、Python、SQLite。

**Spec:** `docs/superpowers/specs/2026-11-16-d1-usage-safe-collection-design.md`

## Global Constraints

- 盘中公开报价每20秒刷新，不写入 D1。
- D1 官方份额只把 SSE/SZSE 完整覆盖的数据作为确认数据。
- 未完成份额的交易日必须留在待补队列，由次日及后续 Cron 重试。
- 每次 Worker Cron 最多处理2个交易日，控制深圳逐只请求在 Free 每次50个外部子请求以内并保留跳转余量。
- 日常部署不得重新导入整份本地历史数据。

## Review Focus

- 份额已完整、行情快照已存在：重跑 Cron 不得覆盖/重复写快照。
- 份额未完整但快照已存在：重跑 Cron 必须继续请求官方来源并能补入份额。
- 快照写入失败或不完整：后续任务能补齐缺少的 ETF 行。
- 非交易日返回最近交易日行情：不得重复改写该交易日快照。

---

### Task 1: Worker 收盘快照幂等写入

**Files:**
- Modify: `src/collector.ts`

**Interfaces:**
- `collectConfirmedDaily(env, timestamp)` remains the scheduled entry point.

- [ ] 查询当日已有 `daily_snapshots` 与 `daily_activity` 的 ETF 代码；只为缺失代码创建写语句。
- [ ] 待补日期按最早未完成顺序最多取2个，并确保未完成的当前交易日也纳入本轮。
- [ ] 保存已获取的 SSE/SZSE 确认份额，重试时只请求缺失代码；不因快照已完整而跳过官方份额采集和待补日期重试。
- [ ] 测试 `shareRetryDates` 最多返回3天并保留当前未完成日；测试 `missingEtfsForDate` 只返回尚缺的代码。
- [ ] 验证 `npm test` 与 `npx wrangler deploy --dry-run` 通过。

### Task 2: SQLite 快照只写一次

**Files:**
- Modify: `app.py`

**Interfaces:**
- 本地定时/手动采集继续使用 `update_once()`。

- [ ] 本地 `/api/update` 只返回公开行情估算，不调用持久化采集器；服务启动只启动定时任务。
- [ ] 份额缺失状态在下一次调度后仍可进入现有交易所回补流程；盘中页面刷新不得产生 SQLite 写入。
- [ ] 验证 Python 语法和现有本地存储接口。

### Task 3: 变更审查与部署

**Files:**
- Review: `src/index.ts`, `wrangler.jsonc`, `static/app.js`

- [ ] 确认实时公开行情路由未新增 D1 写入，Cron 时间仍覆盖收盘采集和次日补采。
- [ ] 运行项目测试、前端/Python 语法检查、Worker dry-run。
- [ ] 推送 `main`，确认 Cloudflare 生产部署版本更新；额度耗尽时记录接口恢复需等待 UTC 午夜重置。
