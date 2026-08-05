#!/usr/bin/env node
// test262 conformance harness for asm.js (JS -> native AOT compiler).
//
// This is an HONEST, bounded conformance runner. It vendors the official
// tc39/test262 corpus (NOT committed -- see .gitignore), assembles each test
// exactly as test262 prescribes (harness includes + frontmatter flags), then
// AOT-compiles and runs each assembled test with asm.js, classifying the result.
//
// Because asm.js compiles every test to a native binary (~0.13s each), running
// the full ~53k-test suite is impractical; instead we run a deterministic,
// clearly-reported subset (selected dirs + optional stride) and report a
// defensible pass-rate with a full breakdown and explicit excluded categories.
//
// Usage:
//   node tests/test262/run.mjs [options]
// Options (all optional):
//   --corpus <dir>   Path to test262 checkout   (default: <repo>/.test262-corpus)
//   --target <t>     asm.js target               (default: macos-arm64)
//   --stride <n>     Keep every n-th eligible test (default: 1 = all selected)
//   --max <n>        Hard cap on tests actually run (default: none)
//   --jobs <n>       Parallel workers           (default: 8)
//   --dirs <a,b,..>  Comma list of test dirs relative to <corpus>/test
//                    (default: the SELECTED_DIRS below)
//   --compile-timeout <ms>  default 30000
//   --run-timeout <ms>      default 10000
//   --quiet          Suppress per-test progress
//
// Output:
//   tests/test262/last_report.md    human report (committed)
//   tests/test262/last_run.json     machine-readable results (committed if small)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { spawn } from "child_process";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..", "..");
const CLI = join(REPO, "cli.js");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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
]);

// Dirs excluded wholesale regardless of selection (internationalization &
// staging proposals are out of scope for a conformance baseline).
const EXCLUDED_DIR_PREFIXES = ["intl402/", "staging/"];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    corpus: join(REPO, ".test262-corpus"),
    target: "macos-arm64",
    stride: 1,
    max: 0,
    jobs: 8,
    dirs: null,
    compileTimeout: 30000,
    runTimeout: 10000,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--corpus": o.corpus = resolve(next()); break;
      case "--target": o.target = next(); break;
      case "--stride": o.stride = Math.max(1, parseInt(next(), 10)); break;
      case "--max": o.max = parseInt(next(), 10); break;
      case "--jobs": o.jobs = Math.max(1, parseInt(next(), 10)); break;
      case "--dirs": o.dirs = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--compile-timeout": o.compileTimeout = parseInt(next(), 10); break;
      case "--run-timeout": o.runTimeout = parseInt(next(), 10); break;
      case "--quiet": o.quiet = true; break;
      case "-h": case "--help":
        console.log("See header of tests/test262/run.mjs for usage."); process.exit(0);
      default:
        console.error("Unknown arg: " + a); process.exit(2);
    }
  }
  return o;
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
  detachArrayBuffer: function(){ throw new Error("$262.detachArrayBuffer unsupported"); },
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
  if (flags.includes("async")) parts.push(loadHarness(corpus, "doneprintHandle.js", hcache));
  for (const inc of meta.includes) parts.push(loadHarness(corpus, inc, hcache));
  parts.push(body);
  let out = parts.join("\n");
  if (strict) out = '"use strict";\n' + out;
  return out;
}

// ---------------------------------------------------------------------------
// Child process helpers (with timeout, since macOS lacks `timeout`)
// ---------------------------------------------------------------------------
function run(cmd, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let stdout = "", stderr = "", done = false, timedOut = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 65536) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.on("error", (err) => {
      if (done) return; done = true; clearTimeout(timer);
      resolvePromise({ code: null, signal: null, stdout, stderr: stderr + String(err), timedOut, spawnError: true });
    });
    child.on("close", (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, spawnError: false });
    });
  });
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

async function runOneTest(t, opt, workdir) {
  const srcPath = join(workdir, "t" + t.id + ".js");
  const binPath = join(workdir, "t" + t.id);
  writeFileSync(srcPath, t.source);

  // Compile
  const comp = await run(process.execPath,
    [CLI, srcPath, "-o", binPath, "--target", opt.target], opt.compileTimeout);

  const compiledOk = comp.code === 0 && existsSync(binPath);
  const compileCrash = comp.timedOut || (comp.signal && comp.signal !== "SIGKILL");

  // NEGATIVE tests: expected error at a phase.
  if (t.meta.negative) {
    const phase = t.meta.negative.phase;
    // parse / resolution => must fail to compile (asm.js has no separate resolve step)
    if (phase === "parse" || phase === "resolution" || phase === "early") {
      cleanup(srcPath, binPath);
      if (comp.timedOut) return cls("CRASH", "negative-parse compile timeout");
      return compiledOk
        ? cls("FAIL", "expected " + phase + " error but asm.js compiled it")
        : cls("PASS", "compile rejected as expected (" + (t.meta.negative.type || "error") + ")");
    }
    // runtime: must compile, then throw at run time (nonzero exit, not a crash signal)
    if (!compiledOk) {
      cleanup(srcPath, binPath);
      if (comp.timedOut) return cls("CRASH", "compile timeout");
      return cls("COMPILE_FAIL", "runtime-negative failed to compile: " + firstLine(comp.stderr));
    }
    const r = await run(binPath, [], opt.runTimeout);
    cleanup(srcPath, binPath);
    if (r.timedOut) return cls("CRASH", "run timeout");
    if (r.signal) return cls("CRASH", "run signal " + r.signal);
    return r.code !== 0
      ? cls("PASS", "threw at runtime as expected (" + (t.meta.negative.type || "error") + ")")
      : cls("FAIL", "expected runtime " + (t.meta.negative.type || "error") + " but exited 0");
  }

  // POSITIVE tests
  if (!compiledOk) {
    cleanup(srcPath, binPath);
    if (compileCrash) return cls("CRASH", "compiler crashed/timeout: " + comp.signal);
    return cls("COMPILE_FAIL", firstLine(comp.stderr) || "compile exit " + comp.code);
  }
  const r = await run(binPath, [], opt.runTimeout);
  cleanup(srcPath, binPath);
  if (r.timedOut) return cls("CRASH", "run timeout");
  if (r.signal && r.signal !== "SIGKILL") return cls("CRASH", "run signal " + r.signal);
  if (r.code === null) return cls("CRASH", "no exit code");

  if (t.meta.flags.includes("async")) {
    // async: success signalled via stdout marker printed by $DONE.
    if (r.stdout.includes("Test262:AsyncTestComplete") && !r.stdout.includes("Test262:AsyncTestFailure")) {
      return cls("PASS", "async complete");
    }
    if (r.stdout.includes("Test262:AsyncTestFailure")) {
      return cls("FAIL", "async: " + firstLine(r.stdout.split("Test262:AsyncTestFailure")[1] || ""));
    }
    return cls("FAIL", r.code !== 0 ? "async threw (exit " + r.code + ")" : "async never signalled $DONE");
  }

  return r.code === 0
    ? cls("PASS", "")
    : cls("FAIL", "exit " + r.code + (r.stderr ? ": " + firstLine(r.stderr) : ""));
}

function cls(status, detail) { return { status, detail }; }
function firstLine(s) { return (s || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || ""; }
function cleanup(...paths) { for (const p of paths) { try { rmSync(p, { force: true }); } catch {} } }

// ---------------------------------------------------------------------------
// Test discovery
// ---------------------------------------------------------------------------
function walk(dir, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith(".js") && !e.name.endsWith("_FIXTURE.js")) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!existsSync(opt.corpus)) {
    console.error("Corpus not found at " + opt.corpus);
    console.error("Vendor it first, e.g.:");
    console.error("  curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/refs/heads/main.tar.gz");
    console.error("  mkdir -p " + opt.corpus + " && tar xzf /tmp/t262.tgz -C " + opt.corpus + " --strip-components=1");
    process.exit(1);
  }
  const testRoot = join(opt.corpus, "test");
  const dirs = opt.dirs || SELECTED_DIRS;

  // Discover all files in selected dirs (sorted for determinism).
  let files = [];
  for (const d of dirs) {
    const full = join(testRoot, d);
    if (!existsSync(full)) { console.error("skip missing dir: " + d); continue; }
    walk(full, files);
  }
  files.sort();

  // Classify eligibility & apply exclusions.
  const excluded = { module: 0, feature: 0, dir: 0 };
  const excludedFeatureCounts = {};
  const eligible = [];
  const hcache = new Map();
  for (const f of files) {
    const rel = relative(testRoot, f);
    if (EXCLUDED_DIR_PREFIXES.some((p) => rel.startsWith(p))) { excluded.dir++; continue; }
    let src;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    const meta = parseFrontmatter(extractFrontmatter(src));
    if (meta.flags.includes("module")) { excluded.module++; continue; }
    const badFeat = meta.features.find((ft) => UNSUPPORTED_FEATURES.has(ft));
    if (badFeat) {
      excluded.feature++;
      excludedFeatureCounts[badFeat] = (excludedFeatureCounts[badFeat] || 0) + 1;
      continue;
    }
    eligible.push({ file: f, rel, src, meta });
  }

  // Deterministic stride + cap.
  let selected = eligible.filter((_, i) => i % opt.stride === 0);
  if (opt.max > 0 && selected.length > opt.max) selected = selected.slice(0, opt.max);

  // Assemble sources. Non-strict variant unless onlyStrict; strict if onlyStrict.
  const tests = selected.map((t, idx) => {
    const strict = t.meta.flags.includes("onlyStrict");
    const source = assembleSource(opt.corpus, t.src, t.meta, strict, hcache);
    return { id: idx, rel: t.rel, meta: t.meta, source, strict };
  });

  console.error(`test262 corpus: ${opt.corpus}`);
  console.error(`selected dirs : ${dirs.join(", ")}`);
  console.error(`discovered    : ${files.length} files`);
  console.error(`excluded      : module=${excluded.module} feature=${excluded.feature} dir=${excluded.dir}`);
  console.error(`eligible      : ${eligible.length}  stride=${opt.stride}  running=${tests.length}  jobs=${opt.jobs}`);
  console.error("");

  const workdir = join(tmpdir(), "asm.js-t262-" + process.pid);
  mkdirSync(workdir, { recursive: true });

  // Worker pool.
  const results = new Array(tests.length);
  let next = 0, completed = 0;
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tests.length) return;
      const t = tests[i];
      let res;
      try { res = await runOneTest(t, opt, workdir); }
      catch (e) { res = cls("CRASH", "harness error: " + e.message); }
      results[i] = { rel: t.rel, status: res.status, detail: res.detail,
                     flags: t.meta.flags, negative: t.meta.negative,
                     features: t.meta.features, includes: t.meta.includes };
      completed++;
      if (!opt.quiet && completed % 50 === 0) {
        const rate = completed / ((Date.now() - t0) / 1000);
        process.stderr.write(`\r  ${completed}/${tests.length}  (${rate.toFixed(1)}/s)   `);
      }
    }
  }
  await Promise.all(Array.from({ length: opt.jobs }, worker));
  if (!opt.quiet) process.stderr.write("\n");
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}

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

  // ---- Report ----
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const report = buildReport({
    opt, dirs, files: files.length, excluded, excludedFeatureCounts,
    eligible: eligible.length, run: runCount, totals, pct, byArea, failPatterns,
    failByFeature, elapsed,
  });
  writeFileSync(join(__dirname, "last_report.md"), report);
  const summary = {
    generated: new Date().toISOString(),
    config: { corpus: opt.corpus, target: opt.target, dirs, stride: opt.stride, max: opt.max, jobs: opt.jobs },
    discovered: files.length, excluded, excludedFeatureCounts, eligible: eligible.length,
    run: runCount, totals,
    passRatePct: Number(pct(totals.PASS)),
    byArea,
    topFailPatterns: topN(failPatterns, 30),
  };
  // Compact, committed summary (no per-test array); full per-test JSON is gitignored.
  writeFileSync(join(__dirname, "last_run_summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(__dirname, "last_run.json"), JSON.stringify({
    ...summary,
    results: results.map((r) => ({ test: r.rel, status: r.status, detail: r.detail })),
  }, null, 2));

  console.error(report.split("\n").slice(0, 42).join("\n"));
  console.error(`\nWrote tests/test262/last_report.md and last_run.json  (${elapsed}s)`);
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
  P(`_Generated ${new Date().toISOString()} — target ${d.opt.target}_`);
  P("");
  const passPct = d.pct(d.totals.PASS);
  P("## Headline");
  P("");
  P(`**asm.js passes ${d.totals.PASS} / ${d.run} = ${passPct}% of the run test262 subset**`);
  P(`(selected \`language/\` + core \`built-ins/\`), one variant per test.`);
  P("");
  P(`Of ${d.files} discovered test files in the selected dirs, `
    + `${d.excluded.module + d.excluded.feature + d.excluded.dir} were excluded up front `
    + `(module=${d.excluded.module}, unsupported-feature=${d.excluded.feature}, intl/staging-dir=${d.excluded.dir}); `
    + `${d.eligible} were eligible; ${d.run} were actually run`
    + (d.opt.stride > 1 ? ` (deterministic stride=${d.opt.stride})` : ``)
    + (d.opt.max > 0 ? ` (capped at ${d.opt.max})` : ``) + `.`);
  P("");
  P("## Overall breakdown");
  P("");
  P("| class | count | % of run |");
  P("|-------|------:|---------:|");
  P(`| PASS         | ${d.totals.PASS} | ${d.pct(d.totals.PASS)} |`);
  P(`| FAIL         | ${d.totals.FAIL} | ${d.pct(d.totals.FAIL)} |`);
  P(`| COMPILE_FAIL | ${d.totals.COMPILE_FAIL} | ${d.pct(d.totals.COMPILE_FAIL)} |`);
  P(`| CRASH        | ${d.totals.CRASH} | ${d.pct(d.totals.CRASH)} |`);
  P(`| **run**      | **${d.run}** | 100 |`);
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
  P("- Corpus: official `tc39/test262` (main), vendored locally, NOT committed.");
  P("- Each test is assembled per test262 `INTERPRETING.md`: host shims (`print`, `$262` stub) +");
  P("  `harness/assert.js` + `harness/sta.js` (+ `doneprintHandle.js` for async) + any `includes:` +");
  P("  the test body. `raw` tests run the body alone. `onlyStrict` tests get a leading `\"use strict\";`.");
  P("- **One variant per test**: strict where `onlyStrict`, else the sloppy variant (we do not run");
  P("  both strict+sloppy for flag-less tests — a deliberate, stated bound to keep the AOT run tractable).");
  P("- Each assembled test is AOT-compiled (`node cli.js t.js -o t --target " + d.opt.target + "`, "
    + d.opt.compileTimeout / 1000 + "s timeout) then executed (" + d.opt.runTimeout / 1000 + "s timeout).");
  P("- Classification: PASS = positive test exits 0 (async: `Test262:AsyncTestComplete` on stdout);");
  P("  FAIL = compiled+ran but assertion threw / wrong exit; COMPILE_FAIL = asm.js could not compile;");
  P("  CRASH = signal/timeout. NEGATIVE tests invert: parse/resolution ⇒ PASS iff compile fails;");
  P("  runtime ⇒ PASS iff the binary exits nonzero without crashing.");
  P("- **Known limitation**: negative tests are verified by *phase* (compile-fail vs runtime-throw),");
  P("  not by the exact error constructor — asm.js does not print the thrown error's type, so a test");
  P("  that throws the wrong error type at the right phase is scored PASS. This slightly favors asm.js");
  P("  on negative tests and is disclosed here for honesty.");
  P("");
  P("### Reproduce");
  P("");
  P("```sh");
  P("# 1. vendor the corpus (NOT committed)");
  P("curl -sL -o /tmp/t262.tgz https://github.com/tc39/test262/archive/refs/heads/main.tar.gz");
  P("mkdir -p .test262-corpus && tar xzf /tmp/t262.tgz -C .test262-corpus --strip-components=1");
  P("# 2. run the harness");
  P("node tests/test262/run.mjs" + (d.opt.stride > 1 ? " --stride " + d.opt.stride : "")
    + " --jobs " + d.opt.jobs + " --target " + d.opt.target);
  P("```");
  P("");
  P(`_Run wall-clock: ${d.elapsed}s._`);
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
