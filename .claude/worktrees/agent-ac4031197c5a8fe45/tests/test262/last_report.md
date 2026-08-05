# asm.js test262 conformance report

_Generated 2026-07-26T08:09:24.657Z — target macos-arm64_

## Headline

**asm.js passes 243 / 594 = 40.91% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 3081 discovered test files in the selected dirs, 111 were excluded up front (module=0, unsupported-feature=111, intl/staging-dir=0); 2970 were eligible; 594 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 243 | 40.91 |
| FAIL         | 220 | 37.04 |
| COMPILE_FAIL | 0 | 0.00 |
| CRASH        | 131 | 22.05 |
| **run**      | **594** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Array | 594 | 243 | 220 | 0 | 131 | 40.9 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 111
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `Array.fromAsync`: 95
- `cross-realm`: 16

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **161×** FAIL: assertion mismatch (Test262Error / wrong value)
- **124×** CRASH: run signal SIGSEGV
- **32×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **21×** FAIL: array contents mismatch (compareArray)
- **6×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **4×** CRASH: run signal SIGBUS
- **3×** CRASH: run timeout

## Failures correlated with features (top tags among failing tests)

- `Symbol.species`: 16
- `resizable-arraybuffer`: 15
- `change-array-by-copy`: 11
- `Symbol.isConcatSpreadable`: 8
- `Symbol.iterator`: 6
- `Reflect.construct`: 6
- `array-find-from-last`: 6
- `Array.prototype.flatMap`: 6
- `Array.prototype.includes`: 6
- `Symbol`: 5
- `arrow-function`: 5
- `Proxy`: 4
- `Array.prototype.flat`: 3
- `exponentiation`: 3
- `Reflect`: 1
- `Symbol.unscopables`: 1
- `Array.prototype.at`: 1

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
node tests/test262/run.mjs --stride 5 --jobs 4 --target macos-arm64
```

_Run wall-clock: 42.5s._
