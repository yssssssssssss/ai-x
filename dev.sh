#!/usr/bin/env bash
set -euo pipefail

PID_DIR=".pids"
LOG_DIR=".logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

SERVICES=(
  "api:npm run api:dev"
  "web:npm run --prefix apps/web dev"
)

start_one() {
  local name=$1 cmd=$2
  if [[ -f "$PID_DIR/$name.pid" ]] && kill -0 "$(cat "$PID_DIR/$name.pid")" 2>/dev/null; then
    echo "[$name] 已在运行 (PID $(cat "$PID_DIR/$name.pid"))"
    return
  fi
  $cmd > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  echo "[$name] 启动 (PID $!) → 日志: $LOG_DIR/$name.log"
}

stop_one() {
  local name=$1
  if [[ -f "$PID_DIR/$name.pid" ]]; then
    local pid
    pid=$(cat "$PID_DIR/$name.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
      echo "[$name] 已停止 (PID $pid)"
    else
      echo "[$name] 进程已不存在"
    fi
    rm -f "$PID_DIR/$name.pid"
  else
    echo "[$name] 未运行"
  fi
}

cmd_start() {
  for entry in "${SERVICES[@]}"; do
    local name="${entry%%:*}" cmd="${entry#*:}"
    start_one "$name" "$cmd"
  done
  echo "---"
  echo "全部启动完成。查看日志: tail -f $LOG_DIR/*.log"
}

cmd_stop() {
  for entry in "${SERVICES[@]}"; do
    local name="${entry%%:*}"
    stop_one "$name"
  done
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  for entry in "${SERVICES[@]}"; do
    local name="${entry%%:*}"
    if [[ -f "$PID_DIR/$name.pid" ]] && kill -0 "$(cat "$PID_DIR/$name.pid")" 2>/dev/null; then
      echo "[$name] 运行中 (PID $(cat "$PID_DIR/$name.pid"))"
    else
      echo "[$name] 未运行"
      rm -f "$PID_DIR/$name.pid"
    fi
  done
}

cmd_logs() {
  tail -f "$LOG_DIR"/*.log
}

case "${1:-help}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)
    echo "用法: ./dev.sh {start|stop|restart|status|logs}"
    echo ""
    echo "  start    启动所有服务"
    echo "  stop     停止所有服务"
    echo "  restart  重启所有服务"
    echo "  status   查看运行状态"
    echo "  logs     跟踪所有日志"
    ;;
esac
