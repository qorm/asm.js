#!/usr/bin/env node
// Contract tests for P3.1 raw-float64 local residency analysis.
import assert from "node:assert/strict";
import { parse } from "../lang/parser/index.js";
import { analyzeRawFloatVars } from "../lang/analysis/rawfloat.js";

function fn(src) {
    const prog = parse("function f(){\n" + src + "\n}");
    const d = prog.body[0];
    assert.equal(d.type, "FunctionDeclaration");
    return d;
}

function names(src, boxed) {
    const out = analyzeRawFloatVars(fn(src), boxed || null);
    const keys = [];
    for (const k in out) {
        if (out[k] === true) keys.push(k);
    }
    keys.sort();
    return keys;
}

assert.deepEqual(names("var s = 0; s = s + 1; return s;"), ["s"]);
assert.deepEqual(names("var s = 0; s = s * 2; s = s / 3; s = -s; return s;"), ["s"]);
assert.deepEqual(names("var s = 0; for (var i = 0; i < 10; i++) s = s + i % 7; return s;"), ["i", "s"]);
assert.deepEqual(names("var s = 0; s = 'x'; return s;"), []);
assert.deepEqual(names("var s = 0; s = {valueOf: function(){ return 1; }}; return s - 1;"), []);
assert.deepEqual(names("var s = 0; s += 1; return s;"), []);
assert.deepEqual(names("var s; s = 0; return s;"), []);
assert.deepEqual(names("if (1) { var s = 0; } return s;"), []);
assert.deepEqual(names("var s = 0; s = s + a; return s;"), []);
assert.deepEqual(names("var s = 0; s = s + 1;", new Set(["s"])), []);
assert.deepEqual(names("print(s); var s = 0; return s;"), []);
assert.deepEqual(names("var s = 0; for (s in {a:1}) {} return s;"), []);

const paramFn = parse("function f(a){ var s = 0; s = s + a; return s; }").body[0];
assert.deepEqual(Object.keys(analyzeRawFloatVars(paramFn, null)).sort(), []);

console.log("raw_float_residency: ok");
