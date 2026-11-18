# etftrack  汪汪队 ETF 跟踪器

用于观察宽基 ETF 成交额与资金动向的仪表盘。当前机器本地使用 Python + SQLite；Cloudflare 部署使用 Worker + D1。两种模式共用 `static/` 页面和公开数据口径。

## 本地运行（macOS 12 可用）

- Finder 双击 `start.command`，自动启动服务并打开 `http://127.0.0.1:8765`。
- 或运行 `npm run dev`（等价于 `python3 app.py`）。数据库为 `data/etf_tracker.sqlite3`，首次启动从 `data/bootstrap.json` 初始化。
- 本地服务运行期间会按工作日北京时间 18:00、22:30、23:15 采集收盘数据，次日 00:30、08:30、13:30 继续补采；服务启动时也会先补采一次。页面盘中行情约每 20 秒刷新，统计数据约每 60 秒刷新。关闭服务后本机不再定时采集。
- SQLite schema 由 `migrations/*.sql` 版本化；Python 服务启动时自动应用未执行迁移。也可以手动运行 `npm run db:migrate:local`。

### 补齐 34 只跟踪 ETF 的近一年历史

应用数据库迁移后，首次联网从参考网页公开的份额缓存、交易所份额披露和新浪日 K 线补齐新增标的：

```sh
npm run db:migrate:local
npm run db:backfill:reference
```

回填日期默认是近 365 天至昨天，也可以用 `--start YYYY-MM-DD --end YYYY-MM-DD` 指定区间。日常更新和盘中估算会按数据库中的 `core` 名单动态采集；34 只参考篮子全部属于核心名单，`159339` 仍作为额外观察项。若使用 Cloudflare，先完成本地回填，再按下方“Cloudflare Worker + D1”步骤导出并合并本地历史。

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
   npm run db:sync:remote -- --remote
   ```

   `push-remote` 会先从当前本机 SQLite 重新生成 `data/d1-import.sql`（被 Git 忽略），默认只导出最近 7 个交易日，并按来源和完整度做单调更新：交易所正式份额不会被腾讯/参考数据覆盖，收盘快照不会被盘中快照覆盖，未完成成交不会覆盖完整成交，旧日期不会回退。完整历史可单独运行 `npm run db:export` 生成后，再把文件作为参数传入同步脚本。后续云端数据合并回本机：`npm run db:sync:local`；这会导出远端 D1 并按主键合并到本机 SQLite，不删除本机记录。

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

Worker 绑定 D1 和 `static/`，并按北京时间 18:00、22:30、23:15 采集收盘行情，次日 00:30、08:30、13:30 继续补采交易所份额。盘中 API 返回腾讯公开行情估算，不将行情份额当成交易所确认的正式份额历史。交易所份额按实际披露写入；只要有一只核心 ETF 披露就展示并标注覆盖数量（如 5/34），后续定时任务继续补采。个别 ETF 长期不披露时，Worker 会尝试用东方财富基金份额兜底并标注“含 x 只兜底”，交易所后续披露会覆盖兜底值。13:30 只补历史份额和前一收盘价，不写盘中快照。腾讯行情不可用时，定时采集改用东方财富行情兜底；实时内外盘估算仍以腾讯为准。

云端统计接口（`/api/dashboard`、`/api/pool-stats`、`/api/flow-overview`、`/api/flow-detail`）的聚合结果按 `app_meta.data_revision` 缓存在 D1 单行 `api_cache` 表中；常规请求只读取版本和缓存行，不再重复扫描历史份额/成交表。定时采集成功或本地同步完成后会更新 `data_revision`，使边缘缓存和 `api_cache` 自动失效。实时估算接口只使用静态 ETF 名单和腾讯公开行情，不读取 D1。

## 数据口径

- 重点 ETF 池汇总份额变化、成交额与内外盘估算。份额增减不能识别申赎主体；内外盘估算不能确认具体投资者身份。
- 份额展示不设固定缺口上限：当日有一只以上核心 ETF 披露就展示并标注覆盖；东方财富兜底数据单独标注，优先级低于交易所正式披露。
- 日成交额/成交量来自公开行情；估算不等于国家队真实成交明细。接口或交易所数据延迟时显示最近有效日期，并继续按最近优先顺序补采。
- Git 不包含本地 SQLite、Wrangler 状态、导入/导出 SQL 或任何 Cloudflare 凭据。
