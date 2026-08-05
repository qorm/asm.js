# asm.js test262 conformance report

_Generated 2026-07-26T07:58:20.292Z — target macos-arm64_

## Headline

**asm.js passes 143 / 682 = 20.97% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 3411 discovered test files in the selected dirs, 2 were excluded up front (module=0, unsupported-feature=2, intl/staging-dir=0); 3409 were eligible; 682 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 143 | 20.97 |
| FAIL         | 481 | 70.53 |
| COMPILE_FAIL | 0 | 0.00 |
| CRASH        | 58 | 8.50 |
| **run**      | **682** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Object | 682 | 143 | 481 | 0 | 58 | 21.0 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 2
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `cross-realm`: 1
- `SharedArrayBuffer`: 1

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **321×** FAIL: assertion mismatch (Test262Error / wrong value)
- **151×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **58×** CRASH: run signal SIGSEGV
- **6×** FAIL: array contents mismatch (compareArray)
- **3×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)

## Failures correlated with features (top tags among failing tests)

- `Symbol`: 10
- `__getter__`: 6
- `__setter__`: 5
- `Object.fromEntries`: 4
- `Symbol.toStringTag`: 4
- `Reflect.construct`: 3
- `arrow-function`: 3
- `Proxy`: 3
- `array-grouping`: 3
- `BigInt`: 2
- `Symbol.iterator`: 2
- `Object.hasOwn`: 2
- `resizable-arraybuffer`: 1
- `Reflect.setPrototypeOf`: 1
- `WeakMap`: 1
- `for-in-order`: 1

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

_Run wall-clock: 25.3s._
