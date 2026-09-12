# asm.js test262 conformance report

_Generated 2026-09-08T17:43:29.691Z — target macos-arm64 (runner direct: host-native macos-arm64)_

## Headline

**asm.js passes 6276 / 6276 = 100.00% of the executed official stride-5 sample**
Expected-variant rate (PASS / 61284): 10.24%. notRun=55008. Official stride-5 sample, not every eligible variant.
Scope: selected language/ + core built-ins/ dirs. Bounded subset mode (not a full-corpus claim).

Of 33776 unique discovered test files (33776 raw paths), 2399 were excluded up front (module=83, unsupported-feature=2316, intl/staging-dir=0); 31377 files (61284 expected variants) were eligible; 12274 selected; 6276/61284 variants were actually run (notRun=55008) (deterministic stride=5).

## Overall breakdown

| class | count | % of executed |
|-------|------:|---------------:|
| PASS         | 6276 | 100.00 |
| FAIL         | 0 | 0.00 |
| COMPILE_FAIL | 0 | 0.00 |
| CRASH        | 0 | 0.00 |
| **executed**  | **6276** | 100 |
| expected variants | 61284 | — |
| notRun       | 55008 | — |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 594 | 0 | 0 | 0 | 100.0 |
| built-ins/Boolean | 10 | 10 | 0 | 0 | 0 | 100.0 |
| built-ins/JSON | 31 | 31 | 0 | 0 | 0 | 100.0 |
| built-ins/Map | 41 | 41 | 0 | 0 | 0 | 100.0 |
| built-ins/Math | 65 | 65 | 0 | 0 | 0 | 100.0 |
| built-ins/Number | 67 | 67 | 0 | 0 | 0 | 100.0 |
| built-ins/Object | 681 | 681 | 0 | 0 | 0 | 100.0 |
| built-ins/Promise | 127 | 127 | 0 | 0 | 0 | 100.0 |
| built-ins/RegExp | 338 | 338 | 0 | 0 | 0 | 100.0 |
| built-ins/Set | 76 | 76 | 0 | 0 | 0 | 100.0 |
| built-ins/String | 242 | 242 | 0 | 0 | 0 | 100.0 |
| built-ins/Symbol | 15 | 15 | 0 | 0 | 0 | 100.0 |
| built-ins/TypedArray | 192 | 192 | 0 | 0 | 0 | 100.0 |
| language/expressions | 1975 | 1975 | 0 | 0 | 0 | 100.0 |
| language/statements | 1822 | 1822 | 0 | 0 | 0 | 100.0 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 2316
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `BigInt`: 662
- `source-phase-imports`: 237
- `regexp-v-flag`: 187
- `explicit-resource-management`: 179
- `Array.fromAsync`: 95
- `await-dictionary`: 89
- `cross-realm`: 72
- `import-attributes`: 42
- `tail-call-optimization`: 34
- `decorators`: 24
- `SharedArrayBuffer`: 7

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)


## Failures correlated with features (top tags among failing tests)


## Methodology / reproducibility

- Corpus: official `tc39/test262` pinned at commit `9e61c12835c5e4a3bdba93850427e6742c4f64c4`
  (TEST262_PIN in tests/test262/run.mjs), vendored locally, NOT committed. Changing the
  pin requires re-downloading the corpus and re-running; counts depend on the snapshot.
- Each test is assembled per test262 `INTERPRETING.md`: host shims (`print`, `$262` stub) +
  `harness/assert.js` + `harness/sta.js` (+ `doneprintHandle.js` for async) + any `includes:` +
  the test body. `raw` tests run the body alone. `onlyStrict` tests get a leading `"use strict";`.
- Bounded mode runs one variant per test (strict only for `onlyStrict`, otherwise sloppy);
  omitted strict variants are reported in `variants`/`notRun` and are not a full claim.
- Each assembled test is AOT-compiled by a resident Node compile worker (`new Compiler` + `compileFile` per test; compiler modules loaded once per `--jobs` worker; 8 workers, target `macos-arm64`, 30s timeout) then executed (10s timeout) via `tests/test262/exec-target.mjs` (direct / Rosetta / Docker / Wine according to `--target`; filename-less `t123` binaries never infer the host platform).
- Classification: PASS = positive test exits 0 (async: `Test262:AsyncTestComplete` on stdout);
  FAIL = compiled+ran but assertion threw / wrong exit; COMPILE_FAIL = asm.js could not compile;
  CRASH = signal/timeout. NEGATIVE tests invert: parse/resolution ⇒ PASS iff compile fails;
  runtime ⇒ PASS iff the binary exits nonzero without crashing or spawn failure.
- **Known limitation**: negative tests are verified by *phase* (compile-fail vs runtime-throw),
  not by the exact error constructor — asm.js does not print the thrown error's type, so a test
  that throws the wrong error type at the right phase is scored PASS. This slightly favors asm.js
  on negative tests and is disclosed here for honesty.

### Reproduce

```sh
# 1. vendor the corpus (NOT committed)
curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/9e61c12835c5e4a3bdba93850427e6742c4f64c4.tar.gz
mkdir -p .test262-corpus && tar xzf /tmp/t262.tgz -C .test262-corpus --strip-components=1
# 2. run the harness
node tests/test262/run.mjs --stride 5 --jobs 8 --target macos-arm64
```


## Timing

- wall-clock: 954.9s
- compile-sum (parallel overlap not subtracted): 7407.3s
- run-sum: 172.4s
- cache warm (hit): 0
- cache cold (miss): 6276 (avg 1180.3ms)

_Run wall-clock: 954.9s._
