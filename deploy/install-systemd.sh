#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec /usr/bin/python3 "$SCRIPT_DIR/systemd_installer.py" \
  --project-root "$SCRIPT_DIR/.." "$@"
