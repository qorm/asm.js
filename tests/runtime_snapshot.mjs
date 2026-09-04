#!/usr/bin/env node
// Runtime snapshot ABI regression tests.  A snapshot is restored into a fresh
// compiler (through the disk decoder, not only the in-process Map) and must
// preserve both assembler storage shapes and backend code-generation cursors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compiler } from "../compiler/index.js";
import {
    clearRuntimeSnapshots,
    runtimeSnapshotKey,
    saveRuntimeSnapshot,
} from "../compiler/runtime-snapshot.js";

const root = mkdtempSync(join(tmpdir(), "asmjs-runtime-snapshot-"));
const previousDir = process.env.ASMJS_TOOLCHAIN_DIR;
const previousEnabled = process.env.ASMJS_RUNTIME_SNAPSHOT;
process.env.ASMJS_TOOLCHAIN_DIR = root;
process.env.ASMJS_RUNTIME_SNAPSHOT = "1";

function backendState(backend) {
    const out = {};
    for (const name of ["s5StackOffset", "_fmodSeq", "_cmpFloat", "_pairPush"]) {
        if (Object.prototype.hasOwnProperty.call(backend, name)) out[name] = backend[name];
    }
    return out;
}

try {
    for (const target of ["macos-arm64", "linux-x64", "wasm32-wasi"]) {
        const first = new Compiler(target);
        first.generateEntry();
        first.generateRuntime();
        const expectedBackend = backendState(first.vm.backend);
        let seededOffset = -1;

        // Seed one non-zero ARM64 data byte and re-save the snapshot.  The
        // normal runtime prefix is mostly zero-filled, so this explicitly
        // exercises ByteBuffer -> data.bin serialization rather than merely
        // checking the restored container type.
        if (target === "macos-arm64") {
            seededOffset = first.asm.data.length;
            first.asm.addDataByte(0x5a);
            saveRuntimeSnapshot(first, runtimeSnapshotKey(first));
        }

        // Force the next compiler through meta.json/code.bin/data.bin.  This
        // catches representation bugs hidden by the module-level snapshot Map.
        clearRuntimeSnapshots();
        const second = new Compiler(target);
        second.generateEntry();
        assert.equal(second._runtimeSnapshotRestored, true, `${target}: snapshot must restore`);
        assert.deepEqual(backendState(second.vm.backend), expectedBackend,
            `${target}: backend state must survive snapshot restore`);

        if (target === "macos-arm64") {
            assert.equal(second.asm._byteData, true);
            assert.equal(second.asm.data._asmjsByteBuffer, true,
                "ARM64 data must remain a ByteBuffer after disk restore");
            assert.equal(second.asm.data.get(seededOffset), 0x5a,
                "ARM64 data bytes must survive disk serialization");
            const before = second.asm.data.length;
            second.asm.addDataByte(0x5a);
            assert.equal(second.asm.data.length, before + 1);
            assert.equal(second.asm.data.get(before), 0x5a);
        } else if (target === "wasm32-wasi") {
            assert.ok(Array.isArray(second.asm.data));
            assert.equal(second.asm.data, second.asm.dataSection,
                "wasm dataSection must retain its data alias");
        } else {
            assert.ok(Array.isArray(second.asm.code));
            assert.equal(Object.prototype.hasOwnProperty.call(second.asm, "data"), false,
                "x64 restore must not invent an asm.data property");
        }
    }
    console.log("runtime snapshot: assembler shapes and backend state preserved");
} finally {
    clearRuntimeSnapshots();
    if (previousDir === undefined) delete process.env.ASMJS_TOOLCHAIN_DIR;
    else process.env.ASMJS_TOOLCHAIN_DIR = previousDir;
    if (previousEnabled === undefined) delete process.env.ASMJS_RUNTIME_SNAPSHOT;
    else process.env.ASMJS_RUNTIME_SNAPSHOT = previousEnabled;
    rmSync(root, { recursive: true, force: true });
}
