# asm.js test262 conformance report

_Generated 2026-07-27T19:20:31.490Z — target macos-arm64_

## Headline

**asm.js passes 2691 / 6462 = 41.64% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 1466 were excluded up front (module=83, unsupported-feature=1383, intl/staging-dir=0); 32310 were eligible; 6462 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 2691 | 41.64 |
| FAIL         | 3552 | 54.97 |
| COMPILE_FAIL | 40 | 0.62 |
| CRASH        | 179 | 2.77 |
| **run**      | **6462** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 284 | 289 | 0 | 21 | 47.8 |
| built-ins/Boolean | 10 | 3 | 6 | 0 | 1 | 30.0 |
| built-ins/JSON | 33 | 8 | 25 | 0 | 0 | 24.2 |
| built-ins/Map | 41 | 15 | 24 | 0 | 2 | 36.6 |
| built-ins/Math | 65 | 32 | 33 | 0 | 0 | 49.2 |
| built-ins/Number | 68 | 26 | 41 | 0 | 1 | 38.2 |
| built-ins/Object | 682 | 311 | 362 | 0 | 9 | 45.6 |
| built-ins/Promise | 145 | 51 | 84 | 2 | 8 | 35.2 |
| built-ins/RegExp | 374 | 133 | 235 | 5 | 1 | 35.6 |
| built-ins/Set | 76 | 40 | 26 | 0 | 10 | 52.6 |
| built-ins/String | 244 | 75 | 167 | 0 | 2 | 30.7 |
| built-ins/Symbol | 15 | 4 | 11 | 0 | 0 | 26.7 |
| built-ins/TypedArray | 288 | 53 | 232 | 0 | 3 | 18.4 |
| language/expressions | 2005 | 915 | 1001 | 23 | 66 | 45.6 |
| language/statements | 1822 | 741 | 1016 | 10 | 55 | 40.7 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 1383
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `source-phase-imports`: 237
- `explicit-resource-management`: 179
- `Array.fromAsync`: 95
- `cross-realm`: 74
- `import-attributes`: 42
- `tail-call-optimization`: 34
- `decorators`: 24
- `SharedArrayBuffer`: 10

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **1977×** FAIL: assertion mismatch (Test262Error / wrong value)
- **467×** FAIL: async ($DONE not signalled / promise rejected)
- **463×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **335×** FAIL: negative test wrong outcome (phase=parse)
- **147×** FAIL: TypedArray/ArrayBuffer semantics
- **129×** CRASH: run signal SIGSEGV
- **111×** FAIL: array contents mismatch (compareArray)
- **50×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **40×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **35×** CRASH: run timeout
- **15×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 730
- `async-iteration`: 601
- `class`: 503
- `generators`: 432
- `Symbol.iterator`: 299
- `class-fields-public`: 243
- `default-parameters`: 238
- `TypedArray`: 219
- `class-methods-private`: 179
- `class-fields-private`: 141
- `class-static-methods-private`: 137
- `regexp-unicode-property-escapes`: 132
- `BigInt`: 120
- `Symbol.asyncIterator`: 112
- `Symbol`: 90
- `async-functions`: 70
- `arrow-function`: 67
- `resizable-arraybuffer`: 57
- `computed-property-names`: 55
- `object-rest`: 55

## Methodology / reproducibility

- Corpus: official `tc39/test262` (main), vendored locally, NOT committed.
- Each test is assembled per test262 `INTERPRETING.md`: host shims (`print`, `$262` stub) +
  `harness/assert.js` + `harness/sta.js` (+ `doneprintHandle.js` for async) + any `includes:` +
  the test body. `raw` tests run the body alone. `onlyStrict` tests get a leading `"use strict";`.
- **One variant per test**: strict where `onlyStrict`, else the sloppy variant (we do not run
  both strict+sloppy for flag-less tests — a deliberate, stated bound to keep the AOT run tractable).
- Each assembled test is AOT-compiled (`node cli.js t.js -o t --target macos-arm64`, 30s timeout) then executed (10s timeout).
- Classification: PASS = positive test exits 0 (async: `Test262:AsyncTestComplete` on stdout);
  FAIL = compiled+ran but assertion threw / wrong exit; COMPILE_FAIL = asm.js could not compile;
  CRASH = signal/timeout. NEGATIVE tests invert: parse/resolution ⇒ PASS iff compile fails;
  runtime ⇒ PASS iff the binary exits nonzero without crashing.
- **Known limitation**: negative tests are verified by *phase* (compile-fail vs runtime-throw),
  not by the exact error constructor — asm.js does not print the thrown error's type, so a test
  that throws the wrong error type at the right phase is scored PASS. This slightly favors asm.js
  on negative tests and is disclosed here for honesty.

### Reproduce

```sh
# 1. vendor the corpus (NOT committed)
curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/refs/heads/main.tar.gz
mkdir -p .test262-corpus && tar xzf /tmp/t262.tgz -C .test262-corpus --strip-components=1
# 2. run the harness
node tests/test262/run.mjs --stride 5 --jobs 8 --target macos-arm64
```

_Run wall-clock: 391.6s._
