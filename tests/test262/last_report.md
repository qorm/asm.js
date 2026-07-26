# asm.js test262 conformance report

_Generated 2026-07-26T10:35:21.939Z — target macos-arm64_

## Headline

**asm.js passes 1842 / 6462 = 28.51% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 1466 were excluded up front (module=83, unsupported-feature=1383, intl/staging-dir=0); 32310 were eligible; 6462 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 1842 | 28.51 |
| FAIL         | 4277 | 66.19 |
| COMPILE_FAIL | 108 | 1.67 |
| CRASH        | 235 | 3.64 |
| **run**      | **6462** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 266 | 304 | 0 | 24 | 44.8 |
| built-ins/Boolean | 10 | 1 | 8 | 0 | 1 | 10.0 |
| built-ins/JSON | 33 | 8 | 25 | 0 | 0 | 24.2 |
| built-ins/Map | 41 | 7 | 32 | 0 | 2 | 17.1 |
| built-ins/Math | 65 | 21 | 44 | 0 | 0 | 32.3 |
| built-ins/Number | 68 | 26 | 41 | 0 | 1 | 38.2 |
| built-ins/Object | 682 | 148 | 523 | 0 | 11 | 21.7 |
| built-ins/Promise | 145 | 25 | 109 | 2 | 9 | 17.2 |
| built-ins/RegExp | 374 | 93 | 277 | 4 | 0 | 24.9 |
| built-ins/Set | 76 | 20 | 46 | 0 | 10 | 26.3 |
| built-ins/String | 244 | 55 | 188 | 0 | 1 | 22.5 |
| built-ins/Symbol | 15 | 3 | 12 | 0 | 0 | 20.0 |
| built-ins/TypedArray | 288 | 10 | 237 | 0 | 41 | 3.5 |
| language/expressions | 2005 | 666 | 1214 | 51 | 74 | 33.2 |
| language/statements | 1822 | 493 | 1217 | 51 | 61 | 27.1 |

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

- **2327×** FAIL: assertion mismatch (Test262Error / wrong value)
- **682×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **608×** FAIL: async ($DONE not signalled / promise rejected)
- **337×** FAIL: negative test wrong outcome (phase=parse)
- **173×** CRASH: run signal SIGSEGV
- **158×** FAIL: TypedArray/ArrayBuffer semantics
- **113×** FAIL: array contents mismatch (compareArray)
- **108×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **50×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **45×** CRASH: run timeout
- **17×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 908
- `class`: 752
- `async-iteration`: 740
- `generators`: 611
- `class-fields-public`: 367
- `Symbol.iterator`: 316
- `default-parameters`: 313
- `TypedArray`: 261
- `class-methods-private`: 260
- `class-static-methods-private`: 234
- `class-fields-private`: 190
- `regexp-unicode-property-escapes`: 133
- `BigInt`: 119
- `Symbol.asyncIterator`: 112
- `Symbol`: 97
- `async-functions`: 90
- `object-rest`: 76
- `arrow-function`: 73
- `computed-property-names`: 58
- `resizable-arraybuffer`: 57

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

_Run wall-clock: 365.0s._
