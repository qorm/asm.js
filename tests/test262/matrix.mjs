#!/usr/bin/env node
// Run the official test262 sample on every runnable release target.
//
// Usage:
//   node tests/test262/matrix.mjs                  # stride 5, gate, all release targets
//   node tests/test262/matrix.mjs --dry-run        # print runner capability only
//   node tests/test262/matrix.mjs --stride 50      # smoke (no official report files)
//   node tests/test262/matrix.mjs --targets macos-x64,linux-arm64
//   node tests/test262/matrix.mjs --require-all    # SKIP counts as failure
//
// Unrunnable targets are SKIP with a reason. They are not scored as 100%.
// --gate (default) requires FAIL=COMPILE_FAIL=CRASH=0 on every target that ran.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_TARGETS, describeRunner, printCapabilityTable } from "./exec-target.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const RUNNER = join(__dirname, "run.mjs");

function parseArgs(argv) {
  const o = {
    stride: 5,
    jobs: 8,
    targets: null,
    dryRun: false,
    gate: true,
    requireAll: false,
    extra: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stride") o.stride = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--jobs") o.jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--targets") o.targets = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--gate") o.gate = true;
    else if (a === "--no-gate") o.gate = false;
    else if (a === "--require-all") o.requireAll = true;
    else if (a === "-h" || a === "--help") {
      console.log("See header of tests/test262/matrix.mjs for usage.");
      process.exit(0);
    } else o.extra.push(a);
  }
  return o;
}

function runNode(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: REPO });
    child.on("error", (err) => {
      resolvePromise({ code: 1, signal: null, error: err });
    });
    child.on("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const targets = opt.targets || RELEASE_TARGETS.slice();
  console.error("test262 matrix runners:");
  printCapabilityTable(process.stderr);
  if (opt.dryRun) return;

  const skipped = [];
  const failed = [];
  const passed = [];
  for (const raw of targets) {
    const cap = describeRunner(raw);
    const t = cap.resolved || raw;
    if (!cap.runnable) {
      console.error("\nSKIP " + t + ": " + cap.reason);
      skipped.push({ t, reason: cap.reason });
      continue;
    }
    console.error("\n=== " + t + " stride=" + opt.stride + " jobs=" + opt.jobs + " mode=" + cap.mode + " ===");
    const args = [
      RUNNER,
      "--target", t,
      "--stride", String(opt.stride),
      "--jobs", String(opt.jobs),
    ];
    if (opt.gate) args.push("--gate");
    // Only the official stride-5 default-dir sample writes last_report-<target>.md.
    if (opt.stride !== 5) args.push("--no-report");
    args.push(...opt.extra);
    const r = await runNode(args);
    if ((r.code || 0) !== 0) {
      failed.push({ t, code: r.code });
      console.error("matrix: " + t + " exited " + r.code);
    } else {
      passed.push(t);
    }
  }

  console.error(
    "\nmatrix PASS=[" + passed.join(",") + "]" +
    " FAIL=[" + failed.map((x) => x.t).join(",") + "]" +
    " SKIP=[" + skipped.map((x) => x.t).join(",") + "]",
  );
  if (failed.length) process.exitCode = 1;
  if (opt.requireAll && skipped.length) {
    console.error("matrix: --require-all and SKIP nonempty");
    process.exitCode = 1;
  }
  if (opt.gate && passed.length === 0 && failed.length === 0) {
    console.error("GATE FAIL: no runnable release target on this host");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
