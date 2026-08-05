# asm.js test262 conformance report

_Generated 2026-08-05T10:20:46.757Z — target macos-arm64_

## Headline

**asm.js passes 3803 / 6445 = 59.01% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 1555 were excluded up front (module=83, unsupported-feature=1472, intl/staging-dir=0); 32221 were eligible; 6445 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 3803 | 59.01 |
| FAIL         | 2423 | 37.60 |
| COMPILE_FAIL | 66 | 1.02 |
| CRASH        | 153 | 2.37 |
| **run**      | **6445** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 332 | 224 | 0 | 38 | 55.9 |
| built-ins/Boolean | 10 | 1 | 9 | 0 | 0 | 10.0 |
| built-ins/JSON | 33 | 20 | 13 | 0 | 0 | 60.6 |
| built-ins/Map | 41 | 21 | 18 | 0 | 2 | 51.2 |
| built-ins/Math | 65 | 45 | 20 | 0 | 0 | 69.2 |
| built-ins/Number | 68 | 41 | 27 | 0 | 0 | 60.3 |
| built-ins/Object | 682 | 424 | 251 | 0 | 7 | 62.2 |
| built-ins/Promise | 127 | 61 | 55 | 8 | 3 | 48.0 |
| built-ins/RegExp | 374 | 173 | 197 | 3 | 1 | 46.3 |
| built-ins/Set | 76 | 37 | 21 | 3 | 15 | 48.7 |
| built-ins/String | 244 | 87 | 149 | 2 | 6 | 35.7 |
| built-ins/Symbol | 16 | 4 | 11 | 0 | 1 | 25.0 |
| built-ins/TypedArray | 287 | 78 | 208 | 0 | 1 | 27.2 |
| language/expressions | 2005 | 1317 | 630 | 24 | 34 | 65.7 |
| language/statements | 1823 | 1162 | 590 | 26 | 45 | 63.7 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 1472
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `source-phase-imports`: 237
- `explicit-resource-management`: 179
- `Array.fromAsync`: 95
- `await-dictionary`: 89
- `cross-realm`: 74
- `import-attributes`: 42
- `tail-call-optimization`: 34
- `decorators`: 24
- `SharedArrayBuffer`: 10

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **1537×** FAIL: assertion mismatch (Test262Error / wrong value)
- **300×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **175×** FAIL: async ($DONE not signalled / promise rejected)
- **145×** FAIL: TypedArray/ArrayBuffer semantics
- **117×** FAIL: negative test wrong outcome (phase=parse)
- **102×** CRASH: run signal SIGSEGV
- **92×** FAIL: array contents mismatch (compareArray)
- **66×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **57×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **37×** CRASH: run timeout
- **14×** CRASH: run signal SIGBUS

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 361
- `async-iteration`: 301
- `class`: 273
- `generators`: 251
- `TypedArray`: 196
- `Symbol.iterator`: 175
- `class-fields-public`: 143
- `default-parameters`: 123
- `BigInt`: 112
- `regexp-unicode-property-escapes`: 100
- `Symbol`: 94
- `class-methods-private`: 85
- `class-static-methods-private`: 77
- `arrow-function`: 69
- `class-fields-private`: 62
- `resizable-arraybuffer`: 58
- `Reflect.construct`: 57
- `computed-property-names`: 57
- `async-functions`: 54
- `object-rest`: 52

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

_Run wall-clock: 441.6s._
