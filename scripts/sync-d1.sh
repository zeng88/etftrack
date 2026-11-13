#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  export)
    python3 scripts/sqlite_to_d1.py "${@:2}"
    ;;
  pull-local)
    EXPORT_FILE="${2:-data/d1-export.sql}"
    npx wrangler d1 export etf --remote --output "$EXPORT_FILE"
    python3 scripts/merge_d1_export.py "$EXPORT_FILE"
    ;;
  push-remote)
    if [[ "${2:-}" != "--remote" ]]; then
      echo "安全保护：请显式传入 --remote，示例：npm run db:sync:remote -- --remote"
      exit 2
    fi
    IMPORT_FILE="${3:-data/d1-import.sql}"
    if [[ ! -f "$IMPORT_FILE" ]]; then
      python3 scripts/sqlite_to_d1.py --output "$IMPORT_FILE"
    fi
    echo "目标 D1：etf（${D1_DATABASE_ID:-wrangler.jsonc 中配置的 ID}）"
    echo "将按主键幂等 upsert 导入 $IMPORT_FILE；不会清空表或删除未知记录。"
    npx wrangler d1 execute etf --remote --file "$IMPORT_FILE"
    ;;
  *)
    echo "用法：scripts/sync-d1.sh export | pull-local | push-remote --remote [sql-file]"
    exit 2
    ;;
esac
