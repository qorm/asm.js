#!/usr/bin/env bash
# Serial bootstrap gate — the single choke point for product-code changes.
#
# Any change to code compiled into the product (compiler/, runtime/, lang/,
# vm/, backend/, asm/, binary/, cli.js) MUST pass this gate before commit:
#
#   1. full self-host chain, fresh outputs (stale-tail trap: always rm first)
#   2. byte-identical fixed point: gen1 == gen2 == gen3
#   3. fixtures via the authoritative runner scripts/run-fixtures.mjs:
#      discovered manifests == baseline, FAIL == 0, XPASS == 0,
#      and PASS + XFAIL == discovered
#
# Concurrency: mkdir-based lock serializes parallel agents/worktrees through
# one gate run at a time (macOS has no flock). A probe showing byte-identical
# output is NOT safety evidence (BOOTSTRAP_RULES §1.5) — only the full chain is.
set -euo pipefail
cd "$(dirname "$0")/.."

# Exact expected fixture manifest count under tests/fixtures (ratchet: bump
# only when new fixtures genuinely land; never lower it).
BASELINE_FIXTURES=385
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

# Authoritative runner (discovers every fixture.json incl. custom entries,
# honors knownFailure as XFAIL/XPASS, exits non-zero on FAIL or XPASS).
# Its output contract we parse:
#   Running <N> fixture(s) on <target>
#   Summary: PASS=<n> FAIL=<n> XFAIL=<n> XPASS=<n>
if ! FIX_OUT="$(node scripts/run-fixtures.mjs)"; then
    echo "$FIX_OUT" | tail -n 20 >&2
    echo "[gate] FAIL: fixture runner exited non-zero" >&2
    exit 1
fi
echo "$FIX_OUT" | tail -n 5
DISCOVERED_N="$(echo "$FIX_OUT" | sed -n 's/^Running \([0-9][0-9]*\) fixture(s) on .*/\1/p')"
COUNTS="$(echo "$FIX_OUT" | sed -n 's/^Summary: PASS=\([0-9][0-9]*\) FAIL=\([0-9][0-9]*\) XFAIL=\([0-9][0-9]*\) XPASS=\([0-9][0-9]*\).*/\1 \2 \3 \4/p')"
if [ -z "${DISCOVERED_N}" ] || [ -z "${COUNTS}" ]; then
    echo "[gate] FAIL: could not parse fixture runner output" >&2
    exit 1
fi
read -r PASS_N FAIL_N XFAIL_N XPASS_N <<< "$COUNTS"
if [ "${DISCOVERED_N}" != "${BASELINE_FIXTURES}" ]; then
    echo "[gate] FAIL: fixture manifest count changed: discovered=$DISCOVERED_N expected=$BASELINE_FIXTURES (bump BASELINE_FIXTURES only if new fixtures genuinely landed)" >&2
    exit 1
fi
if [ "${FAIL_N}" != "0" ] || [ "${XPASS_N}" != "0" ]; then
    echo "[gate] FAIL: fixtures FAIL=$FAIL_N XPASS=$XPASS_N (both must be 0; an XPASS means a knownFailure marker is now stale and should be removed)" >&2
    exit 1
fi
if [ $((PASS_N + XFAIL_N)) -ne "${DISCOVERED_N}" ]; then
    echo "[gate] FAIL: PASS+XFAIL=$((PASS_N + XFAIL_N)) != discovered $DISCOVERED_N" >&2
    exit 1
fi
echo "[gate] PASS: fixed point + fixtures PASS=$PASS_N XFAIL=$XFAIL_N FAIL=$FAIL_N XPASS=$XPASS_N (discovered $DISCOVERED_N == baseline $BASELINE_FIXTURES)"
