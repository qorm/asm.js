# asm.js test262 conformance report

_Generated 2026-08-05T12:01:00.688Z — target macos-arm64_

## Headline

**asm.js passes 33 / 77 = 42.86% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 98 discovered test files in the selected dirs, 21 were excluded up front (module=0, unsupported-feature=21, intl/staging-dir=0); 77 were eligible; 77 were actually run.

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 33 | 42.86 |
| FAIL         | 41 | 53.25 |
| COMPILE_FAIL | 1 | 1.30 |
| CRASH        | 2 | 2.60 |
| **run**      | **77** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/Symbol | 77 | 33 | 41 | 1 | 2 | 42.9 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 21
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `cross-realm`: 19
- `explicit-resource-management`: 2

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **22×** FAIL: assertion mismatch (Test262Error / wrong value)
- **15×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **4×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **1×** CRASH: run signal SIGSEGV
- **1×** CRASH: run signal SIGBUS
- **1×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)

## Failures correlated with features (top tags among failing tests)

- `Symbol`: 29
- `Symbol.toPrimitive`: 8
- `Symbol.prototype.description`: 5
- `Reflect.construct`: 4
- `arrow-function`: 4
- `Symbol.species`: 2
- `Symbol.toStringTag`: 1

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

_Run wall-clock: 5.6s._
