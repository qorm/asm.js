#!/usr/bin/env node
/**
 * gen1 冷编门禁：native gen1 编 source，墙钟中位数 ≤ threshold。
 * 默认 source=cli.js、threshold=3000ms；探针可用 ASMJS_PERF_SOURCE=compiler/functions/functions.js。
 *
 * 用法:
 *   ASMJS_GEN1=/tmp/gen1-fast node scripts/gen1-compile-perf-gate.mjs
 *   ASMJS_PERF_THRESHOLD_MS=60000 ASMJS_PERF_SOURCE=compiler/functions/functions.js ...
 */
import { mkdtempSync, rmSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = Math.max(1, Number(process.env.ASMJS_PERF_RUNS || 3));
const thresholdMs = Number(process.env.ASMJS_PERF_THRESHOLD_MS || 3000);
const sourceRel = process.env.ASMJS_PERF_SOURCE || "cli.js";
const source = resolve(repo, sourceRel);
let gen1 = process.env.ASMJS_GEN1 || "/tmp/gen1-fast";
if (!existsSync(gen1)) {
    // 现场用 Node 编一份 gen1
    const build = spawnSync(process.execPath, [
        join(repo, "cli.js"), join(repo, "cli.js"),
        "-o", gen1, "--target", "macos-arm64", "--no-cache", "--no-daemon",
    ], {
        cwd: repo,
        env: { ...process.env, ASMJS_CACHE: "0", ASMJS_RUNTIME_SNAPSHOT: "0" },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
    });
    if (build.status !== 0) {
        process.stderr.write(build.stderr || build.stdout || "gen1 build failed\n");
        process.exit(1);
    }
    chmodSync(gen1, 0o755);
}

const samples = [];
const dir = mkdtempSync(join(tmpdir(), "asmjs-gen1-perf-"));

try {
    for (let i = 0; i < runs; i++) {
        const out = join(dir, "out-" + i);
        const started = performance.now();
        const child = spawnSync(gen1, [
            source, "-o", out, "--target", "macos-arm64",
            "--no-cache", "--no-daemon",
        ], {
            cwd: repo,
            env: { ...process.env, ASMJS_CACHE: "0" },
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
        });
        if (child.status !== 0) {
            process.stderr.write(child.stderr || child.stdout || "compile failed\n");
            process.exit(1);
        }
        samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    const report = {
        host: "gen1",
        gen1,
        source: sourceRel,
        runs,
        thresholdMs,
        medianMs,
        samples,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (medianMs > thresholdMs) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
