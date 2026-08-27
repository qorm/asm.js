#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = Math.max(1, Number(process.env.ASMJS_BENCH_RUNS || 3));
const target = process.env.ASMJS_BENCH_TARGET || "macos-arm64";
const dir = mkdtempSync(join(tmpdir(), "asmjs-compile-bench-"));

function median(xs) {
    const ys = xs.slice().sort((a, b) => a - b);
    return ys[Math.floor(ys.length / 2)];
}

function percentile(xs, p) {
    const ys = xs.slice().sort((a, b) => a - b);
    return ys[Math.min(ys.length - 1, Math.ceil(ys.length * p) - 1)];
}

function benchmark(name, input) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
        const output = join(dir, `${name}-${i}`);
        const started = performance.now();
        const child = spawnSync(process.execPath, [
            join(repo, "cli.js"), input, "-o", output, "--target", target, "--no-cache", "--no-daemon"
        ], {
            cwd: repo,
            env: { ...process.env, ASMJS_COMPILE_PHASES: "1", ASMJS_CACHE: "0" },
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        const wallMs = performance.now() - started;
        if (child.status !== 0) {
            throw new Error(`${name} failed (${child.status}): ${child.stderr}`);
        }
        const phaseLine = child.stderr.split("\n").find((line) =>
            line.indexOf('"type":"asmjs-compile-phases"') >= 0);
        samples.push({
            wallMs: Math.round(wallMs * 10) / 10,
            phases: phaseLine ? JSON.parse(phaseLine).phases : {}
        });
    }
    return {
        name,
        runs,
        medianMs: median(samples.map((x) => x.wallMs)),
        p95Ms: percentile(samples.map((x) => x.wallMs), 0.95),
        samples
    };
}

try {
    const empty = join(dir, "empty.js");
    writeFileSync(empty, "print(1);\n");
    const medium = join(dir, "medium.js");
    let source = "";
    for (let i = 0; i < 500; i++) source += `function f${i}(x){ return x + ${i}; }\n`;
    source += "print(f499(1));\n";
    writeFileSync(medium, source);

    const report = {
        target,
        generatedAt: new Date().toISOString(),
        results: [
            benchmark("empty", empty),
            benchmark("medium-500-functions", medium),
            benchmark("selfhost-cli", join(repo, "cli.js"))
        ]
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
    rmSync(dir, { recursive: true, force: true });
}
