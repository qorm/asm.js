# asm.js test262 conformance report

_Generated 2026-08-08T15:57:38.271Z — target macos-arm64_

## Headline

**asm.js passes 4146 / 6313 = 65.67% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 2213 were excluded up front (module=83, unsupported-feature=2130, intl/staging-dir=0); 31563 were eligible; 6313 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 4146 | 65.67 |
| FAIL         | 2059 | 32.62 |
| COMPILE_FAIL | 43 | 0.68 |
| CRASH        | 65 | 1.03 |
| **run**      | **6313** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 360 | 234 | 0 | 0 | 60.6 |
| built-ins/Boolean | 10 | 9 | 1 | 0 | 0 | 90.0 |
| built-ins/JSON | 31 | 20 | 10 | 0 | 1 | 64.5 |
| built-ins/Map | 41 | 31 | 10 | 0 | 0 | 75.6 |
| built-ins/Math | 65 | 51 | 14 | 0 | 0 | 78.5 |
| built-ins/Number | 67 | 55 | 12 | 0 | 0 | 82.1 |
| built-ins/Object | 681 | 453 | 227 | 1 | 0 | 66.5 |
| built-ins/Promise | 127 | 69 | 58 | 0 | 0 | 54.3 |
| built-ins/RegExp | 374 | 201 | 172 | 0 | 1 | 53.7 |
| built-ins/Set | 76 | 41 | 33 | 0 | 2 | 53.9 |
| built-ins/String | 243 | 148 | 95 | 0 | 0 | 60.9 |
| built-ins/Symbol | 16 | 11 | 4 | 0 | 1 | 68.8 |
| built-ins/TypedArray | 191 | 63 | 109 | 0 | 19 | 33.0 |
| language/expressions | 1975 | 1368 | 559 | 29 | 19 | 69.3 |
| language/statements | 1822 | 1266 | 521 | 13 | 22 | 69.5 |

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

- **1337×** FAIL: assertion mismatch (Test262Error / wrong value)
- **265×** FAIL: async ($DONE not signalled / promise rejected)
- **211×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **84×** FAIL: array contents mismatch (compareArray)
- **81×** FAIL: negative test wrong outcome (phase=parse)
- **65×** FAIL: TypedArray/ArrayBuffer semantics
- **43×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **38×** CRASH: run timeout
- **23×** CRASH: run signal SIGSEGV
- **14×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **4×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `async-iteration`: 366
- `destructuring-binding`: 318
- `generators`: 220
- `class`: 196
- `Symbol.iterator`: 181
- `TypedArray`: 118
- `class-fields-public`: 101
- `regexp-unicode-property-escapes`: 100
- `default-parameters`: 92
- `computed-property-names`: 67
- `Symbol`: 65
- `resizable-arraybuffer`: 58
- `class-static-methods-private`: 47
- `class-fields-private`: 44
- `class-methods-private`: 43
- `object-rest`: 42
- `Symbol.asyncIterator`: 41
- `async-functions`: 35
- `Symbol.species`: 33
- `arrow-function`: 33

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

_Run wall-clock: 448.1s._
