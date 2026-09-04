#!/usr/bin/env node
// Dynamic fragments must use the runtime-owned Object singleton slots.  If
// these references are emitted as fragment-local data, a class created by
// `new Function` gets a second Object/Object.prototype identity and heritage
// links silently diverge from ordinary objects.
import assert from "node:assert/strict";
import { compileFragment, HOST_DATA, SYM_IDS } from "../engine/compile.js";
import { SYM_LATE_LABELS, SYM_NAMES } from "../engine/symbols.js";
import { Compiler } from "../compiler/index.js";

// Exercise the fresh runtime generator as well as the fragment linker.  A
// stale on-disk runtime snapshot could otherwise hide a missing data label or
// symaddr arm in this ABI regression test.
process.env.ASMJS_RUNTIME_SNAPSHOT = "0";

const slots = ["_nsobj_object", "_nsobj_object_proto", "_nsobj_object_ready"];
for (const slot of slots) {
    assert.equal(HOST_DATA[slot], 1, `${slot} must be a host-data relocation`);
    assert.equal(SYM_NAMES.filter((name) => name === slot).length, 1,
        `${slot} must have one append-only ABI entry`);
    assert.equal(typeof SYM_IDS[slot], "number", `${slot} needs a symbol id`);
    assert.ok(SYM_LATE_LABELS.has(slot), `${slot} must be available to symaddr`);
}

for (const target of ["macos-arm64", "linux-x64"]) {
    const fragment = compileFragment("class C extends Object {}", target);
    for (const slot of slots) {
        const id = SYM_IDS[slot];
        assert.ok(fragment.relocs.some((reloc) => reloc.symId === id),
            `${target}: class heritage must relocate ${slot} to the host`);
    }

    const compiler = new Compiler(target);
    compiler.generateEntry();
    compiler.generateRuntime();
    const labels = compiler.asm.dataLabels || [];
    for (const slot of slots) {
        assert.equal(labels.filter((entry) => entry.name === slot).length, 1,
            `${target}: runtime must emit one ${slot} data slot`);
        const id = SYM_IDS[slot];
        assert.ok(compiler.asm.labels.has("_esym_" + (id + 1)),
            `${target}: _engine_symaddr must expose ${slot}`);
    }
}

console.log("Object intrinsic singleton slot relocation: pass");
