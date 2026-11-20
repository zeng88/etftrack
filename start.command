#!/bin/zsh

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PREVIEW_URL="http://127.0.0.1:8765/"
cd "$PROJECT_DIR" || exit 1

healthy() {
  /usr/bin/curl --silent --fail --max-time 2 http://127.0.0.1:8765/api/health >/dev/null 2>&1
}

if ! healthy; then
  # Only recover a stuck server when both its command and working directory
  # identify this checkout. Never stop an unrelated program using the port.
  pids=(${(f)"$(/usr/sbin/lsof -nP -tiTCP:8765 -sTCP:LISTEN 2>/dev/null)"})
  if (( ${#pids} > 0 )); then
    if (( ${#pids} != 1 )); then
      print "端口 8765 被多个进程占用，请检查后重试。"
      read -k 1 "?按任意键关闭窗口"
      exit 1
    fi
    pid=$pids[1]
    process_command="$(/bin/ps -p "$pid" -o command= 2>/dev/null)"
    process_dir="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')"
    if [[ "$process_command" != *[Pp]ython* || ( "$process_command" != *" app.py" && "$process_command" != *" $PROJECT_DIR/app.py" ) || "$process_dir" != "$PROJECT_DIR" ]]; then
      print "端口 8765 已被其他程序占用（进程 $pid），请释放端口后重试。"
      read -k 1 "?按任意键关闭窗口"
      exit 1
    fi
    if ! healthy; then
      print "检测到本项目旧服务无响应，正在重启…"
      kill -TERM "$pid" 2>/dev/null || { print "无法停止旧服务（进程 $pid）。"; exit 1; }
      for attempt in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "$pid" 2>/dev/null; then
        print "旧服务未能停止（进程 $pid），请检查后重试。"
        read -k 1 "?按任意键关闭窗口"
        exit 1
      fi
    fi
  fi
fi

if ! healthy; then
  nohup python3 -u "$PROJECT_DIR/app.py" >> "$PROJECT_DIR/server.log" 2>&1 </dev/null &
  for attempt in {1..40}; do
    if healthy; then
      break
    fi
    sleep 0.5
  done
fi

if healthy; then
  open "$PREVIEW_URL"
else
  print "本地服务启动失败，请检查项目目录下的 server.log。"
  read -k 1 "?按任意键关闭窗口"
fi
