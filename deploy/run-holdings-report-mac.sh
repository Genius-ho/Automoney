#!/bin/bash
# launchd용 래퍼: 보유 종목 현황(국내+미국)을 텔레그램으로 보낸다.
cd /Users/m1/moohan
umask 077
set -a; . deploy/mumae.env; set +a
exec /Users/m1/moohan/.venv-mac/bin/python holdings_report.py "$@"
