#!/usr/bin/env bash
# P0 hygiene: list root-level one-off probes / binaries that should not live
# in the product tree. Safe to run; prints a report and optionally deletes
# with --delete (untracked only).
set -euo pipefail
cd "$(dirname "$0")/.."

DELETE=0
if [[ "${1:-}" == "--delete" ]]; then
  DELETE=1
fi

patterns=(
  'tmp_*'
  'tmp.out'
  'patch*.js'
  'fix.js'
  'fix2.js'
  'fix3.js'
  'fix4.js'
  'fix5.js'
  '*.cpuprofile'
  'cli.js.bak'
  'gen1'
  'gen2'
  'gen2_from_node'
  'gen3'
  'test_*'
)

total=0
to_delete=()

for p in "${patterns[@]}"; do
  # only match in repo root
  while IFS= read -r -d '' f; do
    base=$(basename "$f")
    # never touch tracked product files
    if git ls-files --error-unmatch "$base" >/dev/null 2>&1; then
      echo "TRACKED (skip): $base"
      continue
    fi
    total=$((total + 1))
    sz=$(wc -c <"$f" | tr -d ' ')
    echo "UNTRACKED: $base ($sz bytes)"
    to_delete+=("$f")
  done < <(find . -maxdepth 1 -name "$p" -print0 2>/dev/null)
done

echo "---"
echo "untracked candidates: $total"
if [[ $DELETE -eq 1 && $total -gt 0 ]]; then
  for f in "${to_delete[@]}"; do
    rm -f "$f"
  done
  echo "deleted $total untracked root files"
elif [[ $DELETE -eq 1 ]]; then
  echo "nothing to delete"
else
  echo "dry-run; re-run with --delete to remove untracked candidates"
fi
