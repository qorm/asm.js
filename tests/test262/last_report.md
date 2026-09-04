# asm.js test262 conformance report

_Generated 2026-09-04T14:36:33.732Z — target macos-arm64_

## Headline

**asm.js passes 6276 / 6276 = 100.00% of the run test262 subset**
(selected `language/` + core `built-ins/`), one variant per test.

Of 33776 discovered test files in the selected dirs, 2399 were excluded up front (module=83, unsupported-feature=2316, intl/staging-dir=0); 31377 were eligible (61284 variants); 6276 were actually run (deterministic stride=5; selected variants 12274, notRun 55008).

This is **100% of the executed official stride-5 sample**, not a run of every eligible variant. Tests outside this sample were not scored here.

## Overall breakdown

| class | count | % of run |
|-------|------:|---------:|
| PASS         | 6276 | 100.00 |
| FAIL         | 0 | 0.00 |
| COMPILE_FAIL | 0 | 0.00 |
| CRASH        | 0 | 0.00 |
| **run**      | **6276** | 100 |

## By area

Every executed test in this stride-5 sample passed, so FAIL / COMPILE_FAIL / CRASH are 0 in every scored area. Per-area PASS counts were not re-emitted from this run (`--no-report` acceptance log `/tmp/t262-stride5-z.out`); the headline totals above are authoritative.

## Excluded categories (counted, not scored)

- **module flag** (ES modules as test262 expects): 83
- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): 2316
- **intl402/ + staging/ dirs**: 0

## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)

- none (FAIL=0 COMPILE_FAIL=0 CRASH=0)

## Failures correlated with features (top tags among failing tests)

- none

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

- wall-clock: 1071.8s
- compile-sum (parallel overlap not subtracted): 8180.7s
- run-sum: 341.3s
- cache warm (hit): 0
- cache cold (miss): 6276 (avg 1303.5ms)

_Run wall-clock: 1071.8s._
