#!/usr/bin/env node
// Run ONE test262 test through the asm.js pipeline and print full stdout/stderr.
// Usage:
//   node tests/test262/one.mjs <path-in-corpus/test/...>      e.g. built-ins/Array/prototype/sort.js
//   node tests/test262/one.mjs --raw-src <file.js>            compile+run an arbitrary js file
//   --keep   keep the compiled binary & source in /tmp
//   --no-run only compile
//   --strict prepend "use strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { spawn } from "child_process";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { CompilePool } from "./compile-pool.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const CORPUS = join(REPO, ".test262-corpus");

const args = process.argv.slice(2);
let target = "macos-arm64", keep = false, noRun = false, strict = false;
let rel = null, rawSrc = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--keep") keep = true;
  else if (a === "--no-run") noRun = true;
  else if (a === "--strict") strict = true;
  else if (a === "--target") target = args[++i];
  else if (a === "--raw-src") rawSrc = args[++i];
  else rel = a;
}

function extractFrontmatter(src) {
  const start = src.indexOf("/*---");
  if (start < 0) return null;
  const end = src.indexOf("---*/", start);
  if (end < 0) return null;
  return src.slice(start + 5, end);
}
function parseFlowList(s) {
  s = s.trim();
  if (s.startsWith("[")) s = s.slice(1);
  if (s.endsWith("]")) s = s.slice(0, -1);
  return s.split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
function parseFrontmatter(fm) {
  const meta = { flags: [], includes: [], features: [], negative: null };
  if (!fm) return meta;
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (key === "flags" || key === "includes" || key === "features") {
      if (val.startsWith("[")) meta[key] = parseFlowList(val);
      else {
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
      const neg = { phase: null, type: null };
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nm = /^\s+(phase|type):\s*(.+)$/.exec(lines[j]);
        if (!nm) break;
        neg[nm[1]] = nm[2].trim();
      }
      meta.negative = neg;
      i = j - 1;
    }
  }
  return meta;
}

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

let source;
if (rawSrc) {
  source = readFileSync(rawSrc, "utf8");
} else {
  const p = join(CORPUS, "test", rel);
  const body = readFileSync(p, "utf8");
  const meta = parseFrontmatter(extractFrontmatter(body));
  const parts = [];
  if (!meta.flags.includes("raw")) {
    parts.push(HOST_SHIMS);
    parts.push(readFileSync(join(CORPUS, "harness", "assert.js"), "utf8"));
    parts.push(readFileSync(join(CORPUS, "harness", "sta.js"), "utf8"));
    if (meta.flags.includes("async")) {
      parts.push(readFileSync(join(CORPUS, "harness", "doneprintHandle.js"), "utf8"));
      parts.push("globalThis.$DONE = $DONE;\n"); // asyncTest 判 globalThis 自有 $DONE
    }
    for (const inc of meta.includes) parts.push(readFileSync(join(CORPUS, "harness", inc), "utf8"));
  }
  parts.push(body);
  source = parts.join("\n");
  if (strict || meta.flags.includes("onlyStrict")) source = '"use strict";\n' + source;
  console.error("== meta:", JSON.stringify(meta));
}

const dir = keep ? "/tmp/asmjs-one" : join(tmpdir(), "asmjs-one-" + process.pid);
mkdirSync(dir, { recursive: true });
const srcPath = join(dir, "t.js");
const binPath = join(dir, "t");
writeFileSync(srcPath, source);

function run(cmd, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let stdout = "", stderr = "", done = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolvePromise({ code: null, signal: "SIGKILL", stdout, stderr: stderr + "\n[TIMEOUT]", timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (done) return; done = true; clearTimeout(timer);
      resolvePromise({ code: null, signal: null, stdout, stderr: stderr + String(err), timedOut: false });
    });
    child.on("close", (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

const compilePool = new CompilePool({ size: 1, repo: REPO });
let comp;
try {
  await compilePool.start();
  comp = await compilePool.compile({
    sourcePath: srcPath,
    outputPath: binPath,
    target,
    cacheIdentity: rel ? rel + (strict ? "#strict" : "#sloppy") : null,
    timeoutMs: 60000,
  });
} finally {
  await compilePool.close();
}
console.error("== compile: ok=" + comp.ok + " code=" + comp.code + " signal=" + comp.signal +
  " timedOut=" + comp.timedOut + " compileMs=" + comp.compileMs + " cacheHit=" + comp.cacheHit);
if (comp.stderr && String(comp.stderr).trim()) console.error("== compile stderr:\n" + String(comp.stderr).trim());
if (!comp.ok || !existsSync(binPath)) {
  if (!keep) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
console.error("== compiled OK, binary " + binPath);
if (noRun) {
  console.error("--no-run: keeping " + dir);
  process.exit(0);
}
const tRun = Date.now();
const r = await run(binPath, [], 15000);
const runMs = Date.now() - tRun;
console.error("== run: exit=" + r.code + " signal=" + r.signal + " timedOut=" + r.timedOut + " runMs=" + runMs);
console.error("== stdout:\n" + r.stdout);
console.error("== stderr:\n" + r.stderr);
if (!keep) rmSync(dir, { recursive: true, force: true });
else console.error("kept at " + dir);
