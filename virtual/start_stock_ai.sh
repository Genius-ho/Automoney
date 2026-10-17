#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
exec .venv-stock-ai/bin/python stock_ai_analyzer.py "$@"
