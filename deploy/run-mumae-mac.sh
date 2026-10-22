#!/bin/bash
# launchd용 래퍼: systemd의 EnvironmentFile 대체
cd /Users/m1/moohan
umask 077
set -a; . deploy/mumae.env; set +a
exec /Users/m1/moohan/.venv-mac/bin/python mumae_cli.py serve
