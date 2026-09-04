#!/usr/bin/env node
// Regression coverage for readModuleSource's self-host bootstrap gates.
// Toolchain modules must not pull in the runtime eval shim just because their
// comments mention eval(), while ordinary modules still receive the shim when
// they contain a real eval/new Function call.

import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Compiler } from "../compiler/index.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const evalImport = 'import { __eval, __makeFunction, __eval_direct } from "__eval_shim";';
const hasEvalShimImport = (source) => source.split("\n").some((line) => line === evalImport);
const jsonImport = 'import { __JSON_stringify, __JSON_parse } from "__json_shim";';
const hasJsonShimImport = (source) => source.split("\n").some((line) => line === jsonImport);

const compiler = new Compiler("macos-arm64");
const compilerPath = resolve(repoRoot, "compiler/index.js");
const compilerSource = compiler.readModuleSource(compilerPath);
assert.equal(hasEvalShimImport(compilerSource), false,
    "compiler source comments must not inject __eval_shim");
assert.equal(compiler._scriptGlobalMirrorByFile[compilerPath], false,
    "toolchain source must remain module-scoped");

// Keep a real runtime eval site covered: runtime/node/vm.js intentionally sits
// outside the toolchain tree and must retain its shim import.
const vmPath = resolve(repoRoot, "runtime/node/vm.js");
const vmSource = compiler.readModuleSource(vmPath);
assert.equal(hasEvalShimImport(vmSource), true,
    "runtime vm eval must retain __eval_shim injection");
assert.equal(compiler._scriptGlobalMirrorByFile[vmPath], false,
    "runtime vm ESM must not mirror globals");

const scratch = mkdtempSync(join(tmpdir(), "asmjs-source-gates-"));
try {
    const scriptPath = join(scratch, "script.js");
    writeFileSync(scriptPath, 'const value = eval("1 + 1");\n');
    const scriptSource = compiler.readModuleSource(scriptPath);
    assert.equal(hasEvalShimImport(scriptSource), true,
        "ordinary script eval must retain __eval_shim injection");
    assert.equal(compiler._scriptGlobalMirrorByFile[scriptPath], true,
        "ordinary script must mirror top-level globals");

    const esmPath = join(scratch, "module.js");
    writeFileSync(esmPath, "export const value = 1;\n");
    compiler.readModuleSource(esmPath);
    assert.equal(compiler._scriptGlobalMirrorByFile[esmPath], false,
        "ordinary ESM must not mirror top-level globals");

    const cjsPath = join(scratch, "module.cjs");
    writeFileSync(cjsPath, "module.exports = { value: 1 };\n");
    compiler.readModuleSource(cjsPath);
    assert.equal(compiler._scriptGlobalMirrorByFile[cjsPath], false,
        "CommonJS must not mirror top-level globals");

    // Keep the JSON trigger behind a non-ASCII prefix.  Native builds scan
    // raw UTF-8 byte offsets (using fs.__lastReadByteLength), so this catches
    // regressions where a UTF-16 length makes the scanner stop early.
    const jsonPath = join(scratch, "unicode-json.js");
    writeFileSync(jsonPath, "// 中文前缀\nconst value = JSON.stringify({ value: 1 });\n");
    const jsonSource = compiler.readModuleSource(jsonPath);
    assert.equal(hasJsonShimImport(jsonSource), true,
        "JSON shim trigger must survive a non-ASCII source prefix");
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

// Keep this assertion tied to the source under test, rather than silently
// passing if a fixture is moved or replaced.
assert.match(readFileSync(compilerPath, "latin1"), /isToolchainSourcePath/);
console.log("compiler source gates: toolchain skip + eval/module mirror + unicode JSON trigger pass");
