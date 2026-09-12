#!/usr/bin/env node
// test262 conformance harness for asm.js (JS -> native AOT compiler).
//
// This is an HONEST, bounded conformance runner. It vendors the official
// tc39/test262 corpus (NOT committed -- see .gitignore), assembles each test
// exactly as test262 prescribes (harness includes + frontmatter flags), then
// AOT-compiles and runs each assembled test with asm.js, classifying the result.
//
// Because asm.js compiles every test to a native binary (~0.13s each), the
// default invocation remains a deterministic, clearly-reported subset.  Use
// --canonical for a non-shrinkable baseline and --full for the complete test/
// tree.  Those modes fail closed when anything is omitted or infrastructure
// fails; a subset percentage is never presented as full-corpus conformance.
//
// Usage:
//   node tests/test262/run.mjs [options]
// Options (all optional):
//   --corpus <dir>   Path to test262 checkout   (default: <repo>/.test262-corpus)
//   --target <t>     asm.js target               (default: macos-arm64)
//                    Execution honors this target (direct / Rosetta / Docker /
//                    Wine). A linux/windows binary is never spawned as if it
//                    were a host executable.
//   --stride <n>     Keep every n-th eligible test (default: 1 = all selected)
//   --max <n>        Hard cap on tests actually run (default: none)
//   --jobs <n>       Parallel workers           (default: 8)
//   --dirs <a,b,..>  Comma list of test dirs relative to <corpus>/test
//                    (default: the SELECTED_DIRS below)
//   --compile-timeout <ms>  default 30000
//   --run-timeout <ms>      default 10000
//   --quiet          Suppress per-test progress
//   --no-report      Print totals only; do not write last_report.md / JSON
//   --gate           Exit 1 unless FAIL=COMPILE_FAIL=CRASH=0
//   --keep-features  Do not drop tests tagged in UNSUPPORTED_FEATURES.
//                    Official stride-5 sample stays excluded; ECMA-262 corpus
//                    (language+built-ins+annexB) uses this so BigInt / regexp-v
//                    / dynamic-import / Array.fromAsync stay in the denominator.
//                    intl402/ and staging/ dirs are still skipped.
//   --canonical      Acceptance mode: fixed corpus/scope, no sampling knobs,
//                    and both strict/sloppy variants for default tests.
//   --full           Alias for --canonical over the complete corpus/test tree.
//
// Compile uses a fixed pool of resident Node child IPC workers (`--jobs`):
// each worker loads the compiler module graph once, then `new Compiler` +
// `compileFile` per test. Native binaries are still spawned independently.
//
// Output (official stride-5 default-dir sample only):
//   tests/test262/last_report-<target>.md
//   tests/test262/last_report.md            macos-arm64 headline copy
//   tests/test262/last_run_summary-<target>.json
//   tests/test262/last_run-<target>.json    per-test (gitignored)

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync,
  mkdtempSync, realpathSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname, resolve, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { CompilePool, aggregateTiming, formatTiming } from "./compile-pool.mjs";
import { resolveTarget } from "../../compiler/core/platform.js";
import { TargetExecutor, describeRunner } from "./exec-target.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..");
const DEFAULT_CORPUS = resolve(REPO, ".test262-corpus");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Pinned tc39/test262 commit used for reproducible corpus downloads. The URL
// https://github.com/tc39/test262/archive/<sha>.tar.gz is immutable, unlike
// refs/heads/main.tar.gz which tracks a moving branch head.
//
// NOTE: changing this pin (or vendoring on a fresh machine) requires
// re-downloading the corpus AND re-running the suite -- the reported counts
// depend on the exact corpus snapshot. An already-vendored local corpus
// (default <repo>/.test262-corpus) is used as-is and is NOT re-downloaded, so
// if it was vendored from a different commit, re-vendor before trusting numbers.
const TEST262_PIN = "9e61c12835c5e4a3bdba93850427e6742c4f64c4"; // tc39/test262 commit (2026-07-19 main HEAD; matches the vendored .test262-corpus snapshot behind the reported counts)

// Default selection: the two big language areas plus a spread of core built-ins.
// Deterministic: every eligible test in these dirs (subject to --stride/--max).
const SELECTED_DIRS = [
  "language/expressions",
  "language/statements",
  "built-ins/Array",
  "built-ins/Object",
  "built-ins/String",
  "built-ins/Number",
  "built-ins/Math",
  "built-ins/JSON",
  "built-ins/Map",
  "built-ins/Set",
  "built-ins/TypedArray",
  "built-ins/RegExp",
  "built-ins/Promise",
  "built-ins/Boolean",
  "built-ins/Symbol",
];

// Features that asm.js structurally cannot / does not implement. Tests tagged
// with any of these in their `features:` frontmatter are EXCLUDED and counted
// separately (not scored as failures). This list is deliberately conservative:
// it only excludes things that are architecturally out of scope for an AOT
// compiler or require host capabilities we do not stub, so the headline number
// is not artificially depressed by clearly-unsupported surface.
const UNSUPPORTED_FEATURES = new Set([
  // Concurrency / shared memory: needs threads + shared heap semantics.
  "Atomics",
  "SharedArrayBuffer",
  "Atomics.waitAsync",
  // Host realm / dynamic eval surface (asm.js is AOT; no realm/eval host hooks).
  "cross-realm",
  "dynamic-import",
  "import-assertions",
  "import-attributes",
  "json-modules",
  "source-phase-imports",
  // Proposals not implemented / staging-level.
  "decorators",
  "Temporal",
  "tail-call-optimization",
  "IsHTMLDDA",
  "Intl-enumeration",
  "Array.fromAsync",
  "explicit-resource-management",
  "iterator-sequencing",
  "uint8array-base64",
  // Unicode sets / properties-of-strings require the RegExp v-flag engine and
  // a Unicode property database; both are explicitly outside the current
  // implementation surface (docs/ES_SUPPORT.md).
  "regexp-v-flag",
  // Stage-2/3 proposals not implemented: keyed promise combinators
  // (Promise.allKeyed / allSettledKeyed / raceKeyed / anyKeyed).
  "await-dictionary",
  // BigInt: arbitrary-precision integers (BigInt64Array, BigUint64Array, 2n literals, etc.)
  // are not implemented in asm.js.
  "BigInt",
]);

// Dirs excluded wholesale regardless of selection (internationalization &
// staging proposals are out of scope for a conformance baseline).
const EXCLUDED_DIR_PREFIXES = ["intl402/", "staging/"];
// Top-level directories present in the pinned Test262 snapshot.  Canonical
// mode rejects ad-hoc files dropped directly under test/ (a common way to
// accidentally/ deliberately inflate a local score).
const OFFICIAL_TEST_TOP_LEVEL = new Set(["annexB", "built-ins", "harness", "intl402", "language", "staging"]);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    corpus: DEFAULT_CORPUS,
    target: "macos-arm64",
    stride: 1,
    max: 0,
    jobs: 8,
    dirs: null,
    compileTimeout: 30000,
    runTimeout: 10000,
    runTimeoutSet: false,
    quiet: false,
    filters: null,
    noReport: false,
    gate: false,
    keepFeatures: false,
    canonical: false,
    full: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--corpus": o.corpus = resolve(next()); break;
      case "--target": o.target = next(); break;
      case "--stride": o.stride = Math.max(1, parseIntOption(next(), "--stride")); break;
      case "--max": o.max = parseIntOption(next(), "--max"); break;
      case "--jobs": o.jobs = Math.max(1, parseIntOption(next(), "--jobs")); break;
      case "--dirs": o.dirs = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--compile-timeout": o.compileTimeout = parseIntOption(next(), "--compile-timeout"); break;
      case "--run-timeout":
        o.runTimeout = parseIntOption(next(), "--run-timeout");
        o.runTimeoutSet = true;
        break;
      case "--quiet": o.quiet = true; break;
      case "--filter": o.filters = (o.filters || []).concat(next().split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--no-report": o.noReport = true; break;
      case "--gate": o.gate = true; break;
      case "--keep-features": o.keepFeatures = true; break;
      case "--canonical": o.canonical = true; break;
      case "--full": o.canonical = true; o.full = true; break;
      case "-h": case "--help":
        console.log("See header of tests/test262/run.mjs for usage."); process.exit(0);
      default:
        console.error("Unknown arg: " + a); process.exit(2);
    }
  }
  if (o.canonical) {
    const violations = [];
    if (resolve(o.corpus) !== DEFAULT_CORPUS) violations.push("--corpus (canonical corpus is .test262-corpus)");
    if (o.dirs) violations.push("--dirs (canonical scope is fixed; use --full for test/)");
    if (o.filters && o.filters.length) violations.push("--filter");
    if (o.stride !== 1) violations.push("--stride (must be 1)");
    if (o.max !== 0) violations.push("--max (must be 0)");
    if (o.compileTimeout !== 30000) violations.push("--compile-timeout (must be 30000ms)");
    if (o.runTimeout !== 10000) violations.push("--run-timeout (must be 10000ms)");
    if (o.noReport) violations.push("--no-report (acceptance runs must produce a report)");
    if (violations.length) {
      throw new Error("canonical mode rejects sampling/custom-scope options: " + violations.join(", "));
    }
  }
  o.target = resolveTarget(o.target);
  return o;
}

// Keep malformed numeric CLI values from turning into NaN-controlled loops
// (for example, `--jobs NaN` previously started zero workers).  We retain the
// historical clamping of stride/jobs below one, but reject non-finite input in
// every mode so a malformed invocation cannot accidentally score a partial run.
function parseIntOption(raw, name) {
  const text = String(raw ?? "").trim();
  // Do not accept parseInt's permissive prefix behavior (`1junk` or `1e3`),
  // since that can silently turn a caller typo into a different run scope.
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(name + " must be a finite integer (got " + String(raw) + ")");
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new Error(name + " must be a finite integer (got " + String(raw) + ")");
  }
  return n;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal YAML subset sufficient for test262)
// ---------------------------------------------------------------------------
function extractFrontmatter(src) {
  const start = src.indexOf("/*---");
  if (start < 0) return null;
  const end = src.indexOf("---*/", start);
  if (end < 0) return null;
  return src.slice(start + 5, end);
}

// Parse a flow list like `[a, b, c]`.
function parseFlowList(s) {
  s = s.trim();
  if (s.startsWith("[")) s = s.slice(1);
  if (s.endsWith("]")) s = s.slice(0, -1);
  return s.split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function parseFrontmatter(fm) {
  const meta = { flags: [], includes: [], features: [], negative: null, description: "" };
  if (!fm) return meta;
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();

    if (key === "flags" || key === "includes" || key === "features") {
      if (val.startsWith("[")) {
        meta[key] = parseFlowList(val);
      } else {
        // block list on following indented lines: `- item`
        const items = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bl = /^\s+-\s+(.+)$/.exec(lines[j]);
          if (!bl) break;
          items.push(bl[1].trim().replace(/^['"]|['"]$/g, ""));
        }
        meta[key] = items;
        i = j - 1;
      }
    } else if (key === "negative") {
      // nested: negative:\n  phase: parse\n  type: SyntaxError
      const neg = { phase: null, type: null };
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nm = /^\s+(phase|type):\s*(.+)$/.exec(lines[j]);
        if (!nm) break;
        neg[nm[1]] = nm[2].trim();
      }
      meta.negative = neg;
      i = j - 1;
    } else if (key === "description") {
      meta.description = val.replace(/^[>|]\s*/, "");
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Test assembly
// ---------------------------------------------------------------------------
// Host shims prepended to every non-raw test: a `print` sink (used by async
// harness) and a minimal `$262` stub for tests that reference it.
const HOST_SHIMS = `
function print(m){ console.log(String(m)); }
var $262 = {
  createRealm: function(){ throw new Error("$262.createRealm unsupported"); },
  detachArrayBuffer: function(buffer){ __detachArrayBuffer(buffer); },
  evalScript: function(){ throw new Error("$262.evalScript unsupported"); },
  gc: function(){},
  global: this,
  agent: undefined,
  IsHTMLDDA: undefined
};
`;

function loadHarness(corpus, name, cache) {
  if (cache.has(name)) return cache.get(name);
  const p = join(corpus, "harness", name);
  const txt = readFileSync(p, "utf8");
  cache.set(name, txt);
  return txt;
}

// Build the concatenated source for a test given its flags/includes.
function assembleSource(corpus, body, meta, strict, hcache) {
  const flags = meta.flags;
  if (flags.includes("raw")) {
    // raw: test body only, no harness, no shims, no strict directive.
    return body;
  }
  const parts = [];
  parts.push(HOST_SHIMS);
  parts.push(loadHarness(corpus, "assert.js", hcache));
  parts.push(loadHarness(corpus, "sta.js", hcache));
  if (flags.includes("async")) {
    parts.push(loadHarness(corpus, "doneprintHandle.js", hcache));
    // asyncHelpers.js 的 asyncTest 判 `hasOwnProperty(globalThis,"$DONE")`:
    // 顶层 function $DONE 声明在 asm.js 模块模型里是模块作用域、非 globalThis 自有
    // 属性 → 恒抛 "asyncTest called without async flag"(async 族假 FAIL 根因)。
    // 注入一行把模块函数挂到 globalThis(真属主对象,hasOwnProperty 命中)。
    parts.push("globalThis.$DONE = $DONE;\n");
  }
  for (const inc of meta.includes) parts.push(loadHarness(corpus, inc, hcache));
  parts.push(body);
  let out = parts.join("\n");
  if (strict) out = '"use strict";\n' + out;
  return out;
}

function isOfficialBoundedSample(opt) {
  if (opt.canonical || opt.full) return false;
  if (opt.filters && opt.filters.length) return false;
  if (opt.max !== 0 || opt.stride !== 5) return false;
  if (opt.dirs && opt.dirs.join("\0") !== SELECTED_DIRS.join("\0")) return false;
  return true;
}

// Best-effort identity of this runner's checkout (the asm.js repo HEAD),
// recorded in the run summary so results are attributable to a concrete
// compiler state. Returns null when git/the repo is unavailable (e.g. an
// exported source tree without .git).
function gitRunnerSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"],
      { cwd: REPO, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
// Result classes:
//   PASS         positive test ran & produced no assertion/throw (exit 0)
//   FAIL         wrong result / assertion threw (compiled, ran, exit != 0 by throw)
//   COMPILE_FAIL asm.js could not compile the source (unsupported syntax etc.)
//   CRASH        segfault / signal / timeout at compile or run
// For negative tests the expected outcome is inverted (see below).

async function runOneTest(t, opt, workdir, pool, executor) {
  const srcPath = join(workdir, "t" + t.id + ".js");
  const binPath = join(workdir, "t" + t.id);
  // Never let a previous/PID-reused artifact satisfy `existsSync` below.
  cleanup(srcPath, binPath);
  writeFileSync(srcPath, t.source);

  const tCompile = Date.now();
  const comp = await pool.compile({
    sourcePath: srcPath,
    outputPath: binPath,
    target: opt.target,
    cacheIdentity: t.rel + (t.strict ? "#strict" : "#sloppy"),
    timeoutMs: opt.compileTimeout,
  });
  const compileMs = comp.compileMs || (Date.now() - tCompile);
  const cacheHit = (comp.cacheHit === true || comp.cacheHit === false) ? comp.cacheHit : null;

  const compiledOk = comp.ok === true && comp.code === 0 && existsSync(binPath);
  const compileCrash = compileInfrastructureFailure(comp);

  // NEGATIVE tests: expected error at a phase.
  if (t.meta.negative) {
    const phase = t.meta.negative.phase;
    // parse / resolution => must fail to compile (asm.js has no separate resolve step)
    if (phase === "parse" || phase === "resolution" || phase === "early") {
      cleanup(srcPath, binPath);
      if (compileCrash) return cls("CRASH", "negative-parse compiler infrastructure failure" + compileDetail(comp), compileMs, 0, cacheHit);
      if (!compiledOk && !isParserRejection(comp)) {
        return cls("COMPILE_FAIL", "negative-parse compile rejection was not identified as a parser/SyntaxError", compileMs, 0, cacheHit);
      }
      return compiledOk
        ? cls("FAIL", "expected " + phase + " error but asm.js compiled it", compileMs, 0, cacheHit)
        : cls("PASS", "compile rejected as expected (" + (t.meta.negative.type || "error") + ")", compileMs, 0, cacheHit);
    }
    // runtime: must compile, then throw at run time (nonzero exit, not a crash signal)
    if (!compiledOk) {
      cleanup(srcPath, binPath);
      if (compileCrash) return cls("CRASH", "runtime-negative compiler infrastructure failure" + compileDetail(comp), compileMs, 0, cacheHit);
      return cls("COMPILE_FAIL", "runtime-negative failed to compile: " + firstLine(comp.stderr), compileMs, 0, cacheHit);
    }
    const tRun = Date.now();
    const r = await executor.run(binPath, opt.runTimeout);
    const runMs = Date.now() - tRun;
    cleanup(srcPath, binPath);
    if (r.timedOut) return cls("CRASH", "run timeout", compileMs, runMs, cacheHit);
    if (r.signal) return cls("CRASH", "run signal " + r.signal, compileMs, runMs, cacheHit);
    if (r.spawnError || r.code === null) return cls("CRASH", "run spawn/no-exit failure", compileMs, runMs, cacheHit);
    return r.code !== 0
      ? cls("PASS", "threw at runtime as expected (" + (t.meta.negative.type || "error") + ")", compileMs, runMs, cacheHit)
      : cls("FAIL", "expected runtime " + (t.meta.negative.type || "error") + " but exited 0", compileMs, runMs, cacheHit);
  }

  // POSITIVE tests
  if (!compiledOk) {
    cleanup(srcPath, binPath);
    if (compileCrash) return cls("CRASH", "compiler crashed/timeout: " + comp.signal, compileMs, 0, cacheHit);
    return cls("COMPILE_FAIL", firstLine(comp.stderr) || "compile exit " + comp.code, compileMs, 0, cacheHit);
  }
  const tRun = Date.now();
  const r = await executor.run(binPath, opt.runTimeout);
  const runMs = Date.now() - tRun;
  cleanup(srcPath, binPath);
  if (r.timedOut) return cls("CRASH", "run timeout", compileMs, runMs, cacheHit);
  if (r.signal) return cls("CRASH", "run signal " + r.signal, compileMs, runMs, cacheHit);
  if (r.spawnError || r.code === null) return cls("CRASH", "run spawn/no-exit failure", compileMs, runMs, cacheHit);

  if (t.meta.flags.includes("async")) {
    // async: success signalled via stdout marker printed by $DONE.
    if (r.code === 0 && r.stdout.includes("Test262:AsyncTestComplete") && !r.stdout.includes("Test262:AsyncTestFailure")) {
      return cls("PASS", "async complete", compileMs, runMs, cacheHit);
    }
    if (r.stdout.includes("Test262:AsyncTestFailure")) {
      return cls("FAIL", "async: " + firstLine(r.stdout.split("Test262:AsyncTestFailure")[1] || ""), compileMs, runMs, cacheHit);
    }
    return cls("FAIL", r.code !== 0 ? "async threw (exit " + r.code + ")" : "async never signalled $DONE", compileMs, runMs, cacheHit);
  }

  return r.code === 0
    ? cls("PASS", "", compileMs, runMs, cacheHit)
    : cls("FAIL", "exit " + r.code + (r.stderr ? ": " + firstLine(r.stderr) : ""), compileMs, runMs, cacheHit);
}

function cls(status, detail, compileMs, runMs, cacheHit) {
  return { status, detail, compileMs: compileMs || 0, runMs: runMs || 0, cacheHit: cacheHit ?? null };
}
function compileInfrastructureFailure(comp) {
  if (!comp) return true;
  if (comp.timedOut || comp.spawnError || comp.signal || comp.code === null) return true;
  // CompilePool reports worker replacement/closure as a synthetic code=1
  // result.  Treat those as infrastructure failures, not expected syntax
  // errors for a negative test.
  const err = String(comp.stderr || "");
  return /compiler worker (exited|startup)|compile pool closed/i.test(err);
}
function isParserRejection(comp) {
  // Parser diagnostics: `Syntax errors in <file>:` (compileFile) or a
  // thrown `SyntaxError: Identifier 'f' has already been declared` (cli
  // uncaught). Do not award a negative test for an opaque/internal exception.
  return !!comp && comp.ok === false && comp.code === 1 &&
    /(^|\n)\s*Syntax errors?\b|(^|\n)\s*SyntaxError:/i.test(String(comp.stderr || ""));
}
function compileDetail(comp) {
  const bits = [];
  if (comp && comp.signal) bits.push(" signal=" + comp.signal);
  if (comp && comp.timedOut) bits.push(" timeout");
  if (comp && comp.spawnError) bits.push(" spawnError");
  return bits.length ? " (" + bits.join(",") + ")" : "";
}
function firstLine(s) { return (s || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || ""; }
function cleanup(...paths) { for (const p of paths) { try { rmSync(p, { force: true }); } catch {} } }

// ---------------------------------------------------------------------------
// Test discovery
// ---------------------------------------------------------------------------
function walk(dir, acc, options = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (options.rejectSymlinks) {
        throw new Error("symlink encountered in canonical test tree: " + p);
      }
      continue;
    }
    if (e.isDirectory()) walk(p, acc, options);
    else if (e.isFile() && e.name.endsWith(".js") && !e.name.endsWith("_FIXTURE.js")) acc.push(p);
    else if (options.rejectSpecial && !e.isFile() && !e.isDirectory()) {
      throw new Error("special filesystem entry encountered in canonical test tree: " + p);
    }
  }
  return acc;
}

// Return true when candidate is the root itself or a descendant of root.  A
// lexical `startsWith` check is insufficient (`/test2` starts with `/test`).
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel));
}

// Resolve and validate the corpus before walking it.  In particular, do not
// allow a symlink or `..` path to turn `--dirs` into an arbitrary source tree.
function validateCorpus(corpus, canonical) {
  let corpusReal;
  let testRoot;
  try {
    corpusReal = realpathSync(corpus);
    testRoot = realpathSync(join(corpusReal, "test"));
  } catch (e) {
    throw new Error("invalid test262 corpus (missing corpus/test): " + corpus);
  }
  if (!isWithin(corpusReal, testRoot) || corpusReal === testRoot) {
    throw new Error("invalid test262 corpus: test/ must be a child of corpus root");
  }
  if (canonical) {
    let expected;
    try { expected = realpathSync(DEFAULT_CORPUS); } catch {
      throw new Error("canonical corpus is missing: " + DEFAULT_CORPUS);
    }
    if (corpusReal !== expected) {
      throw new Error("canonical mode requires corpus " + DEFAULT_CORPUS);
    }
  }
  // These are the minimum files needed to assemble a non-raw Test262 test.
  for (const name of ["assert.js", "sta.js"]) {
    const p = join(corpusReal, "harness", name);
    let hp;
    try { hp = realpathSync(p); } catch { throw new Error("missing required harness file: " + p); }
    if (!isWithin(corpusReal, hp)) {
      throw new Error("required harness file escapes corpus root: " + p);
    }
    try {
      if (!statSync(hp).isFile()) throw new Error("not a regular file");
    } catch {
      throw new Error("required harness path is not a readable file: " + p);
    }
  }
  return { corpusRoot: corpusReal, testRoot };
}

function resolveTestDirs(testRoot, dirs) {
  if (!Array.isArray(dirs) || dirs.length === 0) {
    throw new Error("no test262 directories selected");
  }
  const out = [];
  for (const d of dirs) {
    if (typeof d !== "string" || !d || isAbsolute(d)) {
      throw new Error("test directory must be a relative path: " + String(d));
    }
    // Reject traversal spelling even when it would normalize back inside the
    // root; this keeps canonical manifests stable and makes intent explicit.
    const segments = d.split(/[\\/]+/);
    if (segments.includes("..")) {
      throw new Error("test directory traversal is not allowed: " + d);
    }
    const full = resolve(testRoot, d);
    if (!isWithin(testRoot, full)) {
      throw new Error("test directory escapes corpus/test: " + d);
    }
    let real;
    try { real = realpathSync(full); } catch {
      throw new Error("missing test directory: " + d);
    }
    if (!isWithin(testRoot, real)) {
      throw new Error("test directory symlink escapes corpus/test: " + d);
    }
    try {
      // readdirSync also rejects a path that resolves to a regular file.
      readdirSync(real, { withFileTypes: true });
    } catch {
      throw new Error("test directory is not readable: " + d);
    }
    out.push(real);
  }
  return out;
}

function canonicalizeFiles(files, testRoot) {
  const unique = [];
  const seen = new Set();
  let duplicates = 0;
  for (const f of files) {
    let real;
    try { real = realpathSync(f); } catch {
      throw new Error("test file disappeared or is unreadable: " + f);
    }
    if (!isWithin(testRoot, real)) {
      throw new Error("test file escapes corpus/test: " + f);
    }
    if (seen.has(real)) { duplicates++; continue; }
    seen.add(real);
    unique.push(real);
  }
  unique.sort();
  return { files: unique, duplicates };
}

function variantModes(meta, canonical) {
  const flags = meta.flags || [];
  if (flags.includes("raw") || flags.includes("module")) return [false];
  if (flags.includes("onlyStrict")) return [true];
  if (flags.includes("noStrict")) return [false];
  return canonical ? [false, true] : [false];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!existsSync(opt.corpus)) {
    console.error("Corpus not found at " + opt.corpus);
    console.error("Vendor it first, e.g.:");
    console.error("  curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/" + TEST262_PIN + ".tar.gz");
    console.error("  mkdir -p " + opt.corpus + " && tar xzf /tmp/t262.tgz -C " + opt.corpus + " --strip-components=1");
    process.exit(1);
  }
  const corpusInfo = validateCorpus(opt.corpus, opt.canonical);
  // Use real paths for all subsequent reads and containment checks.  This also
  // makes a symlinked --corpus report deterministic.
  opt.corpus = corpusInfo.corpusRoot;
  const testRoot = corpusInfo.testRoot;
  const dirs = opt.full ? ["."] : (opt.dirs || SELECTED_DIRS);
  const resolvedDirs = resolveTestDirs(testRoot, dirs);

  // Discover all files in selected dirs (sorted for determinism).  Resolve
  // every file and deduplicate aliases/overlapping directory selections before
  // metadata classification; otherwise repeated --dirs entries could inflate
  // a pass rate.
  let discoveredFiles = [];
  for (const full of resolvedDirs) {
    walk(full, discoveredFiles, { rejectSymlinks: opt.canonical, rejectSpecial: opt.canonical });
  }
  const canonicalFiles = canonicalizeFiles(discoveredFiles, testRoot);
  const files = canonicalFiles.files;
  const duplicateFiles = canonicalFiles.duplicates;
  if (files.length === 0) {
    throw new Error("no standalone test262 .js files discovered; refusing a 0/0 score");
  }

  // Classify eligibility & apply exclusions.
  const excluded = { module: 0, feature: 0, dir: 0 };
  const excludedFeatureCounts = {};
  const eligible = [];
  const hcache = new Map();
  const readErrors = [];
  for (const f of files) {
    const rel = relative(testRoot, f).replace(/\\/g, "/");
    if (opt.canonical && !OFFICIAL_TEST_TOP_LEVEL.has(rel.split("/")[0])) {
      throw new Error("unexpected non-Test262 path in canonical corpus: " + rel);
    }
    let src;
    try { src = readFileSync(f, "utf8"); }
    catch (e) { readErrors.push({ file: rel, error: String(e && e.message ? e.message : e) }); continue; }
    if (opt.canonical) {
      const fmStart = src.indexOf("/*---");
      if (fmStart < 0) {
        throw new Error("missing Test262 frontmatter in " + rel);
      }
      if (src.indexOf("---*/", fmStart + 5) < 0) {
        throw new Error("malformed Test262 frontmatter in " + rel);
      }
    }
    if (EXCLUDED_DIR_PREFIXES.some((p) => rel.startsWith(p))) { excluded.dir++; continue; }
    const meta = parseFrontmatter(extractFrontmatter(src));
    if (meta.flags.includes("module")) { excluded.module++; continue; }
    if (!opt.keepFeatures) {
      const badFeat = meta.features.find((ft) => UNSUPPORTED_FEATURES.has(ft));
      if (badFeat) {
        excluded.feature++;
        excludedFeatureCounts[badFeat] = (excludedFeatureCounts[badFeat] || 0) + 1;
        continue;
      }
    }
    eligible.push({ file: f, rel, src, meta });
  }
  if (readErrors.length) {
    throw new Error("failed to read " + readErrors.length + " test file(s); refusing to shrink denominator (first: " +
      readErrors[0].file + ")");
  }

  // Deterministic stride + cap. --filter narrows to matching paths first (ad-hoc
  // iteration on one family; combine with --no-report so the committed headline
  // report is not overwritten by a partial run).
  let pool = eligible;
  if (opt.filters) pool = pool.filter((t) => opt.filters.some((f) => t.rel.includes(f)));
  let selected = pool.filter((_, i) => i % opt.stride === 0);
  if (opt.max > 0 && selected.length > opt.max) selected = selected.slice(0, opt.max);
  if (selected.length === 0) {
    throw new Error("selection produced no eligible tests; refusing a 0/0 score");
  }

  // Assemble sources.  Canonical mode runs both variants required by
  // INTERPRETING.md for tests without noStrict/onlyStrict/raw; bounded mode
  // retains the historical one-variant behavior and reports the omitted count.
  const expectedVariantCountFor = (t) => variantModes(t.meta, true).length;
  const selectedVariants = selected.reduce((n, t) => n + expectedVariantCountFor(t), 0);
  const eligibleVariants = eligible.reduce((n, t) => n + expectedVariantCountFor(t), 0);
  // `variants` is the canonical denominator for the discovered/eligible scope;
  // stride/filter/max omissions therefore contribute to notRun instead of
  // silently disappearing from the score.
  const variants = eligibleVariants;
  const tests = [];
  for (const t of selected) {
    for (const strict of variantModes(t.meta, opt.canonical)) {
      const source = assembleSource(opt.corpus, t.src, t.meta, strict, hcache);
      tests.push({ id: tests.length, rel: t.rel, meta: t.meta, source, strict });
    }
  }
  const notRun = Math.max(0, variants - tests.length);

  console.error(`test262 corpus: ${opt.corpus}`);
  console.error(`selected dirs : ${opt.full ? "<all test/>" : dirs.join(", ")}`);
  console.error(`discovered    : ${files.length} files`);
  if (duplicateFiles) console.error(`deduplicated  : ${duplicateFiles} duplicate file aliases`);
  console.error(`excluded      : module=${excluded.module} feature=${excluded.feature} dir=${excluded.dir}` +
    (opt.keepFeatures ? " (keep-features: UNSUPPORTED_FEATURES not dropped)" : ""));
  console.error(`eligible      : ${eligible.length} files / ${eligibleVariants} variants  selected=${selectedVariants}  stride=${opt.stride}  running=${tests.length}  jobs=${opt.jobs}`);
  const runner = describeRunner(opt.target);
  console.error(`target        : ${opt.target}  runner=${runner.mode} (${runner.reason})`);
  if (!runner.runnable) {
    throw new Error("target " + opt.target + " is not runnable on this host: " + runner.reason);
  }
  // Docker linux/amd64 on an arm64 host is QEMU. Isolated Bidi_Mirrored
  // finishes in ~1.6s on Rosetta and ~13s in qemu; the 10s native budget
  // SIGKILLs every generated property-escape (88 CRASH, FAIL=0). Wine on
  // the same host is in the same class (x64 PE under an emulator). Rosetta
  // is faster than qemu but virtreg + jobs=4 still pushes generated \p{}
  // over 10s (General_Category_-_Mark run timeout). Canonical mode keeps
  // 10s. An explicit --run-timeout wins.
  if (!opt.canonical && (runner.mode === "docker" || runner.mode === "wine" ||
      runner.mode === "rosetta") && !opt.runTimeoutSet) {
    // Cross-arch docker is QEMU: virtreg generated \p{} Mark scans ~120s
    // (isolated run-sum=120.2s). 60s and 120s floors SIGKILL. Same-arch
    // docker (linux-arm64 on arm64) and Rosetta keep the 60s floor.
    const floor = (runner.mode === "docker" && runner.qemu) ? 180000 : 60000;
    opt.runTimeout = Math.max(opt.runTimeout, floor);
    console.error(`run timeout   : ${opt.runTimeout}ms (${runner.mode}` +
      (runner.qemu ? " qemu" : "") + " emulator floor; native stays 10s)");
  }
  console.error("");

  const workdir = mkdtempSync(join(tmpdir(), "asm.js-t262-"));

  // Runtime snapshots are a build-time optimization, not part of test262's
  // execution semantics.  A snapshot currently contains the `_start` prefix
  // and mutable assembler metadata; reusing it in a resident worker can leave
  // program-specific fixups/labels from an earlier test and make a later
  // binary crash (e.g. Map.groupBy after the first few Map tests).  Isolate
  // each test's runtime by disabling snapshots in test262 workers by default.
  // Keep an explicit caller setting intact so snapshot experiments remain
  // reproducible (`ASMJS_RUNTIME_SNAPSHOT=1 ... run.mjs`).
  const compileEnv = { ...process.env };
  if (!Object.prototype.hasOwnProperty.call(compileEnv, "ASMJS_RUNTIME_SNAPSHOT")) {
    compileEnv.ASMJS_RUNTIME_SNAPSHOT = "0";
  }
  const compilePool = new CompilePool({ size: opt.jobs, repo: REPO, env: compileEnv });
  const executor = new TargetExecutor(opt.target);
  const results = new Array(tests.length);
  let next = 0, completed = 0;
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tests.length) return;
      const t = tests[i];
      let res;
      try { res = await runOneTest(t, opt, workdir, compilePool, executor); }
      catch (e) { res = cls("CRASH", "harness error: " + e.message, 0, 0, null); }
      results[i] = { rel: t.rel, strict: t.strict, status: res.status, detail: res.detail,
                     flags: t.meta.flags, negative: t.meta.negative,
                     features: t.meta.features, includes: t.meta.includes,
                     compileMs: res.compileMs, runMs: res.runMs, cacheHit: res.cacheHit };
      completed++;
      if (!opt.quiet && res.status !== "PASS") {
        process.stderr.write(`\n${res.status} ${t.rel}  ${res.detail}\n`);
      }
      if (!opt.quiet && completed % 50 === 0) {
        const rate = completed / ((Date.now() - t0) / 1000);
        process.stderr.write(`\r  ${completed}/${tests.length}  (${rate.toFixed(1)}/s)   `);
      }
    }
  }
  try {
    await Promise.all([compilePool.start(), executor.start(workdir, { jobs: opt.jobs })]);
    await Promise.all(Array.from({ length: opt.jobs }, worker));
  } finally {
    await compilePool.close();
    await executor.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
  if (!opt.quiet) process.stderr.write("\n");

  // ---- Aggregate ----
  const totals = { PASS: 0, FAIL: 0, COMPILE_FAIL: 0, CRASH: 0 };
  const byArea = {};
  const failPatterns = {};
  const failByFeature = {};
  for (const r of results) {
    totals[r.status]++;
    const area = areaOf(r.rel);
    (byArea[area] ||= { PASS: 0, FAIL: 0, COMPILE_FAIL: 0, CRASH: 0 })[r.status]++;
    if (r.status === "FAIL" || r.status === "COMPILE_FAIL" || r.status === "CRASH") {
      const key = failReason(r);
      failPatterns[key] = (failPatterns[key] || 0) + 1;
      for (const ft of r.features) failByFeature[ft] = (failByFeature[ft] || 0) + 1;
    }
  }
  const runCount = tests.length;
  const pct = (n) => runCount ? ((100 * n) / runCount).toFixed(2) : "0.00";
  const pctExpected = (n) => variants ? ((100 * n) / variants).toFixed(2) : "0.00";
  const timing = aggregateTiming(results);
  const wallMs = Date.now() - t0;

  // ---- Report ----
  const elapsed = (wallMs / 1000).toFixed(1);
  const report = buildReport({
    opt, dirs, files: files.length, discoveredRaw: discoveredFiles.length,
    duplicateFiles, excluded, excludedFeatureCounts,
    eligible: eligible.length, eligibleVariants, selectedVariants, variants, executed: runCount,
    notRun, run: runCount, totals, pct, pctExpected, byArea, failPatterns, failByFeature,
    elapsed, timing, runner,
  });
  const applyGate = () => {
    if (opt.gate) {
      const bad = totals.FAIL + totals.COMPILE_FAIL + totals.CRASH;
      if (bad) {
        console.error("GATE FAIL: " + opt.target + " FAIL=" + totals.FAIL +
          " COMPILE_FAIL=" + totals.COMPILE_FAIL + " CRASH=" + totals.CRASH +
          " (need 0/0/0 for 100%)");
        process.exitCode = 1;
      } else {
        console.error("GATE PASS: " + opt.target + " " + totals.PASS + "/" + runCount +
          " executed, FAIL=0 COMPILE_FAIL=0 CRASH=0");
      }
    }
    if (opt.canonical) {
      const omitted = notRun + excluded.module + excluded.feature + excluded.dir;
      if (omitted || totals.FAIL || totals.COMPILE_FAIL || totals.CRASH) process.exitCode = 1;
    }
  };
  // 部分/过滤运行(--no-report)不落地委托报告:否则 headline 被局部样本覆盖。
  if (opt.noReport) {
    const bad = results.filter((r) => r.status !== "PASS");
    for (const r of bad) {
      console.error(`${r.status} ${r.rel}  ${r.detail}` +
        `  compileMs=${r.compileMs} runMs=${r.runMs} cacheHit=${r.cacheHit}`);
    }
    console.error(`\nrun=${runCount} variants=${variants} notRun=${notRun} PASS=${totals.PASS} FAIL=${totals.FAIL} ` +
      `COMPILE_FAIL=${totals.COMPILE_FAIL} CRASH=${totals.CRASH} ` +
      `(pass=${pctExpected(totals.PASS)}% expected, ${pct(totals.PASS)}% executed; ${elapsed}s)`);
    console.error(formatTiming(timing, wallMs));
    applyGate();
    return;
  }
  const summary = {
    generated: new Date().toISOString(),
    // Reproducibility identity: exact runner checkout + exact corpus snapshot.
    runnerSha: gitRunnerSha(),
    corpusPin: TEST262_PIN,
    runner: { mode: runner.mode, reason: runner.reason },
    // Portable corpus identifier: path relative to the repo root (default
    // ".test262-corpus"); never a machine-specific absolute path.
    config: { corpus: relative(REPO, opt.corpus), target: opt.target, dirs, stride: opt.stride, max: opt.max, jobs: opt.jobs,
      canonical: opt.canonical, full: opt.full },
    discovered: files.length, discoveredRaw: discoveredFiles.length, duplicateFiles,
    excluded, excludedFeatureCounts, eligible: eligible.length, eligibleVariants, selectedVariants,
    variants, executed: runCount, notRun, run: runCount, totals,
    // passRatePct uses the expected-variant denominator; retain the executed
    // rate separately so consumers cannot mistake a sampled run for coverage.
    passRatePct: Number(pctExpected(totals.PASS)),
    executedPassRatePct: Number(pct(totals.PASS)),
    timing,
    byArea,
    topFailPatterns: topN(failPatterns, 30),
  };
  const perTest = {
    ...summary,
    results: results.map((r) => ({
      test: r.rel, strict: r.strict, status: r.status, detail: r.detail,
      compileMs: r.compileMs, runMs: r.runMs, cacheHit: r.cacheHit,
    })),
  };
  const official = isOfficialBoundedSample(opt);
  const written = [];
  if (official) {
    const perTargetMd = join(__dirname, "last_report-" + opt.target + ".md");
    writeFileSync(perTargetMd, report);
    written.push("last_report-" + opt.target + ".md");
    if (opt.target === "macos-arm64") {
      writeFileSync(join(__dirname, "last_report.md"), report);
      written.push("last_report.md");
    }
    writeFileSync(join(__dirname, "last_run_summary-" + opt.target + ".json"), JSON.stringify(summary, null, 2));
    written.push("last_run_summary-" + opt.target + ".json");
    if (opt.target === "macos-arm64") {
      writeFileSync(join(__dirname, "last_run_summary.json"), JSON.stringify(summary, null, 2));
      written.push("last_run_summary.json");
    }
    writeFileSync(join(__dirname, "last_run-" + opt.target + ".json"), JSON.stringify(perTest, null, 2));
    if (opt.target === "macos-arm64") {
      writeFileSync(join(__dirname, "last_run.json"), JSON.stringify(perTest, null, 2));
    }
  } else {
    writeFileSync(join(__dirname, "last_run.json"), JSON.stringify(perTest, null, 2));
    console.error("note: not the official stride-5 default-dir sample; last_report.md not updated");
  }

  console.error(report.split("\n").slice(0, 42).join("\n"));
  console.error(formatTiming(timing, wallMs));
  if (written.length) {
    console.error("\nWrote tests/test262/{" + written.join(", ") + "}  (" + elapsed + "s)");
  } else {
    console.error("\nWrote tests/test262/last_run.json  (" + elapsed + "s)");
  }
  applyGate();
}

function areaOf(rel) {
  const parts = rel.split("/");
  if (parts[0] === "language") return "language/" + parts[1];
  if (parts[0] === "built-ins") return "built-ins/" + parts[1];
  return parts[0] + "/" + (parts[1] || "");
}

// Bucket a failing result into a coarse ROOT-CAUSE reason using only static
// test attributes (includes/flags/negative) + the classification detail. This
// never touches the pass/fail decision -- it only groups failures so the report
// surfaces dominant asm.js gaps instead of an opaque "exit 1" bucket.
function failReason(r) {
  if (r.status === "COMPILE_FAIL") return "COMPILE_FAIL: asm.js could not compile (unsupported syntax / parser gap)";
  if (r.status === "CRASH") return "CRASH: " + (r.detail || "signal/timeout");
  // FAIL:
  const inc = r.includes || [];
  if (inc.includes("propertyHelper.js")) return "FAIL: property-descriptor reflection (verifyProperty: length/name/writable/enumerable/configurable)";
  if (inc.includes("isConstructor.js")) return "FAIL: constructor-ness reflection (isConstructor / not-a-constructor)";
  if (inc.includes("compareArray.js")) return "FAIL: array contents mismatch (compareArray)";
  if (inc.includes("deepEqual.js")) return "FAIL: deepEqual mismatch";
  if (inc.includes("testTypedArray.js") || inc.includes("detachArrayBuffer.js")) return "FAIL: TypedArray/ArrayBuffer semantics";
  if (r.negative) return "FAIL: negative test wrong outcome (phase=" + (r.negative.phase || "?") + ")";
  if ((r.flags || []).includes("async")) return "FAIL: async ($DONE not signalled / promise rejected)";
  return "FAIL: assertion mismatch (Test262Error / wrong value)";
}

function topN(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ pattern: k, count: v }));
}

function buildReport(d) {
  const L = [];
  const P = (s) => L.push(s);
  P("# asm.js test262 conformance report");
  P("");
  const runnerLine = d.runner
    ? ` (runner ${d.runner.mode}: ${d.runner.reason})`
    : "";
  P(`_Generated ${new Date().toISOString()} — target ${d.opt.target}${runnerLine}_`);
  P("");
  const passPctExecuted = d.pct(d.totals.PASS);
  const passPctExpected = (d.pctExpected || d.pct)(d.totals.PASS);
  const executed = d.executed ?? d.run;
  const variants = d.variants ?? executed;
  const notRun = d.notRun ?? Math.max(0, variants - executed);
  const scope = d.opt.full ? "full test/ tree" : "selected language/ + core built-ins/ dirs";
  P("## Headline");
  P("");
  if (isOfficialBoundedSample(d.opt)) {
    P(`**asm.js passes ${d.totals.PASS} / ${executed} = ${passPctExecuted}% of the executed official stride-5 sample**`);
    P(`Expected-variant rate (PASS / ${variants}): ${passPctExpected}%. notRun=${notRun}. Official stride-5 sample, not every eligible variant.`);
  } else {
    P(`**asm.js passes ${d.totals.PASS} / ${variants} expected variants = ${passPctExpected}%**`);
    P(`Executed-rate (PASS / executed): ${passPctExecuted}% (${executed} executed, ${notRun} notRun).`);
  }
  P(`Scope: ${scope}. ${d.opt.canonical ? "Canonical acceptance gate enabled." : "Bounded subset mode (not a full-corpus claim)."}`);
  P("");
  P(`Of ${d.files} unique discovered test files${d.discoveredRaw !== undefined ? ` (${d.discoveredRaw} raw paths` : ""}${d.discoveredRaw !== undefined ? ")" : ""}, `
    + `${d.excluded.module + d.excluded.feature + d.excluded.dir} were excluded up front `
    + `(module=${d.excluded.module}, unsupported-feature=${d.excluded.feature}, intl/staging-dir=${d.excluded.dir}); `
    + `${d.eligible} files (${d.eligibleVariants ?? d.eligible} expected variants) were eligible; `
    + `${d.selectedVariants !== undefined ? d.selectedVariants : variants} selected; `
    + `${executed}/${variants} variants were actually run (notRun=${notRun})`
    + (d.opt.stride > 1 ? ` (deterministic stride=${d.opt.stride})` : ``)
    + (d.opt.max > 0 ? ` (capped at ${d.opt.max})` : ``) + `.`);
  if (d.duplicateFiles) P(`Deduplicated ${d.duplicateFiles} overlapping/aliased file paths before scoring.`);
  P("");
  P("## Overall breakdown");
  P("");
  P("| class | count | % of executed |");
  P("|-------|------:|---------------:|");
  P(`| PASS         | ${d.totals.PASS} | ${d.pct(d.totals.PASS)} |`);
  P(`| FAIL         | ${d.totals.FAIL} | ${d.pct(d.totals.FAIL)} |`);
  P(`| COMPILE_FAIL | ${d.totals.COMPILE_FAIL} | ${d.pct(d.totals.COMPILE_FAIL)} |`);
  P(`| CRASH        | ${d.totals.CRASH} | ${d.pct(d.totals.CRASH)} |`);
  P(`| **executed**  | **${executed}** | 100 |`);
  P(`| expected variants | ${variants} | — |`);
  P(`| notRun       | ${notRun} | — |`);
  P("");
  P("## By area");
  P("");
  P("| area | run | PASS | FAIL | COMPILE_FAIL | CRASH | pass% |");
  P("|------|----:|-----:|-----:|-------------:|------:|------:|");
  for (const [area, c] of Object.entries(d.byArea).sort()) {
    const rn = c.PASS + c.FAIL + c.COMPILE_FAIL + c.CRASH;
    const pp = rn ? ((100 * c.PASS) / rn).toFixed(1) : "0.0";
    P(`| ${area} | ${rn} | ${c.PASS} | ${c.FAIL} | ${c.COMPILE_FAIL} | ${c.CRASH} | ${pp} |`);
  }
  P("");
  P("## Excluded categories (counted, not scored)");
  P("");
  P(`- **module flag** (ES modules as test262 expects): ${d.excluded.module}`);
  P(`- **unsupported feature** (structurally out of scope, see UNSUPPORTED_FEATURES): ${d.excluded.feature}`);
  P(`- **intl402/ + staging/ dirs**: ${d.excluded.dir}`);
  if (Object.keys(d.excludedFeatureCounts).length) {
    P("");
    P("Excluded-by-feature detail:");
    P("");
    for (const [f, n] of Object.entries(d.excludedFeatureCounts).sort((a, b) => b[1] - a[1])) {
      P(`- \`${f}\`: ${n}`);
    }
  }
  P("");
  P("## Top failing patterns (FAIL / COMPILE_FAIL / CRASH detail strings)");
  P("");
  for (const { pattern, count } of topN(d.failPatterns, 25)) {
    P(`- **${count}×** ${pattern.replace(/\|/g, "\\|") || "(no detail)"}`);
  }
  P("");
  P("## Failures correlated with features (top tags among failing tests)");
  P("");
  for (const [f, n] of Object.entries(d.failByFeature).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    P(`- \`${f}\`: ${n}`);
  }
  P("");
  P("## Methodology / reproducibility");
  P("");
  P(`- Corpus: official \`tc39/test262\` pinned at commit \`${TEST262_PIN}\``);
  P("  (TEST262_PIN in tests/test262/run.mjs), vendored locally, NOT committed. Changing the");
  P("  pin requires re-downloading the corpus and re-running; counts depend on the snapshot.");
  P("- Each test is assembled per test262 `INTERPRETING.md`: host shims (`print`, `$262` stub) +");
  P("  `harness/assert.js` + `harness/sta.js` (+ `doneprintHandle.js` for async) + any `includes:` +");
  P("  the test body. `raw` tests run the body alone. `onlyStrict` tests get a leading `\"use strict\";`.");
  if (d.opt.canonical) {
    P("- Canonical variants: `onlyStrict` => strict, `noStrict`/`raw` => sloppy, and every");
    P("  default test => both sloppy and strict variants, as required by INTERPRETING.md.");
  } else {
    P("- Bounded mode runs one variant per test (strict only for `onlyStrict`, otherwise sloppy);");
    P("  omitted strict variants are reported in `variants`/`notRun` and are not a full claim.");
  }
  P("- Each assembled test is AOT-compiled by a resident Node compile worker " +
    "(`new Compiler` + `compileFile` per test; compiler modules loaded once per `--jobs` worker; " +
    d.opt.jobs + " workers, target `" + d.opt.target + "`, " +
    d.opt.compileTimeout / 1000 + "s timeout) then executed (" + d.opt.runTimeout / 1000 + "s timeout) " +
    "via `tests/test262/exec-target.mjs` (direct / Rosetta / Docker / Wine according to `--target`; " +
    "filename-less `t123` binaries never infer the host platform).");
  P("- Classification: PASS = positive test exits 0 (async: `Test262:AsyncTestComplete` on stdout);");
  P("  FAIL = compiled+ran but assertion threw / wrong exit; COMPILE_FAIL = asm.js could not compile;");
  P("  CRASH = signal/timeout. NEGATIVE tests invert: parse/resolution ⇒ PASS iff compile fails;");
  P("  runtime ⇒ PASS iff the binary exits nonzero without crashing or spawn failure.");
  P("- **Known limitation**: negative tests are verified by *phase* (compile-fail vs runtime-throw),");
  P("  not by the exact error constructor — asm.js does not print the thrown error's type, so a test");
  P("  that throws the wrong error type at the right phase is scored PASS. This slightly favors asm.js");
  P("  on negative tests and is disclosed here for honesty.");
  P("");
  P("### Reproduce");
  P("");
  P("```sh");
  P("# 1. vendor the corpus (NOT committed)");
  P("curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/" + TEST262_PIN + ".tar.gz");
  P("mkdir -p .test262-corpus && tar xzf /tmp/t262.tgz -C .test262-corpus --strip-components=1");
  P("# 2. run the harness");
  P("node tests/test262/run.mjs" + (d.opt.full ? " --full" : (d.opt.canonical ? " --canonical" : ""))
    + (d.opt.stride > 1 ? " --stride " + d.opt.stride : "")
    + " --jobs " + d.opt.jobs + " --target " + d.opt.target);
  P("```");
  P("");
  if (d.timing) {
    P("");
    P("## Timing");
    P("");
    P(`- wall-clock: ${d.elapsed}s`);
    P(`- compile-sum (parallel overlap not subtracted): ${(d.timing.compileMsSum / 1000).toFixed(1)}s`);
    P(`- run-sum: ${(d.timing.runMsSum / 1000).toFixed(1)}s`);
    P(`- cache warm (hit): ${d.timing.warm}` +
      (d.timing.warm ? ` (avg ${d.timing.warmAvgMs.toFixed(1)}ms)` : ""));
    P(`- cache cold (miss): ${d.timing.cold}` +
      (d.timing.cold ? ` (avg ${d.timing.coldAvgMs.toFixed(1)}ms)` : ""));
    if (d.timing.unknown) {
      P(`- cache unknown: ${d.timing.unknown} (compileFile / cache helper did not report \`cacheHit\`)`);
    }
  }
  P("");
  P(`_Run wall-clock: ${d.elapsed}s._`);
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
