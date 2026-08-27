# asm.js test262 conformance report

_Generated 2026-08-26T22:00:24.277Z — target macos-arm64_

## Headline

**asm.js passes 6142 / 6313 = 97.29% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 2213 were excluded up front (module=83, unsupported-feature=2130, intl/staging-dir=0); 31563 were eligible; 6313 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 6142 | 97.29 |
| FAIL         | 171 | 2.71 |
| COMPILE_FAIL | 0 | 0.00 |
| CRASH        | 0 | 0.00 |
| **run**      | **6313** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 593 | 1 | 0 | 0 | 99.8 |
| built-ins/Boolean | 10 | 10 | 0 | 0 | 0 | 100.0 |
| built-ins/JSON | 31 | 28 | 3 | 0 | 0 | 90.3 |
| built-ins/Map | 41 | 41 | 0 | 0 | 0 | 100.0 |
| built-ins/Math | 65 | 65 | 0 | 0 | 0 | 100.0 |
| built-ins/Number | 67 | 63 | 4 | 0 | 0 | 94.0 |
| built-ins/Object | 681 | 671 | 10 | 0 | 0 | 98.5 |
| built-ins/Promise | 127 | 117 | 10 | 0 | 0 | 92.1 |
| built-ins/RegExp | 374 | 371 | 3 | 0 | 0 | 99.2 |
| built-ins/Set | 76 | 76 | 0 | 0 | 0 | 100.0 |
| built-ins/String | 243 | 234 | 9 | 0 | 0 | 96.3 |
| built-ins/Symbol | 16 | 16 | 0 | 0 | 0 | 100.0 |
| built-ins/TypedArray | 191 | 189 | 2 | 0 | 0 | 99.0 |
| language/expressions | 1975 | 1899 | 76 | 0 | 0 | 96.2 |
| language/statements | 1822 | 1769 | 53 | 0 | 0 | 97.1 |

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

- **125×** FAIL: assertion mismatch (Test262Error / wrong value)
- **31×** FAIL: async ($DONE not signalled / promise rejected)
- **7×** FAIL: array contents mismatch (compareArray)
- **4×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **3×** FAIL: negative test wrong outcome (phase=parse)
- **1×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)

## Failures correlated with features (top tags among failing tests)

- `class`: 46
- `Symbol.iterator`: 30
- `async-iteration`: 24
- `class-fields-public`: 24
- `Symbol.asyncIterator`: 17
- `generators`: 15
- `class-fields-private`: 14
- `class-methods-private`: 10
- `class-static-methods-private`: 9
- `Proxy`: 8
- `new.target`: 7
- `arrow-function`: 6
- `destructuring-binding`: 6
- `Symbol`: 4
- `async-functions`: 4
- `Promise.prototype.finally`: 3
- `TypedArray`: 3
- `resizable-arraybuffer`: 2
- `Promise.any`: 2
- `Symbol.species`: 2

## Methodology / reproducibility

- Corpus: official `tc39/test262` pinned at commit `9e61c12835c5e4a3bdba93850427e6742c4f64c4`
  (TEST262_PIN in tests/test262/run.mjs), vendored locally, NOT committed. Changing the
  pin requires re-downloading the corpus and re-running; counts depend on the snapshot.
- Each test is assembled per test262 `INTERPRETING.md`: host shims (`print`, `$262` stub) +
  `harness/assert.js` + `harness/sta.js` (+ `doneprintHandle.js` for async) + any `includes:` +
  the test body. `raw` tests run the body alone. `onlyStrict` tests get a leading `"use strict";`.
- **One variant per test**: strict where `onlyStrict`, else the sloppy variant (we do not run
  both strict+sloppy for flag-less tests — a deliberate, stated bound to keep the AOT run tractable).
- Each assembled test is AOT-compiled by a resident Node compile worker (`new Compiler` + `compileFile` per test; compiler modules loaded once per `--jobs` worker; 8 workers, target `macos-arm64`, 60s timeout) then executed (20s timeout).
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


## Timing

- wall-clock: 224.3s
- compile-sum (parallel overlap not subtracted): 1590.6s
- run-sum: 166.3s
- cache warm (hit): 0
- cache cold (miss): 6313 (avg 251.9ms)

_Run wall-clock: 224.3s._
