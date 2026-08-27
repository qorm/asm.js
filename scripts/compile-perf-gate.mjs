#!/usr/bin/env node
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const repo = resolve(new URL("..", import.meta.url).pathname);
const runs = Math.max(1, Number(process.env.ASMJS_PERF_RUNS || 3));
const thresholdMs = Number(process.env.ASMJS_PERF_THRESHOLD_MS || 3000);
const samples = [];
const dir = mkdtempSync(join(tmpdir(), "asmjs-perf-gate-"));

try {
    for (let i = 0; i < runs; i++) {
        const started = performance.now();
        const child = spawnSync(process.execPath, [
            join(repo, "cli.js"), join(repo, "cli.js"),
            "-o", join(dir, "cli-" + i), "--target", "macos-arm64",
            "--no-cache", "--no-daemon"
        ], {
            cwd: repo,
            env: { ...process.env, ASMJS_CACHE: "0" },
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    const report = { target: "macos-arm64", runs, thresholdMs, medianMs, samples };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (medianMs > thresholdMs) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
