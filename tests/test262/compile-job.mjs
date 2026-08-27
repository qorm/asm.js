// In-process compile used by the persistent test262 worker.
//
// Cache API assumptions (cache-core may land separately; this harness must
// not depend on it being present):
//   1. Preferred: `Compiler.compileFile()` returns
//      `{ output, size, cacheHit?: boolean }` (or `cached` / `cache.hit`).
//   2. Optional helper modules (first one that imports successfully wins):
//        engine/compile-cache.js
//        engine/cache.js
//        compiler/cache.js
//        compiler/action-cache.js
//      exporting `lastCacheHit()` / `getLastCacheHit()` / `peekCacheHit()`.
//   3. If neither reports a boolean, `cacheHit` is `null` (unknown). Summaries
//      then count unknown separately instead of inventing warm/cold hits.
//
// Each call constructs a fresh `Compiler` so per-test compiler state cannot
// leak. The worker process loads this module (and thus the compiler graph)
// only once.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { compileBuildJob } from "../../compiler/build/job.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CACHE_HELPER_SPECS = [
  "../../compiler/action-cache.js",
  "../../engine/compile-cache.js",
  "../../engine/cache.js",
  "../../compiler/cache.js",
];

let cacheHitHelper = null;
let cacheHelperTried = false;

export async function loadCacheHitHelper() {
  if (cacheHelperTried) return cacheHitHelper;
  cacheHelperTried = true;
  for (const spec of CACHE_HELPER_SPECS) {
    try {
      const mod = await import(spec);
      const fn =
        (typeof mod.lastCacheHit === "function" && mod.lastCacheHit) ||
        (typeof mod.getLastCacheHit === "function" && mod.getLastCacheHit) ||
        (typeof mod.peekCacheHit === "function" && mod.peekCacheHit) ||
        (mod.default && typeof mod.default.lastCacheHit === "function" &&
          (() => mod.default.lastCacheHit()));
      if (fn) {
        cacheHitHelper = fn;
        return cacheHitHelper;
      }
    } catch {
      // helper not present yet
    }
  }
  return null;
}

export function readCacheHit(compileResult) {
  if (compileResult && typeof compileResult === "object") {
    if (typeof compileResult.cacheHit === "boolean") return compileResult.cacheHit;
    if (typeof compileResult.cached === "boolean") return compileResult.cached;
    if (compileResult.cache && typeof compileResult.cache.hit === "boolean") {
      return compileResult.cache.hit;
    }
  }
  if (typeof cacheHitHelper === "function") {
    try {
      const v = cacheHitHelper(compileResult);
      if (typeof v === "boolean") return v;
    } catch {
      // ignore helper failures; treat as unknown
    }
  }
  return null;
}

export function compileOnce(sourcePath, outputPath, target, cacheIdentity) {
  const t0 = Date.now();
  const result = compileBuildJob({
    repositoryRoot,
    inputFile: sourcePath,
    outputFile: outputPath,
    target,
    outputType: "executable",
    inputIdentity: cacheIdentity,
    // 默认关掉 action-cache:stride 扫每个源都是一次性的,写 ~600KB 产物
    // 只会打满磁盘。要复用同批结果时显式 ASMJS_CACHE=1。
    noCache: process.env.ASMJS_CACHE !== "1",
  });
  return {
    result,
    cacheHit: result.cacheHit,
    compileMs: Date.now() - t0,
  };
}
