#!/usr/bin/env bash
# ECMA-262 test262 corpus — not the official stride-5 sample.
#
# Scope: test/language + test/built-ins + test/annexB, stride=1, one variant
# per test (same as the official sample's variant rule). Still skips
# intl402/ (ECMA-402) and staging/ (proposals). Does NOT write
# tests/test262/last_report.md.
#
# FAIL=COMPILE_FAIL=CRASH=0 is required before anyone may say "full ES".
# Extra args are forwarded (e.g. --dirs built-ins/Date --target macos-x64).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${TARGET:-macos-arm64}"
JOBS="${JOBS:-8}"
exec node tests/test262/run.mjs \
    --dirs language,built-ins,annexB \
    --stride 1 \
    --jobs "$JOBS" \
    --target "$TARGET" \
    --gate \
    --no-report \
    --keep-features \
    "$@"
