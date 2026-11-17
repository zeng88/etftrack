# 热门宽基 ETF 实时成交走势 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本地和 Worker 页面加入可切换的两日热门宽基 ETF 实时累计成交额对比曲线。

**Architecture:** 新浪公开五分钟 K 线提供最近两个共同交易日的每段成交额，服务端转换成累计成交额；腾讯公开行情以最新累计成交额补齐当日末端。前端只消费一个动态接口并用 SVG 渲染，默认汇总九只 ETF 或切换单只。

**Tech Stack:** TypeScript Cloudflare Worker、Python 本地 HTTP 服务、原生 JavaScript/CSS/SVG、Node test runner。

**Spec:** `docs/superpowers/specs/2026-11-17-live-turnover-comparison-design.md`

## Global Constraints

- 不提交、不推送、不部署；仅保留本地改动。
- `/api/live-turnover` 不读取或写入 D1。
- 默认 9 只 ETF 的两日曲线由相同公开源生成；腾讯仅修正当日最新累计点。
- Worker 外部请求并发不超过五，edge cache TTL 为 20 秒。

## Review Focus

- 新浪个别 ETF 无两日数据时，聚合必须只使用同时具备两日数据的 ETF，并回传实际数量。
- 腾讯时间不是当日或早于最后五分钟点时，不得倒灌或重复累计成交额。
- 盘中、午休、收盘场景均应能显示最近有效曲线与对应时间。
- 单只切换与默认合计应使用同一数据口径，不能额外触发 D1 查询。
- 窄屏下选择器、图例、图表与数据说明不应横向溢出页面。

### Task 1: 公开曲线数据转换与 Worker 路由

**Files:**
- Modify: `src/collector.ts`
- Modify: `src/index.ts`
- Create: `tests/live-turnover.test.mjs`

**Interfaces:**
- Produces: `fetchLiveTurnoverComparison(): Promise<LiveTurnoverComparison>`。
- Produces: `GET /api/live-turnover` with a 20-second edge-cache response and no D1 access.

- [ ] Write fixtures asserting two-day cumulative aggregation, aggregate total, and a newer Tencent point.
- [ ] Run the new test and observe its failure before implementation.
- [ ] Implement parsing, two-session intersection, aggregate series, and bounded public requests in `src/collector.ts`.
- [ ] Add the D1-free cached Worker route in `src/index.ts`.
- [ ] Run the focused test and the full Node test suite.

### Task 2: 本地服务等价接口

**Files:**
- Modify: `collector.py`
- Modify: `app.py`
- Test: `tests/test_app_refresh.py`

**Interfaces:**
- Produces: `fetch_live_turnover_comparison(path: str | None = None) -> dict[str, Any]`.
- Produces: local `GET /api/live-turnover`.

- [ ] Add a local API route test and observe the missing-route failure.
- [ ] Implement the same public-source transformation and endpoint without database persistence.
- [ ] Run the Python test suite.

### Task 3: 可切换曲线组件

**Files:**
- Modify: `static/index.html`
- Modify: `static/app.js`
- Modify: `static/readability.css`

**Interfaces:**
- Consumes: `/api/live-turnover` response from Tasks 1–2.
- Produces: responsive panel after `flow-overview-panel`, selector, legend, latest comparison, and SVG paths.

- [ ] Add the semantic panel skeleton and controls.
- [ ] Add loading, selection, 20-second refresh, resilient error state, and SVG rendering.
- [ ] Add desktop and mobile styles.
- [ ] Run JavaScript syntax validation, Node tests, Python tests, and Worker dry-run build.
