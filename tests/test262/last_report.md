# asm.js test262 conformance report

_Generated 2026-08-07T14:12:32.503Z — target macos-arm64_

## Headline

**asm.js passes 2540 / 3797 = 66.89% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 20439 discovered test files in the selected dirs, 1455 were excluded up front (module=83, unsupported-feature=1372, intl/staging-dir=0); 18984 were eligible; 3797 were actually run (deterministic stride=5).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 2540 | 66.89 |
| FAIL         | 1162 | 30.60 |
| COMPILE_FAIL | 31 | 0.82 |
| CRASH        | 64 | 1.69 |
| **run**      | **3797** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| language/expressions | 1975 | 1319 | 602 | 23 | 31 | 66.8 |
| language/statements | 1822 | 1221 | 560 | 8 | 33 | 67.0 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 1372
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `dynamic-import`: 688
- `source-phase-imports`: 237
- `explicit-resource-management`: 177
- `BigInt`: 152
- `import-attributes`: 42
- `tail-call-optimization`: 34
- `decorators`: 24
- `cross-realm`: 16
- `SharedArrayBuffer`: 2

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **683×** FAIL: assertion mismatch (Test262Error / wrong value)
- **240×** FAIL: async ($DONE not signalled / promise rejected)
- **141×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **86×** FAIL: negative test wrong outcome (phase=parse)
- **33×** CRASH: run signal SIGSEGV
- **31×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **25×** CRASH: run timeout
- **10×** FAIL: array contents mismatch (compareArray)
- **6×** CRASH: run signal SIGBUS
- **2×** FAIL: negative test wrong outcome (phase=runtime)

## Failures correlated with features (top tags among failing tests)

- `async-iteration`: 383
- `destructuring-binding`: 331
- `class`: 245
- `generators`: 226
- `Symbol.iterator`: 159
- `class-fields-public`: 150
- `default-parameters`: 101
- `class-methods-private`: 65
- `async-functions`: 64
- `class-fields-private`: 64
- `computed-property-names`: 58
- `class-static-methods-private`: 57
- `object-rest`: 49
- `Symbol.asyncIterator`: 45
- `class-static-fields-public`: 25
- `class-static-fields-private`: 20
- `Symbol`: 14
- `logical-assignment-operators`: 12
- `destructuring-assignment`: 10
- `new.target`: 10

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

_Run wall-clock: 279.0s._
