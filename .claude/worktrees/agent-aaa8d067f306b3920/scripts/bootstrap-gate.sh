#!/usr/bin/env bash
# Serial bootstrap gate — the single choke point for product-code changes.
#
# Any change to code compiled into the product (compiler/, runtime/, lang/,
# vm/, backend/, asm/, binary/, cli.js) MUST pass this gate before commit:
#
#   1. full self-host chain, fresh outputs (stale-tail trap: always rm first)
#   2. byte-identical fixed point: gen1 == gen2 == gen3
#   3. fixtures: FAIL == 0 and PASS >= baseline
#
# Concurrency: mkdir-based lock serializes parallel agents/worktrees through
# one gate run at a time (macOS has no flock). A probe showing byte-identical
# output is NOT safety evidence (BOOTSTRAP_RULES §1.5) — only the full chain is.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FIXTURES=362
LOCK=".git/bootstrap-gate.lock"

while ! mkdir "$LOCK" 2>/dev/null; do
    echo "[gate] waiting for gate lock..." >&2
    sleep 5
done
trap 'rmdir "$LOCK"' EXIT

echo "[gate] start HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo nogit) target=host"

rm -f gen1 gen2 gen3

echo "[gate] 1/4 gen1 (node -> native)"
node cli.js cli.js -o gen1
echo "[gate] 2/4 gen2 (gen1 -> native)"
./gen1 cli.js -o gen2
echo "[gate] 3/4 gen3 (gen2 -> native)"
./gen2 cli.js -o gen3

echo "[gate] 4/4 byte compare"
if ! cmp -s gen1 gen2; then
    echo "[gate] FAIL: gen1 != gen2 (first difference below)" >&2
    cmp gen1 gen2 || true
    exit 1
fi
if ! cmp -s gen2 gen3; then
    echo "[gate] FAIL: gen2 != gen3 (first difference below)" >&2
    cmp gen2 gen3 || true
    exit 1
fi
echo "[gate] OK: gen1 == gen2 == gen3 (byte-identical fixed point)"

FIX_OUT="$(node tests/run_fixtures.mjs)"
echo "$FIX_OUT" | tail -n 5
PASS_N="$(echo "$FIX_OUT" | sed -n 's/.*PASS=\([0-9][0-9]*\).*/\1/p')"
FAIL_N="$(echo "$FIX_OUT" | sed -n 's/.*FAIL=\([0-9][0-9]*\).*/\1/p')"
if [ -z "${PASS_N}" ] || [ "${FAIL_N:-1}" != "0" ]; then
    echo "[gate] FAIL: fixtures failing (PASS=${PASS_N:-?} FAIL=${FAIL_N:-?})" >&2
    exit 1
fi
if [ "$PASS_N" -lt "$BASELINE_FIXTURES" ]; then
    echo "[gate] FAIL: fixtures regressed PASS=$PASS_N < baseline $BASELINE_FIXTURES" >&2
    exit 1
fi
echo "[gate] PASS: fixed point + fixtures $PASS_N/$((PASS_N + FAIL_N)) (baseline $BASELINE_FIXTURES)"
