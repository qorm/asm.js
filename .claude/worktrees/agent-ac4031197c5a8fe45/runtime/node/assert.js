// asm.js Runtime - Node.js assert (basic subset)
// 注:asm.js 里函数无法挂属性,故 assert 以对象形式提供(assert.ok/equal/...);
// 裸 assert(value) 调用形态不支持,用 assert.ok(value)。

function _fail(message) {
    // Node 的断言错误:name="AssertionError" [ERR_ASSERTION]、code="ERR_ASSERTION"
    const err = new Error(message || "Assertion failed");
    err.name = "AssertionError [ERR_ASSERTION]";
    err.code = "ERR_ASSERTION";
    err.generatedMessage = true;
    throw err;
}

function _isObject(v) {
    return v !== null && typeof v === "object";
}

// 编译器缺陷绕过:对**作为函数参数传入**的正则调用 .test 会崩(参数寄存器传递后
// 类型标记丢失,方法派发失败);从 source/flags 重建一个本地正则则派发正常。
function _reTest(regexp, str) {
    const rx = new RegExp(regexp.source, regexp.flags || "");
    return rx.test(str);
}

// 结构化相等(deepEqual 用):数组/普通对象递归,标量用 == / ===
function _deepEqual(a, b, strict) {
    if (strict ? a === b : a == b) return true;
    if (!_isObject(a) || !_isObject(b)) return false;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!_deepEqual(a[i], b[i], strict)) return false;
        }
        return true;
    }
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
        const key = ak[i];
        if (!_deepEqual(a[key], b[key], strict)) return false;
    }
    return true;
}

export function ok(value, message) {
    if (!value) _fail(message || "assert.ok: value is falsy");
}
export function equal(actual, expected, message) {
    if (!(actual == expected)) _fail(message || ("assert.equal: " + actual + " == " + expected));
}
export function notEqual(actual, expected, message) {
    if (actual == expected) _fail(message || ("assert.notEqual: " + actual + " != " + expected));
}
export function strictEqual(actual, expected, message) {
    if (!(actual === expected)) _fail(message || ("assert.strictEqual: " + actual + " === " + expected));
}
export function notStrictEqual(actual, expected, message) {
    if (actual === expected) _fail(message || ("assert.notStrictEqual: " + actual + " !== " + expected));
}
export function deepEqual(actual, expected, message) {
    if (!_deepEqual(actual, expected, false)) _fail(message || "assert.deepEqual failed");
}
export function deepStrictEqual(actual, expected, message) {
    if (!_deepEqual(actual, expected, true)) _fail(message || "assert.deepStrictEqual failed");
}
export function notDeepEqual(actual, expected, message) {
    if (_deepEqual(actual, expected, false)) _fail(message || "assert.notDeepEqual failed");
}
// 校验抛出的错误是否满足 expected(构造函数 / 正则匹配 message / 校验函数 / 具属性对象)
function _matchExpected(e, expected) {
    if (expected === undefined || expected === null) return true;
    if (typeof expected === "function") {
        // 可能是错误构造函数,也可能是校验断言函数。约定:返回真/无异常视为通过。
        if (e instanceof expected) return true;
        const r = expected(e);
        return r === undefined ? true : !!r;
    }
    if (expected instanceof RegExp) {
        return _reTest(expected, e && e.message !== undefined ? String(e.message) : String(e));
    }
    if (_isObject(expected)) {
        const ks = Object.keys(expected);
        for (let i = 0; i < ks.length; i++) {
            if (e[ks[i]] !== expected[ks[i]]) return false;
        }
        return true;
    }
    return true;
}

export function throws(fn, expected, message) {
    let threw = false, caught;
    try { fn(); } catch (e) { threw = true; caught = e; }
    if (!threw) _fail(message || "Missing expected exception.");
    // expected 若为字符串则视作 message(Node 语义)
    if (typeof expected === "string") return;
    if (!_matchExpected(caught, expected)) {
        _fail(message || "The error does not match the expected value.");
    }
}
export function doesNotThrow(fn, expected, message) {
    try { fn(); } catch (e) { _fail(message || ("Got unwanted exception.\n" + (e && e.message))); }
}
export function match(value, regexp, message) {
    if (!(regexp && _reTest(regexp, String(value)))) {
        _fail(message || ("The input did not match the regular expression. Input:\n\n'" + value + "'\n"));
    }
}
export function doesNotMatch(value, regexp, message) {
    if (regexp && _reTest(regexp, String(value))) {
        _fail(message || ("The input was expected to not match the regular expression. Input:\n\n'" + value + "'\n"));
    }
}
export function ifError(value) {
    if (value !== null && value !== undefined) {
        const msg = (value && value.message !== undefined) ? value.message : value;
        _fail("ifError got unwanted exception: " + msg);
    }
}
export function fail(message) {
    _fail(message || "Failed");
}

const assert = {
    ok, equal, notEqual, strictEqual, notStrictEqual,
    deepEqual, deepStrictEqual, notDeepEqual,
    throws, doesNotThrow, match, doesNotMatch, ifError, fail,
};
// assert.strict:equal/notEqual/deepEqual 采用严格语义(Node 的 strict 模式)
assert.strict = {
    ok, strictEqual, notStrictEqual, deepStrictEqual, notDeepEqual,
    throws, doesNotThrow, match, doesNotMatch, ifError, fail,
    equal: strictEqual, notEqual: notStrictEqual,
    deepEqual: deepStrictEqual,
};
assert.strict.strict = assert.strict;

export { assert };
export default assert;
