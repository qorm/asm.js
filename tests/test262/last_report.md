# asm.js test262 conformance report

_Generated 2026-08-07T14:07:27.506Z — target macos-arm64_

## Headline

**asm.js passes 290 / 600 = 48.33% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 604 discovered test files in the selected dirs, 4 were excluded up front (module=0, unsupported-feature=4, intl/staging-dir=0); 600 were eligible; 600 were actually run.

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 290 | 48.33 |
| FAIL         | 293 | 48.83 |
| COMPILE_FAIL | 1 | 0.17 |
| CRASH        | 16 | 2.67 |
| **run**      | **600** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| language/expressions | 69 | 41 | 28 | 0 | 0 | 59.4 |
| language/statements | 531 | 249 | 265 | 1 | 16 | 46.9 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 4
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `tail-call-optimization`: 4

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **245×** FAIL: assertion mismatch (Test262Error / wrong value)
- **40×** FAIL: negative test wrong outcome (phase=parse)
- **11×** CRASH: run timeout
- **5×** FAIL: array contents mismatch (compareArray)
- **5×** CRASH: run signal SIGSEGV
- **3×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **1×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)

## Failures correlated with features (top tags among failing tests)

- `destructuring-binding`: 48
- `Symbol.unscopables`: 8
- `Proxy`: 7
- `generators`: 6
- `Reflect`: 6
- `let`: 5
- `class`: 3
- `object-rest`: 3
- `Symbol.iterator`: 3
- `for-in-order`: 1
- `resizable-arraybuffer`: 1
- `class-static-block`: 1
- `TypedArray`: 1

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
node tests/test262/run.mjs --jobs 4 --target macos-arm64
```

_Run wall-clock: 115.8s._
