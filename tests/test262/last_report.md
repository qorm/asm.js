# asm.js test262 conformance report

_Generated 2026-08-07T06:19:46.077Z — target macos-arm64_

## Headline

**asm.js passes 1101 / 1701 = 64.73% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 3411 discovered test files in the selected dirs, 10 were excluded up front (module=0, unsupported-feature=10, intl/staging-dir=0); 3401 were eligible; 1701 were actually run (deterministic stride=2).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 1101 | 64.73 |
| FAIL         | 588 | 34.57 |
| COMPILE_FAIL | 2 | 0.12 |
| CRASH        | 10 | 0.59 |
| **run**      | **1701** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Object | 1701 | 1101 | 588 | 2 | 10 | 64.7 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 10
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `BigInt`: 8
- `cross-realm`: 1
- `SharedArrayBuffer`: 1

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **370×** FAIL: assertion mismatch (Test262Error / wrong value)
- **191×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **16×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **11×** FAIL: array contents mismatch (compareArray)
- **10×** CRASH: run signal SIGSEGV
- **2×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)

## Failures correlated with features (top tags among failing tests)

- `Proxy`: 25
- `Symbol`: 21
- `arrow-function`: 17
- `Reflect.construct`: 16
- `__setter__`: 14
- `__getter__`: 13
- `Object.fromEntries`: 9
- `Symbol.toStringTag`: 8
- `Symbol.iterator`: 7
- `Reflect`: 3
- `array-grouping`: 3
- `Object.hasOwn`: 2
- `Symbol.toPrimitive`: 2
- `Reflect.setPrototypeOf`: 2
- `generators`: 2
- `iterator-helpers`: 2
- `resizable-arraybuffer`: 1
- `Object.is`: 1
- `async-functions`: 1
- `Set`: 1

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
node tests/test262/run.mjs --stride 2 --jobs 4 --target macos-arm64
```

_Run wall-clock: 114.6s._
