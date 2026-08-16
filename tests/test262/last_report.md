# asm.js test262 conformance report

_Generated 2026-08-16T21:33:30.931Z — target macos-arm64_

## Headline

**asm.js passes 5667 / 6313 = 89.77% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 2213 were excluded up front (module=83, unsupported-feature=2130, intl/staging-dir=0); 31563 were eligible; 6313 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 5667 | 89.77 |
| FAIL         | 552 | 8.74 |
| COMPILE_FAIL | 8 | 0.13 |
| CRASH        | 86 | 1.36 |
| **run**      | **6313** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 530 | 52 | 0 | 12 | 89.2 |
| built-ins/Boolean | 10 | 10 | 0 | 0 | 0 | 100.0 |
| built-ins/JSON | 31 | 21 | 9 | 0 | 1 | 67.7 |
| built-ins/Map | 41 | 35 | 6 | 0 | 0 | 85.4 |
| built-ins/Math | 65 | 63 | 2 | 0 | 0 | 96.9 |
| built-ins/Number | 67 | 59 | 8 | 0 | 0 | 88.1 |
| built-ins/Object | 681 | 652 | 27 | 0 | 2 | 95.7 |
| built-ins/Promise | 127 | 106 | 19 | 0 | 2 | 83.5 |
| built-ins/RegExp | 374 | 338 | 34 | 0 | 2 | 90.4 |
| built-ins/Set | 76 | 70 | 6 | 0 | 0 | 92.1 |
| built-ins/String | 243 | 215 | 28 | 0 | 0 | 88.5 |
| built-ins/Symbol | 16 | 12 | 4 | 0 | 0 | 75.0 |
| built-ins/TypedArray | 191 | 97 | 73 | 0 | 21 | 50.8 |
| language/expressions | 1975 | 1788 | 169 | 4 | 14 | 90.5 |
| language/statements | 1822 | 1671 | 115 | 4 | 32 | 91.7 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 2130
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `BigInt`: 662
- `source-phase-imports`: 237
- `explicit-resource-management`: 179
- `Array.fromAsync`: 95
- `await-dictionary`: 89
- `cross-realm`: 73
- `import-attributes`: 42
- `tail-call-optimization`: 34
- `decorators`: 24
- `SharedArrayBuffer`: 7

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **359×** FAIL: assertion mismatch (Test262Error / wrong value)
- **58×** FAIL: async ($DONE not signalled / promise rejected)
- **50×** FAIL: TypedArray/ArrayBuffer semantics
- **42×** CRASH: run signal SIGBUS
- **39×** FAIL: array contents mismatch (compareArray)
- **22×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **21×** CRASH: run signal SIGSEGV
- **21×** CRASH: compiler crashed/timeout: SIGKILL
- **19×** FAIL: negative test wrong outcome (phase=parse)
- **8×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **3×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **2×** CRASH: run timeout
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `TypedArray`: 84
- `resizable-arraybuffer`: 58
- `Symbol.iterator`: 56
- `class`: 49
- `async-iteration`: 49
- `generators`: 35
- `Symbol.species`: 24
- `destructuring-binding`: 24
- `Symbol.asyncIterator`: 22
- `Proxy`: 21
- `Symbol`: 19
- `regexp-v-flag`: 19
- `class-fields-public`: 15
- `arrow-function`: 13
- `default-parameters`: 13
- `regexp-unicode-property-escapes`: 12
- `class-methods-private`: 12
- `class-fields-private`: 10
- `class-static-methods-private`: 9
- `change-array-by-copy`: 8

## Methodology / reproducibility

- Corpus: official `tc39/test262` pinned at commit `9e61c12835c5e4a3bdba93850427e6742c4f64c4`
  (TEST262_PIN in tests/test262/run.mjs), vendored locally, NOT committed. Changing the
  pin requires re-downloading the corpus and re-running; counts depend on the snapshot.
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
curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/9e61c12835c5e4a3bdba93850427e6742c4f64c4.tar.gz
mkdir -p .test262-corpus && tar xzf /tmp/t262.tgz -C .test262-corpus --strip-components=1
# 2. run the harness
node tests/test262/run.mjs --stride 5 --jobs 8 --target macos-arm64
```

_Run wall-clock: 859.3s._
