#!/usr/bin/env node
// Regression coverage for the append-only engine symbol used by
// Object.getOwnPropertyDescriptors.  Fragment relocations must carry the
// symbol id on both supported native assemblers; otherwise the call can be
// silently assigned another runtime entry after an ABI extension.
import assert from "node:assert/strict";
import { compileFragment, SYM_IDS } from "../engine/compile.js";
import { SYM_NAMES } from "../engine/symbols.js";

const helper = "_object_getOwnPropertyDescriptors";
const helperId = SYM_IDS[helper];

const helperIndex = SYM_NAMES.indexOf(helper);
assert.ok(helperIndex >= 0,
    "the descriptors helper must be present in the ABI");
assert.equal(SYM_NAMES.filter((name) => name === helper).length, 1,
    "the descriptors helper must have one ABI entry");
assert.equal(new Set(SYM_NAMES).size, SYM_NAMES.length,
    "engine symbol names must remain unique");
assert.equal(helperId, helperIndex,
    "SYM_IDS must derive the helper id from its append-only position");

for (const target of ["macos-arm64", "linux-x64"]) {
    const fragment = compileFragment(
        "class C extends Object {} Object.getOwnPropertyDescriptors({ a: 1 });",
        target,
    );
    const helperRelocs = fragment.relocs.filter((reloc) => reloc.symId === helperId);
    assert.ok(
        helperRelocs.length >= 1,
        `${target}: descriptors call must retain its runtime relocation`,
    );
}

console.log("object.getOwnPropertyDescriptors: append-only ABI relocation pass");
