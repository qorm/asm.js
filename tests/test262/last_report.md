# asm.js test262 conformance report

_Generated 2026-07-26T13:11:46.343Z — target macos-arm64_

## Headline

**asm.js passes 2065 / 6462 = 31.96% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 1466 were excluded up front (module=83, unsupported-feature=1383, intl/staging-dir=0); 32310 were eligible; 6462 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 2065 | 31.96 |
| FAIL         | 4049 | 62.66 |
| COMPILE_FAIL | 108 | 1.67 |
| CRASH        | 240 | 3.71 |
| **run**      | **6462** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 280 | 290 | 0 | 24 | 47.1 |
| built-ins/Boolean | 10 | 3 | 6 | 0 | 1 | 30.0 |
| built-ins/JSON | 33 | 8 | 25 | 0 | 0 | 24.2 |
| built-ins/Map | 41 | 16 | 23 | 0 | 2 | 39.0 |
| built-ins/Math | 65 | 21 | 44 | 0 | 0 | 32.3 |
| built-ins/Number | 68 | 26 | 41 | 0 | 1 | 38.2 |
| built-ins/Object | 682 | 201 | 469 | 0 | 12 | 29.5 |
| built-ins/Promise | 145 | 31 | 102 | 2 | 10 | 21.4 |
| built-ins/RegExp | 374 | 99 | 271 | 4 | 0 | 26.5 |
| built-ins/Set | 76 | 40 | 25 | 0 | 11 | 52.6 |
| built-ins/String | 244 | 60 | 183 | 0 | 1 | 24.6 |
| built-ins/Symbol | 15 | 4 | 11 | 0 | 0 | 26.7 |
| built-ins/TypedArray | 288 | 13 | 234 | 0 | 41 | 4.5 |
| language/expressions | 2005 | 718 | 1161 | 51 | 75 | 35.8 |
| language/statements | 1822 | 545 | 1164 | 51 | 62 | 29.9 |

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

- **2192×** FAIL: assertion mismatch (Test262Error / wrong value)
- **608×** FAIL: async ($DONE not signalled / promise rejected)
- **592×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **337×** FAIL: negative test wrong outcome (phase=parse)
- **178×** CRASH: run signal SIGSEGV
- **154×** FAIL: TypedArray/ArrayBuffer semantics
- **114×** FAIL: array contents mismatch (compareArray)
- **108×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **50×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **44×** CRASH: run timeout
- **18×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 840
- `class`: 733
- `async-iteration`: 726
- `generators`: 596
- `class-fields-public`: 354
- `Symbol.iterator`: 314
- `default-parameters`: 290
- `TypedArray`: 258
- `class-methods-private`: 254
- `class-static-methods-private`: 226
- `class-fields-private`: 184
- `regexp-unicode-property-escapes`: 133
- `BigInt`: 119
- `Symbol.asyncIterator`: 112
- `Symbol`: 90
- `async-functions`: 90
- `arrow-function`: 73
- `object-rest`: 61
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

_Run wall-clock: 365.1s._
