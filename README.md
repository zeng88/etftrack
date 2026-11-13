# etftrack  汪汪队 ETF 跟踪器

用于观察宽基 ETF 成交额与资金动向的仪表盘。当前机器本地使用 Python + SQLite；Cloudflare 部署使用 Worker + D1。两种模式共用 `static/` 页面和公开数据口径。

## 本地运行（macOS 12 可用）

- Finder 双击 `start.command`，自动启动服务并打开 `http://127.0.0.1:8765`。
- 或运行 `npm run dev`（等价于 `python3 app.py`）。数据库为 `data/etf_tracker.sqlite3`，首次启动从 `data/bootstrap.json` 初始化。
- 本地服务运行期间会按工作日北京时间 23:15 尝试更新；页面盘中行情约每 20 秒刷新。关闭服务后本机不再定时采集。
- SQLite schema 由 `migrations/*.sql` 版本化；Python 服务启动时自动应用未执行迁移。也可以手动运行 `npm run db:migrate:local`。

## Cloudflare Worker + D1

Wrangler 的 Workerd 本地运行时要求 macOS 13.5+；本机 macOS 12 不支持 `npm run dev:worker`。该命令可在较新 macOS 或满足 glibc 2.35 的 Linux 容器运行。部署与远程 D1 管理不依赖本地 Workerd。

1. 安装 Node.js 22+ 并登录 Cloudflare：

   ```sh
   npm install
   npx wrangler login
   ```

2. `wrangler.jsonc` 已设置远端 D1 `etf`（database ID `d2fdb466-fe14-4053-812e-aa506ba3acd5`）。登录后先检查目标库，再应用迁移：

   ```sh
   npx wrangler d1 list
   npx wrangler d1 info etf
   npm run db:migrate:remote
   ```

3. 将当前本机历史数据幂等合并到远端 D1（不会清空数据库；执行前先检查目标表）：

   ```sh
   npm run db:export
   npm run db:sync:remote -- --remote
   ```

   手动生成的 SQL 位于 `data/d1-import.sql`，被 Git 忽略。后续云端数据合并回本机：`npm run db:sync:local`；这会导出远端 D1 并按主键合并到本机 SQLite，不删除本机记录。

4. 部署：

   ```sh
   npm run deploy
   ```

### GitHub Actions 自动部署

推送到 `main` 后，`.github/workflows/deploy-cloudflare.yml` 会安装依赖、运行测试，并使用 Wrangler 部署 Worker。也可以在 GitHub 的 **Actions → Deploy to Cloudflare Workers → Run workflow** 手动触发。

首次运行前，在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID。
- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token。建议用 `Edit Cloudflare Workers` 权限模板，并仅授权部署用的 Cloudflare 账户。

API Token 只保存在 GitHub Secrets，不能写入代码或提交到仓库。Cloudflare 原生 Workers Builds 若也启用，推送时可能重复部署；采用本 GitHub Actions 工作流后，可在 Worker 的 **Settings → Builds** 关闭原生 builds。

Worker 绑定 D1 和 `static/`，并配置 UTC 工作日 15:15（北京时间 23:15）计划采集。盘中 API 返回腾讯公开行情估算，不将行情份额当成交易所确认的正式份额历史。正式份额只有当日核心 ETF 全部从交易所取齐时才写入；缺项时保留最近完整确认日。

## 数据口径

- 重点 ETF 池汇总份额变化、成交额与内外盘估算。份额增减不能识别申赎主体；内外盘估算不能确认具体投资者身份。
- 日成交额/成交量来自公开行情；估算不等于国家队真实成交明细。接口或交易所数据延迟时显示最近有效日期。
- Git 不包含本地 SQLite、Wrangler 状态、导入/导出 SQL 或任何 Cloudflare 凭据。
