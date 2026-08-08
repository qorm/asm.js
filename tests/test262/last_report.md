# asm.js test262 conformance report

_Generated 2026-08-08T11:28:04.130Z — target macos-arm64_

## Headline

**asm.js passes 1246 / 2083 = 59.82% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 11040 discovered test files in the selected dirs, 629 were excluded up front (module=0, unsupported-feature=629, intl/staging-dir=0); 10411 were eligible; 2083 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 1246 | 59.82 |
| FAIL         | 826 | 39.65 |
| COMPILE_FAIL | 4 | 0.19 |
| CRASH        | 7 | 0.34 |
| **run**      | **2083** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 353 | 241 | 0 | 0 | 59.4 |
| built-ins/Object | 680 | 460 | 216 | 2 | 2 | 67.6 |
| built-ins/RegExp | 374 | 206 | 165 | 2 | 1 | 55.1 |
| built-ins/String | 243 | 155 | 86 | 0 | 2 | 63.8 |
| built-ins/TypedArray | 192 | 72 | 118 | 0 | 2 | 37.5 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 629
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `BigInt`: 497
- `Array.fromAsync`: 95
- `cross-realm`: 32
- `SharedArrayBuffer`: 5

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **581×** FAIL: assertion mismatch (Test262Error / wrong value)
- **96×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **75×** FAIL: TypedArray/ArrayBuffer semantics
- **66×** FAIL: array contents mismatch (compareArray)
- **8×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **6×** CRASH: run signal SIGSEGV
- **4×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **1×** CRASH: run signal SIGBUS

## Failures correlated with features (top tags among failing tests)

- `TypedArray`: 102
- `regexp-unicode-property-escapes`: 98
- `resizable-arraybuffer`: 41
- `Symbol`: 33
- `Symbol.species`: 25
- `Proxy`: 15
- `change-array-by-copy`: 15
- `regexp-v-flag`: 15
- `Symbol.replace`: 12
- `Symbol.iterator`: 11
- `arrow-function`: 10
- `array-find-from-last`: 9
- `Symbol.match`: 9
- `Symbol.split`: 9
- `Reflect.construct`: 8
- `Symbol.toPrimitive`: 8
- `Symbol.isConcatSpreadable`: 7
- `string-trimming`: 7
- `__setter__`: 6
- `Symbol.matchAll`: 6

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

_Run wall-clock: 132.8s._
