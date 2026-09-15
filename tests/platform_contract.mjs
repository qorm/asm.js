import assert from "node:assert/strict";
import {
    TARGETS,
    getTargetInfo,
    listTargets,
    resolveTarget,
} from "../compiler/core/platform.js";
import { Compiler } from "../compiler/index.js";
import * as heapTypes from "../runtime/core/types.js";
import {
    TYPE_PROXY,
    TYPE_REGEXP,
    OBJECT_HEADER_SIZE,
    OBJECT_SHAPE_OFFSET,
    ARRAY_HEADER_SIZE,
    ARRAY_DATA_PTR_OFFSET,
} from "../runtime/core/types.js";
import { VReg } from "../vm/registers.js";
import { X64Backend, Reg } from "../backend/x64.js";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseTargets = [
    "macos-arm64",
    "macos-x64",
    "linux-arm64",
    "linux-x64",
    "windows-x64",
];
const aliases = {
    "darwin-arm64": "macos-arm64",
    "darwin-amd64": "macos-x64",
    "macos-amd64": "macos-x64",
    "linux-amd64": "linux-x64",
    "linux-aarch64": "linux-arm64",
    "windows-amd64": "windows-x64",
};

const listedTargets = listTargets();
const listedNames = listedTargets.map((target) => target.name);
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const releaseLoop = releaseWorkflow.match(/for T in ([^;]+); do/);

assert.ok(releaseLoop, "release.yml must declare its target loop");
assert.deepEqual(
    releaseLoop[1].trim().split(/\s+/),
    releaseTargets,
    "the contract test release targets must match release.yml",
);

assert.deepEqual(
    listedTargets.filter((target) => target.release).map((target) => target.name),
    releaseTargets,
    "the release target catalog must match the five release.yml targets",
);
assert.deepEqual(
    listedNames,
    [...releaseTargets, "wasm32-wasi"],
    "only the five release targets and experimental wasm32-wasi may be listed",
);

for (const target of listedTargets) {
    assert.equal(resolveTarget(target.name), target.name);
    assert.equal(getTargetInfo(target.name).name, target.name);
    assert.doesNotThrow(
        () => new Compiler(target.name),
        `listed target must be accepted by Compiler: ${target.name}`,
    );
}

assert.equal(TARGETS["wasm32-wasi"].experimental, true);
assert.equal(listedNames.includes("wasm32-wasi"), true);

for (const [alias, canonical] of Object.entries(aliases)) {
    assert.equal(resolveTarget(alias), canonical, `alias mismatch: ${alias}`);
    assert.equal(getTargetInfo(alias).name, canonical, `alias info mismatch: ${alias}`);
}

assert.throws(
    () => resolveTarget("definitely-unknown"),
    /Unknown target: definitely-unknown/,
);
assert.throws(
    () => new Compiler("definitely-unknown"),
    /Unknown target: definitely-unknown/,
);

const listResult = spawnSync(
    process.execPath,
    ["--no-warnings", join(repoRoot, "cli.js"), "--list-targets"],
    { encoding: "utf8" },
);
assert.equal(listResult.status, 0, listResult.stderr);
assert.equal(listResult.stdout.includes("[object Object]"), false);
for (const target of listedTargets) {
    assert.match(listResult.stdout, new RegExp(target.name));
    assert.match(listResult.stdout, new RegExp(target.desc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const scratchDir = mkdtempSync(join(tmpdir(), "asmjs-platform-contract-"));
const unknownOutput = join(scratchDir, "must-not-exist");
try {
    const unknownResult = spawnSync(
        process.execPath,
        [
            "--no-warnings",
            join(repoRoot, "cli.js"),
            join(repoRoot, "examples", "helloworld.js"),
            "--target",
            "definitely-unknown",
            "-o",
            unknownOutput,
        ],
        { encoding: "utf8" },
    );
    assert.notEqual(unknownResult.status, 0);
    assert.match(unknownResult.stderr + unknownResult.stdout, /Unknown target: definitely-unknown/);
    assert.equal(existsSync(unknownOutput), false, "unknown target must not create an output");
} finally {
    rmSync(scratchDir, { recursive: true, force: true });
}

// ---- 堆 type 字节 / 头布局契约 ----
// Current ABI: TYPE_PROXY shares byte 8 with TYPE_REGEXP (documented debt in
// runtime/core/types.js). Target state is TYPE_PROXY=17 with no collision.
// Contract locks the live values so drift is caught; uniqueness allows only
// this one documented pair.
assert.equal(TYPE_PROXY, 8);
assert.equal(TYPE_REGEXP, 8);
assert.equal(OBJECT_HEADER_SIZE, 56);
assert.equal(OBJECT_SHAPE_OFFSET, 48);
assert.equal(ARRAY_HEADER_SIZE, 32);
assert.equal(ARRAY_DATA_PTR_OFFSET, 24);
{
    const allowedCollisions = new Map([
        [8, new Set(["TYPE_REGEXP", "TYPE_PROXY"])],
    ]);
    const seen = new Map();
    for (const name of Object.keys(heapTypes)) {
        if (!name.startsWith("TYPE_")) continue;
        const value = heapTypes[name];
        if (typeof value !== "number") continue;
        const prev = seen.get(value);
        if (prev !== undefined) {
            const allowed = allowedCollisions.get(value);
            assert.ok(
                allowed && allowed.has(prev) && allowed.has(name),
                `type byte collision: ${prev} and ${name} both ${value}`,
            );
        }
        seen.set(value, name);
    }
}

// ---- x64 V/A 别名硬规（backend/x64.js regMap）----
{
    const x64 = new X64Backend({ code: [], addDataLabel() {}, addDataQword() {} }, "linux");
    assert.equal(x64.regMap[VReg.V0], Reg.RAX);
    assert.equal(x64.regMap[VReg.RET], Reg.RAX);
    assert.equal(x64.regMap[VReg.LR], Reg.RAX);
    assert.equal(x64.regMap[VReg.V1], x64.regMap[VReg.A3]);
    assert.equal(x64.scratchReg(VReg.RET, VReg.V0), Reg.R11);
    assert.equal(x64.scratchReg(VReg.V6), Reg.R10);
    assert.notEqual(x64.scratchReg(VReg.RET), Reg.RAX);
    assert.equal(x64.regMap[VReg.V2], x64.regMap[VReg.A2]);
    assert.equal(x64.regMap[VReg.V3], x64.regMap[VReg.A4]);
    assert.equal(x64.regMap[VReg.V4], x64.regMap[VReg.A5]);
    assert.equal(x64.regMap[VReg.V7], x64.regMap[VReg.A1]);
}

console.log(`platform contract: ${listedTargets.length} targets, ${releaseTargets.length} release targets`);
