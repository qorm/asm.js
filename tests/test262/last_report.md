# asm.js test262 conformance report

_Generated 2026-08-05T16:45:19.162Z — target macos-arm64_

## Headline

**asm.js passes 205 / 407 = 50.37% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 1223 discovered test files in the selected dirs, 3 were excluded up front (module=0, unsupported-feature=3, intl/staging-dir=0); 1220 were eligible; 407 were actually run (deterministic stride=3).

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 205 | 50.37 |
| FAIL         | 187 | 45.95 |
| COMPILE_FAIL | 3 | 0.74 |
| CRASH        | 12 | 2.95 |
| **run**      | **407** | 100 |

## By area

| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |
|------|----:|-----:|-----:|-------------:|------:|------:|
| built-ins/String | 407 | 205 | 187 | 3 | 12 | 50.4 |

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 0
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 3
- **intl402/ + staging/ dirs**: 0

Excluded-by-feature detail:

- `cross-realm`: 3

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- **156×** FAIL: assertion mismatch (Test262Error / wrong value)
- **18×** FAIL: constructor-ness reflection (isConstructor / not-a-constructor)
- **9×** CRASH: run signal SIGSEGV
- **7×** FAIL: array contents mismatch (compareArray)
- **6×** FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)
- **3×** COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)
- **2×** CRASH: run signal SIGBUS
- **1×** CRASH: run timeout

## Failures correlated with features (top tags among failing tests)

- `Reflect.construct`: 18
- `arrow-function`: 17
- `Symbol.toPrimitive`: 12
- `Symbol`: 11
- `string-trimming`: 10
- `String.prototype.replaceAll`: 7
- `Symbol.matchAll`: 6
- `Symbol.match`: 5
- `String.prototype.matchAll`: 5
- `Symbol.replace`: 5
- `String.prototype.trimStart`: 5
- `String.prototype.endsWith`: 4
- `String.prototype.trimEnd`: 4
- `String.prototype.includes`: 3
- `String.prototype.toWellFormed`: 3
- `String.fromCodePoint`: 2
- `Symbol.iterator`: 2
- `computed-property-names`: 2
- `String.prototype.isWellFormed`: 2
- `regexp-v-flag`: 2

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
node tests/test262/run.mjs --stride 3 --jobs 4 --target macos-arm64
```

_Run wall-clock: 34.2s._
