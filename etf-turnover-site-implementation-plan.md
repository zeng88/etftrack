# 汪汪队ETF跟踪器本地原型实施计划

> **执行方式：** 由当前会话连续实施。按已批准需求实现本地 SQLite 版；不添加或运行测试套件，使用构建外的启动、数据库读回和页面/API 检查验证可用性。

**Goal:** 在 `/Users/admin/Documents/etf-national-team-tracker` 交付可本地运行、带 SQLite 历史数据和每日更新能力的 ETF 资金跟踪器。

**Architecture:** Python 标准库负责本地 HTTP API、SQLite 和行情采集；原生 HTML/CSS/JS 与 SVG 提供仪表盘。数据仅绑定回环地址；后续由用户决定迁移到 Cloudflare Worker + D1。

**Tech Stack:** Python 3.14 标准库、SQLite、HTML/CSS/JavaScript、SVG。

**Spec:** `/Users/admin/Documents/etf-national-team-tracker/etf-turnover-tracker-design.md`

## Global Constraints

- 所有项目源码与 SQLite 文件均置于 `/Users/admin/Documents/etf-national-team-tracker`。
- 本地服务只绑定 `127.0.0.1`；页面打开时自动更新，服务运行期间交易日收盘后 18:45（Asia/Shanghai）也会自动更新。
- 导入参考快照后，交易所历史份额已补到 2026-11-13；20 只重点 ETF 每日合计份额有 251 个完整交易日数据点。
- 采集失败或行情日期未推进时，不覆盖最后成功数据。
- 份额申赎估算、盘中主动买卖估算、历史持仓标签彼此区分；不把推算写成国家队已确认交易。
- 当前阶段不使用 Git、npm、Cloudflare/D1、云端定时任务或发布服务。
- 不添加或运行测试套件；用 Python 编译、启动、数据库/API读回与服务访问检查验证功能。

## Review Focus

- 腾讯行情无响应/行数不足：保留旧数据并显示错误。
- 上游返回旧交易日：拒绝重复当作新快照。
- 某 ETF 字段缺失或数值不合法：整轮不写部分每日快照。
- 空数据库或种子仅部分写入：初始化应可安全重跑。
- 周末/休市日触发定时器：不写入重复交易日数据。

---

### Task 1: 本地项目骨架和数据导入

**Files:**
- Create: `app.py`
- Create: `schema.sql`
- Create: `data/bootstrap.json`
- Create: `README.md`
- Create: `static/index.html`

**Interfaces:**
- Produces: `initialize_db(path)` 与可直接运行的本地 HTTP 服务。

- [x] 从参考快照整理 24 只 ETF 元信息、20 只重点 ETF 的份额序列、2026-11-06 初始快照。
- [x] 建立 SQLite schema：ETF 元信息、每日观察、采集运行和设置表；创建/启动时幂等初始化。
- [x] 建立 Python 标准库服务器骨架，API 与静态文件由同一进程提供，仅监听回环地址。
- [x] 编写 README：启动命令、默认 URL、数据库位置和本地更新限制。

### Task 2: 数据采集与交易日更新

**Files:**
- Create: `collector.py`
- Modify: `app.py`

**Interfaces:**
- Produces: `collect_latest()`、`update_once(db_path)`、`last_run(db_path)`。

- [x] 解析腾讯公开行情返回的 ETF 报价、成交额、内外盘和份额。
- [x] 解析新浪 5 分钟 K 线，构建当日成交进度与历史同时点基线。
- [x] 校验来源日期和代码全集；获取失败或日期异常时保留最后成功数据。
- [x] 按交易日期/代码幂等写入每日记录，计算份额变化估算、20 日基线和主动买卖估算。
- [x] 提供 `POST /api/update`、页面打开自动刷新和本地 18:45 工作日调度。

### Task 3: 页面仪表盘和数据说明

**Files:**
- Modify: `static/index.html`
- Create: `static/app.js`
- Create: `static/styles.css`
- Modify: `app.py`（overview/history API）

**Interfaces:**
- Consumes: Task 1–2 的 SQLite 记录与 API。
- Produces: 总览、走势图、可筛选明细、数据说明和更新状态。

- [x] 建立研究仪表盘，展示交易日期、采集状态、更新按钮与估算说明。
- [x] 展示 20 只重点 ETF 合计份额变化柱状图和归一化加仓指数（近 3/6/12 月）。
- [x] 实现 24 只 ETF 搜索、分类筛选和排序；保留历史持有人标签的年份。
- [x] 将单只 ETF 留在图表下方的明细表；只绘制同日完整份额合计。
- [x] 实现页面打开自动更新、交易所历史份额回补、窄屏布局与 SVG 图表。
- [x] 说明数据来源、指标口径、历史持仓时点与身份不可验证限制。

### Task 4: 本地运行与交付检查

**Files:**
- Review: 项目下全部源码与 `data/etf_tracker.sqlite3`

- [x] 通过 Python 与 JavaScript 语法检查并启动本地服务。
- [x] 确认 SQLite 最新日期为 2026-11-13、24 只 ETF、20 只重点池和 251 个完整汇总点。
- [x] 确认首页、静态资源和 dashboard API 返回正常。
- [x] 启动本地预览服务并提供本地 URL、项目目录和更新方法。
