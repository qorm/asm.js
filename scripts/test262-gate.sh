#!/usr/bin/env bash
# Official test262 stride-5 100% gate for every runnable release target.
#
# Each target that this host can actually execute must finish with
# FAIL=0 COMPILE_FAIL=0 CRASH=0. Unrunnable targets are SKIP (reason printed),
# not scored as 100%. Pass --require-all to treat SKIP as failure.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tests/test262/matrix.mjs --stride 5 --jobs "${JOBS:-8}" --gate "$@"
