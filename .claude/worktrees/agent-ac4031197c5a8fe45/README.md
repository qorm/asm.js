# asm.js

> Naming note: the product's official name is **asm.js** (homepage https://asm.js.cn), renamed from the former internal codename "jsbin" at the v0.1 public re-initialization (2026-07-19). Internal identifiers (C API symbols, env vars) uniformly use the `asmjs_*`/`ASMJS_*` prefixes.

[中文版 README](./README.zh-CN.md)

A JavaScript-to-native compiler that translates JavaScript into standalone ARM64/x64 native executables — with **no third-party dependencies and no external interpreter at runtime**.

## Status

A self-hosting, zero-dependency JavaScript→native AOT compiler (5 targets: macOS/Linux arm64+x64, Windows x64). Latest release **v0.2.1** — shape (hidden-class) inline-cache infrastructure (static shape descriptors for object literals and class instances, 16-byte dual-mode property IC sites) and the self-host "layout cliff" root-cause fix (macOS `writeFileSync` missing `O_TRUNC`) — on top of TypedArray constructor globals, compile-time devirtualization of statically-resolvable method calls (self-compile −7.5%), G-M-P N>2 generalized work-stealing + an N-way stop-the-world GC across 3 real threads (linux-arm64), NUL-transparent strings, AES-GCM crypto, the test262 harness, real zlib / TCP, full compiler determinism (`gen1==gen2==gen3`), and full async. See **[CHANGELOG.md](./CHANGELOG.md)** for the full version history.

`asm.js` is **self-hosting on both ARM64 targets — macOS-ARM64 (native) and Linux-ARM64 (Docker)**: on each, the compiler compiles its own source into a native binary, and that binary compiles the compiler again to a **byte-identical** result — a stable self-reproducing fixed point (`gen1 == gen2 == gen3`). The x64 targets (macOS-x64, Linux-x64, Windows-x64) reached this fixed point as of v1.1.0 but currently do **not** hold it: a full self-compile of the CLI on x64 hits a layout-sensitive compilation blocker now under investigation (their cross-compiled outputs still build and run ordinary programs correctly — the five-target platform matrix is green). It supports a substantial ES subset and a limited Node core shim subset; full ECMAScript and full Node.js compatibility are still in progress.

## What Works Today

- **Self-bootstrapping on both ARM64 targets (macOS-ARM64 native, Linux-ARM64 in Docker)**: the compiler compiles its own real CLI (`cli.js`) into a native binary; that binary compiles `cli.js` again, and `gen1 == gen2 == gen3` byte-for-byte (stable fixed point). No third-party libraries, no external interpreter. The x64 targets reached this fixed point at v1.1.0 but currently regress on full self-compilation (layout-sensitive blocker under investigation; ordinary-program correctness on x64 unaffected). See [Self-Hosting](#self-hosting) for details and the per-target history table.
- Modern JavaScript syntax: arrow functions, closures, classes (methods/getters/static), async/await, promises, modules, for-of/for-in, try/catch, BigInt, template literals, destructuring
- ESM import/export flows (validated via in-repo fixtures)
- Node-style builtins: `console`, `process`, `fs` (partial), `path`, `timers` (partial), `os`; plus, all partial subsets, real `crypto` (SHA-1/256/512, HMAC, AES-CBC/CTR/GCM, PBKDF2, HKDF), `zlib` (DEFLATE/gzip), `net`/`http`/`dgram`, `stream`, `child_process`; per-module status: [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md)
- `JSON.stringify`/`JSON.parse` with full arguments (replacer/space/reviver/toJSON; escapes incl. `\uXXXX`→UTF-8, nested structures) — implemented as a compiler-injected pure-JS shim, a mechanism other built-ins reuse
- `instanceof Array/Object`, `Array.isArray`; float printing with correct shortest-form trimming for common values (16th-significant-digit edge cases may differ from V8)
- Generational garbage collector, on by default (sticky mark-bit minor GC + Go-style pacing for full GC: 256 MB nursery, full when heap doubles past live×2; conservative, non-moving). Opt-outs: `GC_FULLONLY=1` (legacy full-only at 4 GB) and `GC_DISABLE=1` at compile time. On the compiler's own self-compile this cuts peak RSS by ~30% for ~5% time
- Native executable output for supported programs

## What Doesn't Work Yet (Known Gaps)

- Full ECMAScript coverage (some syntax/APIs unimplemented; per-version support matrix: [docs/ES_SUPPORT.md](./docs/ES_SUPPORT.md))
- Full Node.js compatibility (partial core shim subset; per-module API status: [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md))
- Performance: generated code has a growing optimization tier (interval linear-scan register allocation on callee-saved regs, self-validating property-site inline caches, inline ToNumber fast path, comparison-branch fusion) — measured 2026-07 vs Node 24 (wall clock, Apple Silicon, outputs byte-identical): numeric loops ~2.7×, property access ~13×, string building ~3×, Map get/set slightly faster than Node. Optimization is ongoing

## Strengths & Limitations

An honest assessment of where this project stands. See [docs/ROADMAP.md](./docs/ROADMAP.md) for how each limitation is planned to be addressed.

### Strengths

- **Single static binary, zero runtime dependencies.** Output is one native executable (Mach-O/ELF/PE) with no interpreter, no VM install, no shared-library requirements — the same deployment model as Go, applied to JavaScript.
- **Proven self-hosting.** The compiler compiles itself to a byte-identical fixed point on both ARM64 targets (the three x64 targets reached it at v1.1.0 and are currently regressed, under investigation). This is a strong, mechanically verifiable correctness claim: every language feature the ~90-module compiler itself uses (closures, classes, ESM modules, Map/Set, string/array workhorses, fs/path shims) is exercised end-to-end on every verification run.
- **Cross-compilation from any host.** Any supported host can emit binaries for all five targets; the backends and binary emitters (including the PE/IAT layer) are part of the single dependency-free codebase.
- **Fast startup, small footprint.** No JIT warm-up, no snapshot loading: `main` starts within milliseconds. A hello-world binary is orders of magnitude smaller than bundling a Node/Electron runtime.
- **Fully auditable stack.** Lexer, parser, compiler, register-level codegen, assemblers, linkers, object-format writers, GC, and the runtime library are all hand-written in this repository — no opaque third-party layer anywhere between `.js` source and executable bytes.
- **AOT-friendly semantics subset.** Programs are closed-world at compile time by default — which is exactly what makes single-binary AOT possible. (`eval`/`new Function` are opt-in: using them embeds the in-process engine library.)

### Limitations

- **A substantial ES subset, not full ECMAScript.** Some built-ins and corner semantics are still incomplete (`Intl`, RegExp `\p{…}`/`v` flag, UTF-16 code-unit string semantics, iterator helpers, built-in subclassing); some constructs compile but behave incorrectly rather than failing loudly (being converted to explicit compile errors). See [docs/ES_SUPPORT.md](./docs/ES_SUPPORT.md).
- **Not Node-compatible yet.** Core-module shims cover a subset (`fs`, `path`, `process`, `console`, `os`, partial others). `node_modules`/`package.json` (`exports`) resolution and an AOT CommonJS `require` subset are in, but real-world npm-package consumption is not yet validated (and cyclic `require` is unsupported). See [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md).
- **Performance is AOT-tier, workload-dependent.** Measured 2026-07 vs Node 24: ~2.7× slower on numeric loops (was ~14× before the 2026-07 optimization pass), ~13× on property-access-heavy code (down from ~32×), ~3× on string building, slightly faster on Map operations. For peak V8-JIT speed on polymorphic property-heavy hot loops this is still the wrong tool; for numeric/CLI/startup-bound workloads the gap has narrowed to small multiples (asm.js starts in ~2 ms vs Node's ~40 ms). Levers applied: interval linear-scan register allocation, property-site inline caches, inline ToNumber fast path, comparison-branch fusion; next: object shapes for the property gap.
- **Memory model is conservative and non-moving.** Generational GC (sticky mark-bit minor + Go-style full pacing, 64 KB size-class spans with an O(1) page map) is the default; still conservative/non-moving with a large virtual reservation, so peak RSS during heavy workloads is higher than mature runtimes (compiler self-compile peaks ~1.4 GB, down from ~2 GB pre-generational).
- **`eval` costs the closed world, no native addons.** Standalone binaries are closed-world by default; N-API/`.node` addons conflict with the single-binary model and are out of scope. Global-scope `eval`/`new Function` do work today via the embedded engine library (route B: programs that use them get the compiler compiled in — see `engine/README.md`); lexical-scope capture and runtime-specifier `import()` are still open (ROADMAP L2c).
- **Pre-production.** No stability guarantees, no semver discipline yet, one primary developer. Test coverage is primarily fixture-based (362/362); a test262 conformance harness is in place — current baseline 1,328 / 6,462 = 20.55% on a stride-5 subset (`language/` + 13 core `built-ins/`, see `tests/test262/last_report.md`) — a low number that is being actively raised.

### Where it fits (and where it doesn't)

| Use case | Fit |
|----------|-----|
| CLI tools distributed as single binaries | ✅ primary target |
| Startup-latency-sensitive short-lived processes | ✅ good fit |
| Embedded JS logic compiled ahead-of-time (planned `--emit lib`) | 🔶 roadmap |
| Long-running compute-heavy servers | ❌ use V8/JSC-based runtimes |
| Running arbitrary npm packages today | ❌ not yet (roadmap N-phases) |
| Dynamic code execution (`eval`) | 🔶 engine-library form only (ROADMAP L2c) |

## Self-Hosting

Self-hosting means the compiler compiles **its own real CLI** (`cli.js`) into a native
executable, and that executable compiles `cli.js` again to a **byte-identical** result.
The bootstrap chain is:

1. **gen1** — Node runs the compiler to compile `cli.js` into a native binary
   (`node cli.js cli.js -o gen1 --target <T>`). This is the only step that uses Node.
2. **gen2** — `gen1` (no Node, no third-party deps) compiles `cli.js` into `gen2`.
3. **gen3** — `gen2` compiles `cli.js` into `gen3`.
4. **Fixed point** — `gen2 == gen3` byte-for-byte: a stable self-reproducing compiler.

`gen1 != gen2` is expected and normal (Node's runtime vs. asm.js's own runtime differ
in a few library corners, ~2.4 MB of the ~11 MB binary); the self-hosting proof is the
`gen2 == gen3` fixed point, reached on both ARM64 targets (the three x64 targets
reached it at v1.1.0 and are currently regressed).

### How each generation is produced

| Gen | Produced by | Command | Runtime used |
|-----|-------------|---------|--------------|
| **gen1** | Node running the compiler source | `node cli.js cli.js -o gen1 --target $T` | Node.js (bootstrap seed only) |
| **gen2** | `gen1` (a native asm.js binary) | `./gen1 cli.js -o gen2 --target $T` | asm.js's own runtime — no Node, no third-party deps |
| **gen3** | `gen2` (a native asm.js binary) | `./gen2 cli.js -o gen3 --target $T` | asm.js's own runtime |

The self-hosting proof is `cmp gen2 gen3` → identical.

### Results (v1.1.0 fixed-point snapshot)

> **Current status (v1.5.x):** the fixed point holds on **macOS-ARM64** (re-verified on every change) and **Linux-ARM64**. The three x64 targets reached it at v1.1.0 but do not currently hold it — a full self-compile of `cli.js` on x64 hits a layout-sensitive compilation blocker (devirtualization is disabled for x64 targets pending its resolution). The byte sizes below are v1.1.0 measurements and will drift. Cross-compilation to all five targets and ordinary-program correctness on x64 remain green (`platform_test.sh`).

Every row below was produced by the three commands above and verified with `cmp`.
Sizes are the exact byte counts of the native `cli.js` compiler on each target,
as measured at the v1.1.0 release (sizes drift with ongoing development; the
macOS-ARM64 fixed point is re-verified on every change, other targets at releases).

| Target | Format | gen1 (Node→native) | gen2 (gen1→native) | gen3 (gen2→native) | `gen2 == gen3` | Verified under |
|--------|--------|-------------------:|-------------------:|-------------------:|:--------------:|----------------|
| macOS-ARM64  | Mach-O arm64  | 12,304,400 | 12,304,400 | 12,304,400 | ✅ | native |
| macOS-x64    | Mach-O x86-64 | 11,051,008 | 11,051,008 | 11,051,008 | ✅ | Rosetta 2 |
| Linux-ARM64  | ELF arm64     | 12,324,361 | 12,324,640 | 12,324,640 | ✅ | Docker `linux/arm64` |
| Linux-x64    | ELF x86-64    | 11,075,035 | 11,075,293 | 11,075,293 | ✅ | Docker `linux/amd64` + Rosetta 2 |
| Windows-x64  | PE32+ x86-64  | 11,071,875 | 11,072,387 | 11,072,387 | ✅ | Wine |

Notes:
- **gen1 ≠ gen2 is expected.** gen1 is emitted while the compiler runs on *Node.js*;
  gen2/gen3 are emitted while it runs on *asm.js's own runtime*. The two runtimes differ
  in a few library corners, so the byte streams differ (and on some targets gen1 is a
  few hundred bytes smaller). The fixed point that proves self-hosting is `gen2 == gen3`.
- Where gen1 and gen2 have the same size (macOS), they still differ in content; the
  size match is incidental.
- Windows additionally exercises PE emission, a kernel32 IAT (`CreateFile`/`ReadFile`/
  `WriteFile`/`CloseHandle`), and `GetCommandLineA`-based `process.argv`.

### Reproduce it

```bash
# Pick your target: macos-arm64 | macos-x64 | linux-arm64 | linux-x64 | windows-x64
T=macos-arm64

# 1) gen1: Node compiles the real CLI (cli.js) into a native binary
node cli.js cli.js -o gen1 --target $T

# 2) gen2: gen1 compiles cli.js (no Node, no third-party deps)
./gen1 cli.js -o gen2 --target $T

# 3) gen3: gen2 compiles cli.js
./gen2 cli.js -o gen3 --target $T

# 4) fixed point
cmp gen2 gen3 && echo "gen2 == gen3 : self-hosting fixed point on $T"
```

For non-native targets, run steps 2–4 under the matching runtime (Docker for Linux,
Rosetta 2 for x64 on Apple Silicon, Wine for Windows). The self-host target is the real
CLI (`cli.js`) compiling itself — there is no separate bootstrap driver.

### Bootstrap engineering notes

ARM64 was the original self-hosting target; extending the fixed point to the x64 and
Windows targets surfaced several backend/runtime bugs that only a full self-compile
(the compiler emitting its own ~11 MB of code) exposes. The load-bearing fixes:

- **x64 internal calling convention (unified to SysV).** The x64 backend originally
  mapped Windows args to the C ABI (`RCX/RDX/R8/R9`), which aliased the `V1–V4` scratch
  registers onto `A0–A3`. Shared runtime helpers whose first instruction is
  `shr V1, A0, 48` then destroyed their own first argument — corrupting string indexing,
  comparison, and case conversion. All targets now use one SysV-style internal
  convention (`A0=RDI … A5=R9`); the Win32 ABI shuffle happens only at the handful of
  kernel32 call sites.
- **x64 label classification.** PLT/absolute-vs-relative detection keyed on
  `target ≥ codeBase`; once a `.text` section grows past ~4 MB the internal labels
  tripped that threshold and resolved as absolute addresses, jumping ~4 MB off target.
- **PE IAT placement.** The import table's RVA was computed from the *pre-fixup*
  (empty) data section; at scale the IAT landed inside the data section and `__imp_*`
  calls jumped into string constants.
- **`path` separator.** The `path` shim used `\` on Windows while the whole codebase
  uses `/` paths, so `dirname("a/b.js")` returned `"."` and deep relative imports broke —
  a full self-compile discovered only 26 of 89 modules and truncated the output to 1 MB.
  Unifying on `/` (which Windows file APIs also accept) fixed module discovery.
- **Windows `process.argv`.** A PE has no CRT, so `argv` had to be built from
  `GetCommandLineA` for the real `cli.js` (which reads its input path from `argv`) to
  bootstrap.
- **Conservative GC & memory layout** (heap growth, object capacity, pointer floors)
  are target-gated so the same source self-hosts across Mach-O / ELF / PE and both
  page-address conventions.

Every non-ARM64 fix is gated by target so the ARM64 outputs stay byte-identical, and all
five targets are re-verified to `gen2 == gen3` after each change.

## Quick Start

```bash
# Compile a JavaScript file to a native executable
node cli.js examples/helloworld.js

# Run test fixtures
node tests/run_fixtures.mjs
```

## Project Structure

```
asm.js/
├── cli.js           # Compiler CLI entry point
├── compiler/        # JavaScript → IR → assembly compiler
├── runtime/         # Runtime shims + GC (console, fs, process, allocator, etc.)
│   └── node/        # Node-style API implementations
├── asm/             # ARM64 and x64 instruction encoding
├── binary/          # Mach-O / ELF / PE object + executable emitters
├── lang/            # Lexer + parser (hand-written, no third-party)
└── tests/
    ├── fixtures/    # Test cases for ES, modules, Node subsets
    └── test262/     # test262 conformance harness + last report
```

## Accurate Messaging

Allowed:
- "self-hosting" / "self-bootstrapping" on ARM64 targets (verified: `gen1 == gen2 == gen3` fixed point; x64 targets reached it at v1.1.0, currently regressed and under investigation)
- "supports a substantial ES subset"
- "includes a limited Node core shim subset"
- "validated through repository fixtures + a verified self-compilation fixed point"
- "test262 conformance harness integrated (first baseline 20.4% of a stride-5 subset, being improved)"

Not (yet) accurate:
- "self-hosting on all five targets" (ARM64 targets only, as of v1.5.x)
- "full ES support"
- "full Node support"
- "drop-in Node replacement"
- "production-ready"

## Acknowledgements

- **[TC39](https://tc39.es/) and [Ecma International](https://ecma-international.org/)** — for creating and maintaining the ECMAScript language specification (ECMA-262). This project implements a subset of the language they have carefully designed and evolved over decades.
- **[The Node.js project](https://nodejs.org/) and the OpenJS Foundation** — for the Node.js runtime and its API design. asm.js's core-module shims (`fs`, `path`, `process`, `console`, …) follow the interfaces pioneered and standardized by Node.js, and Node.js itself powers this compiler's own build-and-bootstrap toolchain (gen0).
- **[QuickJS](https://bellard.org/quickjs/) (Fabrice Bellard and contributors)** — for demonstrating that a small, complete, self-contained JavaScript engine is achievable, and for design ideas that influenced this project's runtime, including NaN-boxing value representation and compact object layouts.
- **[Go](https://go.dev/) (the Go Authors)** — for the compilation model this project aspires to: a self-hosting toolchain that cross-compiles to a single static native executable with no external runtime dependencies, on every supported platform.

asm.js is an independent project and is not affiliated with or endorsed by Ecma International, TC39, the OpenJS Foundation, the Node.js project, the QuickJS project, or the Go project.
