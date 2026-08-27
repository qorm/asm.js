# asm.js test262 — linux-x64 targeted samples

_Generated 2026-08-27 (America/New_York). Do **not** treat these as the macos-arm64
headline in `last_report.md` (6142/6313 = 97.29%). Full 6313-test suite was not run._

## Fixes on `t262-linux-x64-load32-vm` this session

- `538b8d5` `_closure_props_ensure`: boxed side table survived `_cpe_done` (x64 V0≡RET). `f.foo=1` / `assert.sameValue=fn` now stick.
- `a81902d` `[].length` / `arr.pop()`: type/tag extracted into V1, not V0.
- `ee6fe34` `lea V0,slot; store V0,0,RET` wrote the slot address into itself. Array ctor / `@@unscopables` / `[].toString` value-reads no longer SIGSEGV.

## Targeted runs (linux-x64, `--no-report`, jobs=4)

| slice | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% | prior |
|-------|----:|-----:|-----:|-------------:|------:|------:|-------|
| `language` --max 80 | 80 | 44 | 4 | 0 | 32 | **55.00%** | 35% after own-props only; ~21% at --max 150 before this session |
| `language/expressions` --max 80 | 80 | 42 | 5 | 0 | 33 | **52.50%** | addition/array were almost all CRASH |
| `built-ins/Array` --max 80 | 80 | 37 | 2 | 0 | 41 | **46.25%** | **3.75%** before this session |

COMPILE_FAIL remains 0.

## What improved

- Function own-properties: assignment path works (`f.foo=42`, `assert.sameValue=fn` is a function and is callable).
- `[].length`, `a.pop()`, `typeof Array`, `typeof Array.prototype`, `typeof [].toString`, `typeof ({}).toString` all succeed.
- Array --max 80 jumped 3.75% → 46.25%.

## Remaining linux-x64 top clusters (these samples)

- **arguments-object SIGSEGV** (most of language --max 80 CRASH).
- **addition ToPrimitive**: SIGSEGV and `TypeError: Cannot convert object to primitive value` (`{}+{}` still throws).
- **Array.from / @@species / iterator spread** SIGSEGV.
- `Object.defineProperty` on functions still not trustworthy (values can come back as denormals); harness assignment path is fine.

## macos-arm64 171 FAILs (track B)

Not started this session. Clusters from `last_report.md` still: class (46), Symbol.iterator (30), async-iteration (24), class-fields-public (24), Promise / async $DONE (31).
