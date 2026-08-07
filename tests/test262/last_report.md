# asm.js test262 conformance report

_Generated 2026-08-07T16:12:14.625Z — target macos-arm64_

## Headline

**asm.js passes 1343 / 1975 = 68.00% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 11102 discovered test files in the selected dirs, 1227 were excluded up front (module=69, unsupported-feature=1158, intl/staging-dir=0); 9875 were eligible; 1975 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 1343 | 68.00 |
| FAIL         | 578 | 29.27 |
| COMPILE_FAIL | 23 | 1.16 |
| CRASH        | 31 | 1.57 |
| **run**      | **1975** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| language/expressions | 1975 | 1343 | 578 | 23 | 31 | 68.0 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 69
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 1158
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `source-phase-imports`: 237
- `BigInt`: 148
- `import-attributes`: 42
- `cross-realm`: 16
- `tail-call-optimization`: 16
- `decorators`: 10
- `SharedArrayBuffer`: 1

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **365×** FAIL: assertion mismatch (Test262Error / wrong value)
- **107×** FAIL: async ($DONE not signalled / promise rejected)
- **61×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **40×** FAIL: negative test wrong outcome (phase=parse)
- **23×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **20×** CRASH: run signal SIGSEGV
- **9×** CRASH: run timeout
- **5×** FAIL: array contents mismatch (compareArray)
- **2×** CRASH: run signal SIGBUS

## Failures correlated with features (top tags among failing tests)

- `async-iteration`: 186
- `generators`: 120
- `class`: 112
- `destructuring-binding`: 97
- `Symbol.iterator`: 91
- `class-fields-public`: 70
- `default-parameters`: 63
- `async-functions`: 39
- `Symbol.asyncIterator`: 31
- `class-fields-private`: 31
- `class-static-methods-private`: 28
- `computed-property-names`: 26
- `class-methods-private`: 26
- `object-rest`: 21
- `Symbol`: 12
- `class-static-fields-public`: 10
- `class-static-fields-private`: 10
- `logical-assignment-operators`: 8
- `arrow-function`: 6
- `new.target`: 5

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

_Run wall-clock: 121.0s._
