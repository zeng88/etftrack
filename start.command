#!/bin/zsh

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PREVIEW_URL="http://127.0.0.1:8765/"
cd "$PROJECT_DIR" || exit 1

if ! /usr/bin/curl --silent --fail http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
  nohup python3 -u "$PROJECT_DIR/app.py" >> "$PROJECT_DIR/server.log" 2>&1 </dev/null &
  for attempt in {1..40}; do
    if /usr/bin/curl --silent --fail http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

if /usr/bin/curl --silent --fail http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
  open "$PREVIEW_URL"
else
  print "本地服务启动失败，请检查项目目录下的 server.log。"
  read -k 1 "?按任意键关闭窗口"
fi
