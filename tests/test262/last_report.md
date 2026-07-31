# asm.js test262 conformance report

_Generated 2026-07-31T20:27:10.852Z — target macos-arm64_

## Headline

**asm.js passes 3043 / 6462 = 47.09% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 1466 were excluded up front (module=83, unsupported-feature=1383, intl/staging-dir=0); 32310 were eligible; 6462 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 3043 | 47.09 |
| FAIL         | 3181 | 49.23 |
| COMPILE_FAIL | 69 | 1.07 |
| CRASH        | 169 | 2.62 |
| **run**      | **6462** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 297 | 273 | 0 | 24 | 50.0 |
| built-ins/Boolean | 10 | 1 | 9 | 0 | 0 | 10.0 |
| built-ins/JSON | 33 | 9 | 24 | 0 | 0 | 27.3 |
| built-ins/Map | 41 | 15 | 24 | 0 | 2 | 36.6 |
| built-ins/Math | 65 | 45 | 20 | 0 | 0 | 69.2 |
| built-ins/Number | 68 | 25 | 42 | 0 | 1 | 36.8 |
| built-ins/Object | 682 | 393 | 278 | 0 | 11 | 57.6 |
| built-ins/Promise | 145 | 50 | 76 | 6 | 13 | 34.5 |
| built-ins/RegExp | 374 | 133 | 235 | 5 | 1 | 35.6 |
| built-ins/Set | 76 | 40 | 26 | 2 | 8 | 52.6 |
| built-ins/String | 244 | 94 | 148 | 1 | 1 | 38.5 |
| built-ins/Symbol | 15 | 4 | 11 | 0 | 0 | 26.7 |
| built-ins/TypedArray | 288 | 67 | 218 | 0 | 3 | 23.3 |
| language/expressions | 2005 | 1027 | 886 | 30 | 62 | 51.2 |
| language/statements | 1822 | 843 | 911 | 25 | 43 | 46.3 |

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

- **1817×** FAIL: assertion mismatch (Test262Error / wrong value)
- **418×** FAIL: async ($DONE not signalled / promise rejected)
- **377×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **263×** FAIL: negative test wrong outcome (phase=parse)
- **147×** FAIL: TypedArray/ArrayBuffer semantics
- **119×** CRASH: run signal SIGSEGV
- **107×** FAIL: array contents mismatch (compareArray)
- **69×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **50×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **35×** CRASH: run timeout
- **15×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 636
- `async-iteration`: 549
- `class`: 436
- `generators`: 361
- `Symbol.iterator`: 298
- `class-fields-public`: 240
- `TypedArray`: 206
- `default-parameters`: 199
- `class-methods-private`: 152
- `class-fields-private`: 136
- `regexp-unicode-property-escapes`: 132
- `BigInt`: 120
- `Symbol.asyncIterator`: 112
- `class-static-methods-private`: 111
- `Symbol`: 90
- `arrow-function`: 67
- `async-functions`: 62
- `resizable-arraybuffer`: 57
- `computed-property-names`: 55
- `object-rest`: 55

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

_Run wall-clock: 398.2s._
