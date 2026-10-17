#!/usr/bin/env bash
# Install or update the app on a Linux server (Ubuntu/Debian). Run from the extracted folder:
#   tar xzf stock-ai-linux-*.tar.gz && cd stock-ai && sudo bash deploy/install_linux.sh
#
# Options (environment variables):
#   APP=/opt/stock-ai          install folder        e.g. APP=/home/ubuntu/moohan/virtual
#   RUN_USER=stockai           Linux account that runs the app (created if missing)
#   PORT=8000                  web port (pick one that 무한매수 does not use)
#   HOST=127.0.0.1             127.0.0.1 = this server only, 0.0.0.0 = also from the local network
#   SERVICE=stock-ai           systemd service name
#   PYTHON=python3             Python 3.11+
# Installs the virtualenv, a systemd service (start on boot, restart on failure) and checks the app.
set -euo pipefail
APP="${APP:-/opt/stock-ai}"
RUN_USER="${RUN_USER:-stockai}"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
SERVICE="${SERVICE:-stock-ai}"
PY="${PYTHON:-python3}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "sudo로 실행하세요."; exit 1; fi
"$PY" -c 'import sys; assert sys.version_info >= (3, 11), sys.version' || {
  echo "Python 3.11 이상이 필요합니다. (Ubuntu 24.04: sudo apt install python3 python3-venv)"; exit 1; }
"$PY" -m venv --help >/dev/null 2>&1 || { echo "python3-venv 패키지가 필요합니다: sudo apt install python3-venv"; exit 1; }
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$" && ! systemctl is-active --quiet "$SERVICE"; then
  echo "포트 ${PORT}을 이미 다른 프로그램이 쓰고 있습니다. PORT=다른번호 로 다시 실행하세요."; exit 1
fi

id "$RUN_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
if systemctl is-active --quiet "$SERVICE"; then systemctl stop "$SERVICE"; fi
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  if [ -f "$APP/stock_ai_data/stock-ai.sqlite" ]; then
    # Never overwrite an existing server database on update.
    echo "기존 서버 데이터가 있어 stock_ai_data는 유지하고 코드만 갱신합니다."
    (cd "$SRC" && tar cf - --exclude=./stock_ai_data .) | (cd "$APP" && tar xf -)
  else
    (cd "$SRC" && tar cf - .) | (cd "$APP" && tar xf -)
  fi
fi
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$APP"

sudo -u "$RUN_USER" "$PY" -m venv "$APP/.venv-stock-ai"
sudo -u "$RUN_USER" "$APP/.venv-stock-ai/bin/pip" install --quiet --upgrade pip
sudo -u "$RUN_USER" "$APP/.venv-stock-ai/bin/pip" install --quiet -r "$APP/requirements-stock-ai.txt"

cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=Stock AI virtual investment (${APP})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP}
ExecStart=${APP}/.venv-stock-ai/bin/python ${APP}/stock_ai_analyzer.py --host ${HOST} --port ${PORT}
Restart=on-failure
RestartSec=10
Environment=TZ=Asia/Seoul
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$SERVICE"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "설치 완료: ${APP} · 서비스 ${SERVICE} · 포트 ${PORT} (접속 범위 ${HOST})"; exit 0; fi
  sleep 2
done
echo "응답이 없습니다. 로그 확인: sudo journalctl -u ${SERVICE} -n 100"; exit 1
