#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
export MUMAE_DATA_DIR="${MUMAE_DATA_DIR:-$PROJECT_DIR}"
exec python3 "$PROJECT_DIR/mumae_cli.py" --data-dir "$MUMAE_DATA_DIR" serve --host "${MUMAE_WEB_HOST:-127.0.0.1}" --port "${MUMAE_WEB_PORT:-8765}"
